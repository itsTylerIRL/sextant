// Sextant — a live map of the Urbit network. Talks to the %sextant agent's JSON API.
//
// One continuous chart. Ships are placed by who sponsors them *now*:
//   the 256 galaxies sit on one Archimedean spiral;
//   each galaxy owns a disc, and the stars it currently sponsors sit on a
//   spiral inside that disc, joined to it by spokes;
//   each star owns a smaller disc holding the planets it currently sponsors.
// Zooming reveals each level. Galaxies and stars come from /api/tree at load;
// a star's planets load from /api/residents only once you zoom in close.
const API = '/apps/sextant/api';
const $ = (id) => document.getElementById(id);
const TAU = Math.PI * 2;
const RENDER_CAP = 600;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let me = null;
let myChain = new Set();

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function get(path) {
  const r = await fetch(API + path, { credentials: 'include' });
  if (r.status === 403) { location.href = '/~/login?redirect=' + encodeURIComponent(location.pathname + location.hash); throw new Error('login'); }
  if (!r.ok) throw new Error(r.status + ' ' + path);
  return r.json();
}
const cache = new Map();
async function cget(path, ttl = 60000) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const v = await get(path);
  cache.set(path, { t: Date.now(), v });
  return v;
}

function ago(ms) {
  if (!ms) return '—';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return Math.round(s) + 's ago';
  if (s < 5400) return Math.round(s / 60) + 'm ago';
  if (s < 129600) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}
const dot = (st) => `<i class="dot ${st || 'none'}" title="${esc(st || 'never contacted')}"></i>`;
const statusText = (st) => ({ live: 'online', dead: 'offline', unborn: 'pending', stale: 'not heard from lately', null: 'never contacted' }[st] ?? 'never contacted');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------------------------------------------------------------- classes

function cls(s) {
  if (s.status === 'live') return 'live';
  if (s.status === 'dead') return 'dead';
  if (s.status === 'unborn') return 'unborn';
  if (s.status === 'stale') return 'stale';
  if (s.life === 0) return 'cold';
  return 'keyed';
}
const isPal = (s) => !!(s.target || s.leech);
const CLASSES = [
  ['live', 'online'], ['dead', 'offline'], ['stale', 'not heard lately'], ['unborn', 'pending'],
  ['keyed', 'booted, not contacted'], ['cold', 'spawned, never booted'], ['pal', '%pals'], ['peer', 'peers'],
];
const SIZE = { cold: 0.7, keyed: 0.9, stale: 0.95, unborn: 1, dead: 1, live: 1.15 };

let P = {};
function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (k) => cs.getPropertyValue('--' + k).trim();
  P = {
    bg: v('sky-bg'), ring: v('sky-ring'), slot: v('sky-slot'), dust: v('sky-dust'),
    keyed: v('sky-keyed'), cold: v('sky-cold'), live: v('live'), dead: v('dead'),
    unborn: v('unborn'), stale: v('stale'), accent: v('accent'), ink: v('ink'), muted: v('muted'),
  };
}

// a star's parent galaxy is its last syllable: ~lorfus → ~fus
const GALAXY_BY_SUFFIX = new Map();
function hash8(star) {
  if (!GALAXY_BY_SUFFIX.size && T0) T0.forEach((r, i) => GALAXY_BY_SUFFIX.set(r[0].slice(1), i));
  return GALAXY_BY_SUFFIX.get(star.slice(-3));
}
let T0 = null;

function hash(n) {
  n = (n ^ 61) ^ (n >>> 16); n = (n + (n << 3)) | 0; n ^= n >>> 4;
  n = Math.imul(n, 0x27d4eb2d); n ^= n >>> 15;
  return (n >>> 0) / 4294967296;
}

// ---------------------------------------------------------------- geometry

// Every level uses the same Archimedean spiral, r = b·θ, with points at equal
// arc length. The gap between turns (g) is a fixed multiple (q) of the gap
// between neighbours along the curve (d = g/q), so each point is the same
// distance from the ones beside it and from the turns inside and outside.
// g is solved so N points exactly fill the annulus from r0 to 1:
//   N·d·g = π(1 − r0²)  ⇒  g = √(q·π·(1 − r0²) / N)
const spirals = new Map();
function spiral(N, q, r0) {
  N = Math.max(1, N);
  const key = N + '|' + q + '|' + r0;
  if (spirals.has(key)) return spirals.get(key);
  const g = Math.min(0.7, Math.sqrt((q * Math.PI * (1 - r0 * r0)) / N));
  const b = g / TAU, d = g / q;
  const s0 = (r0 * r0) / (2 * b); // arc length (≈ bθ²/2) at r = r0
  const pos = new Float64Array(N * 2);
  for (let k = 0; k < N; k++) {
    const th = Math.sqrt((2 * (s0 + k * d)) / b), r = b * th, a = th - Math.PI / 2;
    pos[2 * k] = r * Math.cos(a); pos[2 * k + 1] = r * Math.sin(a);
  }
  const sp = { pos, d };
  spirals.set(key, sp);
  return sp;
}
// a child disc's radius is just under half the spacing, so discs never touch
const DISC = 0.46;
const SP = { galaxy: [1.7, 0.16], inGalaxy: [3, 0.22], inStar: [3, 0.22] };

// Children wind into their host on several arms: two, three or four
// Archimedean arms offset by 2π/m, each point at equal arc length along its
// arm. Each arm's pitch is m·g so neighbouring arms are still g apart, and
// the same area rule fills the disc exactly. Fewer than seven children are
// spread evenly on one circle around the host instead.
const arms = (N) => (N < 30 ? 2 : N < 100 ? 3 : 4);
const layouts = new Map();
function armLayout(N, q, r0) {
  N = Math.max(1, N);
  const key = N + '|' + q + '|' + r0;
  if (layouts.has(key)) return layouts.get(key);
  const pos = new Float64Array(N * 2);
  let out;
  if (N < 12) {
    const R = 0.62;
    for (let i = 0; i < N; i++) { const a = -Math.PI / 2 + (i * TAU) / N; pos[2 * i] = R * Math.cos(a); pos[2 * i + 1] = R * Math.sin(a); }
    out = { pos, d: N === 1 ? 0.5 : Math.min(0.5, 2 * R * Math.sin(Math.PI / N)), m: 0, ring: R };
  } else {
    const m = arms(N);
    const g = Math.min(0.7, Math.sqrt((q * Math.PI * (1 - r0 * r0)) / N));
    const b = (m * g) / TAU, d = g / q, s0 = (r0 * r0) / (2 * b);
    for (let i = 0; i < N; i++) {
      const j = i % m, k = Math.floor(i / m);
      const th = Math.sqrt((2 * (s0 + k * d)) / b), r = b * th, a = th + (j * TAU) / m - Math.PI / 2;
      pos[2 * i] = r * Math.cos(a); pos[2 * i + 1] = r * Math.sin(a);
    }
    out = { pos, d, m };
  }
  layouts.set(key, out);
  return out;
}

// ---------------------------------------------------------------- the tree

const ST = [null, 'live', 'dead', 'unborn', 'stale'];
let T = null; // { gals, byName, guide }

function buildTree(raw, at = Date.now()) {
  T0 = raw.g; GALAXY_BY_SUFFIX.clear();
  const byName = new Map();
  const gals = raw.g.map((r, i) => ({
    ship: r[0], kind: 'galaxy', idx: i, status: ST[r[1]], life: r[2] < 0 ? null : r[2],
    target: !!(r[3] & 1), leech: !!(r[3] & 2), ns: r[4], np: r[5], kids: [], allStars: [], allPlanets: [], parentNode: null,
  }));
  for (const r of raw.s) {
    const g = gals[r[1]];
    g.allStars.push({ ship: r[0], kind: 'star', idx: r[2], status: ST[r[3]], life: r[4] < 0 ? null : r[4],
      target: !!(r[5] & 1), leech: !!(r[5] & 2), n: r[6], escape: r[7] || null, kids: [], allPlanets: [], parentNode: g,
      origin: gals[hash8(r[0])]?.ship });
  }
  const G = spiral(256, ...SP.galaxy);
  for (const g of gals) {
    g.x = G.pos[2 * g.idx]; g.y = G.pos[2 * g.idx + 1]; g.R = G.d * DISC;
    g.n = g.ns + g.np;
    byName.set(g.ship, g);
    for (const s of g.allStars) byName.set(s.ship, s);
  }
  for (const n of byName.values()) { remember(n, at); prep(n); }
  for (const g of gals) layoutNode(g);
  return { gals, byName, guide: G.pos };
}

// Never-booted ships (life 0: spawned on Azimuth but no keys ever set) are
// hidden unless the legend toggle shows them. Re-lay a host's visible
// children, and their children in turn, since those hang off their position.
let showCold = false;
try { showCold = localStorage.getItem('sextant-show-cold') === '1'; } catch {}
function layoutNode(node) {
  const all = [...(node.allStars || []), ...(node.allPlanets || []), ...(node.allMoons || [])];
  const vis = showCold ? all : all.filter((k) => k.life !== 0);
  for (const k of all) k.hidden = true;
  for (const k of vis) k.hidden = false;
  node.kids = vis; node.slotKids = [];
  placeKids(node, vis, 0, Math.max(vis.length, 1), node.kind === 'galaxy' ? SP.inGalaxy : SP.inStar);
  for (const k of vis) if (k.loaded) layoutNode(k);
}
// can this host open to show children (loaded or not yet)?
function openable(n) {
  if (!n) return false;
  if (n.kind === 'galaxy') return n.kids.length > 0 || (n.np > 0 && !n.loaded) || !!n.allMoons?.length;
  if (n.kind === 'star') return n.loaded ? n.kids.length > 0 : n.n > 0;
  if (n.kind === 'planet') return n.kids.length > 0;
  return false;
}

// put kids on their container's spiral, starting at slot `from` of `total`
function placeKids(node, kids, from, total, [q, r0]) {
  const S = armLayout(total, q, r0);
  node.layout = S; node.slotKids = node.slotKids || [];
  kids.forEach((k, j) => { node.slotKids[from + j] = k; });
  kids.forEach((k, j) => {
    const i = from + j;
    k.x = node.x + S.pos[2 * i] * node.R;
    k.y = node.y + S.pos[2 * i + 1] * node.R;
    k.R = S.d * node.R * DISC;
  });
}
// ships our ship has talked to (ames peers), and the hosts they live under
let PEERS = new Map(), PEER_HOSTS = new Set();
// moons aren't on azimuth: we chart the ones our ship has talked to (which
// includes our own, since moons ping their planet), around their planet
let MOONS = new Map(); // planet -> [moon json]
function attachMoons(p) {
  const ms = MOONS.get(p.ship);
  if (!ms || p.allMoons?.length) return false;
  p.allMoons = ms.slice().sort((a, b) => a.idx - b.idx).map((m) => {
    const n = { ...m, parentNode: p, kids: [], allStars: [], allPlanets: [] };
    remember(n, 0); prep(n); T.byName.set(n.ship, n);
    return n;
  });
  // a planet has nothing else to load; stars and galaxies still load planets
  if (p.kind === 'planet') p.loaded = true;
  return true;
}
async function loadPeers() {
  try {
    const ps = await cget('/peers', 60000);
    PEERS = new Map(ps.map((p) => [p.ship, p]));
    MOONS = new Map();
    for (const p of ps) if (p.kind === 'moon' && p.parent) MOONS.set(p.parent, [...(MOONS.get(p.parent) || []), p]);
    let moved = false;
    for (const planet of MOONS.keys()) { const n = T?.byName.get(planet); if (n && attachMoons(n)) { layoutNode(n); moved = true; } }
    if (moved) { sky.dirty = true; kick(); }
    PEER_HOSTS = new Set();
    for (const p of ps) {
      for (let h = p.sponsor; h && h !== p.ship; ) {
        if (PEER_HOSTS.has(h)) break;
        PEER_HOSTS.add(h);
        const n = T?.byName.get(h);
        h = n?.parentNode?.ship;
      }
    }
    if (T) for (const n of T.byName.values()) prep(n);
    legend(); sky.dirty = true; kick();
  } catch {}
}

// statuses this page has read from /api/status, so rebuilding the tree or
// reloading a star's planets never blanks a ship we already know about
const seen = new Map(); // ship -> { status, last, t }
function remember(n, since) {
  const k = seen.get(n.ship);
  if (k && k.t > since) { n.status = k.status; n.last = k.last; }
}
function prep(n) {
  n.c = cls(n); n.pal = isPal(n); n.mine = myChain.has(n.ship);
  n.peer = PEERS.has(n.ship); n.peerHost = PEER_HOSTS.has(n.ship);
  // adopted: sponsored by someone other than the ship that spawned it
  if (n.kind === 'planet') n.origin = n.parent;
  n.adopted = !!(n.parentNode && n.origin && n.origin !== n.parentNode.ship);
}

// lazily load the planets a star (or galaxy) sponsors
const loading = new Set();
async function ensureKids(node) {
  if (node.loaded || loading.has(node.ship) || loading.size >= 4) return;
  const want = node.kind === 'galaxy' ? node.np : node.n;
  if (!want) { node.loaded = true; return; }
  loading.add(node.ship);
  try {
    const r = await cget('/residents/' + node.ship, 300000);
    const ps = r.residents.filter((s) => s.kind === 'planet').sort((a, b) => a.idx - b.idx);
    const at = cache.get('/residents/' + node.ship)?.t ?? Date.now();
    for (const p of ps) { p.parentNode = node; p.kids = []; p.allStars = []; p.allPlanets = []; remember(p, at); prep(p); T.byName.set(p.ship, p); attachMoons(p); }
    node.allPlanets = ps;
    node.loaded = true;
    layoutNode(node);
    if (sky.ctx === node) { listedFor = undefined; renderContext(); }
  } catch (e) { node.loadError = e.message; node.loaded = true; }
  loading.delete(node.ship);
  sky.dirty = true; kick();
}

// ---------------------------------------------------------------- the sky

const sky = {
  canvas: $('sky'), base: document.createElement('canvas'), stage: $('stage'),
  w: 0, h: 0, dpr: 1, cam: { x: 0, y: 0, z: 1 }, fly: null,
  hover: null, sel: null, focus: null, dirty: true, raf: 0, drawn: [], ctx: null,
};
const DUST = Array.from({ length: 420 }, (_, i) => [hash(i * 3 + 1), hash(i * 3 + 2), 0.15 + hash(i * 3 + 3) * 0.55, hash(i + 77) > 0.93 ? 1.6 : 1]);

const unit = () => (Math.min(sky.w, sky.h) / 2) * 0.9;
const pxScale = () => unit() * sky.cam.z;
const toScreen = (x, y) => { const k = pxScale(); return [sky.w / 2 + (x - sky.cam.x) * k, sky.h / 2 + (y - sky.cam.y) * k]; };
const onScreen = (sx, sy, r) => sx + r > -10 && sy + r > -10 && sx - r < sky.w + 10 && sy - r < sky.h + 10;
const ZMAX = 40000;

// drawn size of a ship from the size of its disc on screen: a fixed-size dot
// while its disc is small, then a hub that grows with it once it opens
function dotPx(n, discPx) {
  // open hubs stay small so the ships they sponsor show through
  if (n.kind === 'galaxy') return Math.min(26, Math.max(Math.min(discPx * 0.4, 6.5), discPx * 0.09));
  if (n.kind === 'star') return Math.min(18, Math.max(1.2, Math.min(discPx * 0.45, 5), discPx * 0.09));
  if (n.kind === 'moon') return Math.min(12, Math.max(1.6, discPx * 0.5));
  // a planet with moons is a hub: keep it smaller so its moons show
  if (n.kids?.length) return Math.min(22, Math.max(1.8, Math.min(discPx * 0.5, 7), discPx * 0.22));
  return Math.min(20, Math.max(1.8, discPx * 0.5));
}
const OPEN = 18; // a disc opens once it is this many px in radius

function resize() {
  const r = sky.stage.getBoundingClientRect();
  sky.dpr = Math.min(2, window.devicePixelRatio || 1);
  sky.w = Math.max(1, r.width); sky.h = Math.max(1, r.height);
  for (const c of [sky.canvas, sky.base]) { c.width = Math.round(sky.w * sky.dpr); c.height = Math.round(sky.h * sky.dpr); }
  sky.canvas.style.width = sky.w + 'px'; sky.canvas.style.height = sky.h + 'px';
  sky.dirty = true; kick();
}

// owner view: the points an address controls, and the hosts they sit in
let OWNED = null, OWNED_HOSTS = new Set(), OWNER = null;
function matches(n) {
  if (OWNED) return OWNED.has(n.ship) || OWNED_HOSTS.has(n.ship);
  if (!sky.focus) return true;
  if (sky.focus === 'peer') return n.peer || n.peerHost;
  return sky.focus === 'pal' ? n.pal : n.c === sky.focus;
}

function drawBase() {
  const c = sky.base.getContext('2d'), { w, h, dpr } = sky;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = P.bg; c.fillRect(0, 0, w, h);
  c.fillStyle = P.dust;
  const u = unit();
  for (const d of DUST) {
    const x = (((d[0] * w - sky.cam.x * u * 0.08) % w) + w) % w, y = (((d[1] * h - sky.cam.y * u * 0.08) % h) + h) % h;
    c.globalAlpha = d[2]; c.fillRect(x, y, d[3], d[3]);
  }
  c.globalAlpha = 1;
  sky.drawn = [];
  if (!T) return;
  const k = pxScale();
  const [ox, oy] = toScreen(0, 0);

  // the galaxy spiral
  drawGuide(c, T.guide, 256, 0, 0, 1, 1);

  const later = [];
  for (const g of T.gals) {
    const [sx, sy] = toScreen(g.x, g.y), Rpx = g.R * k;
    if (!onScreen(sx, sy, Rpx)) continue;
    if (Rpx > OPEN && openable(g)) drawContainer(c, g, sx, sy, Rpx, later);
    if (Rpx > OPEN * 2 && g.np && !g.loaded) ensureKids(g);
    later.push([g, sx, sy, dotPx(g, Rpx), 1]);
  }
  // kids first, hubs on top
  for (const [n, sx, sy, r, a] of later) drawNode(c, n, sx, sy, r, a);
  updateContext();
  viewMoved();
}

function drawGuide(c, pos, N, cx, cy, scale, alpha) {
  if (!pos || N < 2) return;
  const k = pxScale();
  c.strokeStyle = P.ring; c.lineWidth = 1; c.globalAlpha = alpha;
  c.beginPath();
  for (let i = 0; i < N; i++) {
    const [x, y] = toScreen(cx + pos[2 * i] * scale, cy + pos[2 * i + 1] * scale);
    i ? c.lineTo(x, y) : c.moveTo(x, y);
  }
  c.stroke(); c.globalAlpha = 1;
  void k;
}

function drawContainer(c, node, sx, sy, Rpx, later) {
  const a = clamp((Rpx - OPEN) / 24, 0, 1);
  const k = pxScale();
  const L = node.layout;
  if (L && node.slotKids) {
    c.strokeStyle = P.slot; c.lineWidth = 1.2; c.globalAlpha = a;
    c.beginPath();
    if (!L.m) {
      // a handful of children: a spoke to each
      for (const s of node.slotKids) if (s) { const [x, y] = toScreen(s.x, s.y); c.moveTo(sx, sy); c.lineTo(x, y); }
    } else {
      // each arm: from the host out through its children in order
      for (let j = 0; j < L.m; j++) {
        c.moveTo(sx, sy);
        for (let i = j; i < node.slotKids.length; i += L.m) {
          const s = node.slotKids[i];
          if (!s) continue;
          const [x, y] = toScreen(s.x, s.y);
          c.lineTo(x, y);
        }
      }
    }
    c.stroke();
  }
  c.globalAlpha = 1;
  if (node.kind === 'star' && !node.loaded) {
    ensureKids(node);
    c.fillStyle = P.muted; c.font = '11px ui-monospace, "SF Mono", Menlo, monospace'; c.textAlign = 'center';
    c.globalAlpha = a; c.fillText(`loading ${node.n.toLocaleString()} planets…`, sx, sy + Rpx * 0.6); c.globalAlpha = 1; c.textAlign = 'left';
  }
  for (const kid of node.kids) {
    const [x, y] = toScreen(kid.x, kid.y), kr = kid.R * k;
    if (!onScreen(x, y, kr)) continue;
    if (kid.kind !== 'galaxy' && kr > OPEN && openable(kid)) drawContainer(c, kid, x, y, kr, later);
    later.push([kid, x, y, dotPx(kid, kr), a]);
  }
}

function drawNode(c, n, sx, sy, r, alpha) {
  r *= SIZE[n.c] ?? 1;
  const a = (matches(n) ? 1 : 0.1) * alpha, col = P[n.c];
  if (a <= 0.01) return;
  if (n.c === 'live' || n.c === 'dead' || n.c === 'unborn') {
    c.globalAlpha = 0.18 * a; c.fillStyle = col;
    c.beginPath(); c.arc(sx, sy, r + Math.min(r * 1.6, 9), 0, TAU); c.fill();
  }
  c.globalAlpha = a; c.fillStyle = col;
  c.beginPath(); c.arc(sx, sy, r, 0, TAU); c.fill();
  if (n.pal) { c.strokeStyle = P.accent; c.lineWidth = 1.2; c.beginPath(); c.arc(sx, sy, r + 2.5, 0, TAU); c.stroke(); }
  if (sky.focus === 'peer' && n.peerHost && !n.peer) { c.strokeStyle = P.live; c.lineWidth = 1.2; c.setLineDash([3, 3]); c.beginPath(); c.arc(sx, sy, r + 4, 0, TAU); c.stroke(); c.setLineDash([]); }
  if (n.adopted && r > 1.5) { c.strokeStyle = P.accent; c.lineWidth = 1.2; c.setLineDash([2, 2]); c.beginPath(); c.arc(sx, sy, r + (n.pal ? 5 : 2.5), 0, TAU); c.stroke(); c.setLineDash([]); }
  // the selected ship wears its sigil once it is big enough to read
  if (n === sky.sel && r >= 11) {
    const img = sigilImage(n.ship, col);
    if (img) { const s = r * 1.3; c.globalAlpha = a; c.drawImage(img, sx - s / 2, sy - s / 2, s, s); c.globalAlpha = 1; }
  }
  if (n.mine) {
    c.strokeStyle = P.accent; c.lineWidth = 1.5; c.beginPath(); c.arc(sx, sy, r + 6, 0, TAU); c.stroke();
    c.beginPath();
    for (let q = 0; q < 4; q++) {
      const ang = (q * TAU) / 4;
      c.moveTo(sx + Math.cos(ang) * (r + 8), sy + Math.sin(ang) * (r + 8));
      c.lineTo(sx + Math.cos(ang) * (r + 13), sy + Math.sin(ang) * (r + 13));
    }
    c.stroke();
  }
  c.globalAlpha = 1; c.lineWidth = 1;
  n.sx = sx; n.sy = sy; n.sr = r;
  if (alpha > 0.3) sky.drawn.push(n);
}

// names stay off the map except for the ship under the pointer and the
// selected one, drawn on the overlay so hovering never redraws the sky
function nameTag(c, n, col) {
  if (!n || !sky.drawn.includes(n)) return;
  const big = n.sr > 10;
  c.font = (big ? '600 12px' : '11px') + ' ui-monospace, "SF Mono", Menlo, monospace';
  let x, y;
  if (big) { c.textAlign = 'center'; x = n.sx; y = n.sy + n.sr + 18; }
  else { c.textAlign = 'left'; x = n.sx + n.sr + 9; y = n.sy + 4; }
  c.globalAlpha = 1; c.lineWidth = 3.5; c.strokeStyle = P.bg; c.lineJoin = 'round';
  c.strokeText(n.ship, x, y); c.fillStyle = col; c.fillText(n.ship, x, y);
  c.textAlign = 'left';
}

// ---------------------------------------------------------------- radar

const blips = [];
const rgba = (hex, a) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : `rgba(127,127,127,${a})`;
};
// results wait here until the sweep line passes over their ship, so the
// map changes colour in the line's wake
const held = new Map(); // node -> { st, last, t }
let sweepPrev = null, listAt = 0;
const scanning = () => auto.on && (auto.checking > 0 || held.size > 0);

// the sweep turns around the galaxy or star in view (the whole network
// when zoomed out)
function sweepGeom(now) {
  const k = pxScale(), n = sky.ctx;
  let cx, cy, R;
  if (n && sky.drawn.includes(n)) { cx = n.sx; cy = n.sy; R = n.R * k; }
  else { [cx, cy] = toScreen(0, 0); R = 1.05 * k; }
  return { cx, cy, R: Math.min(R, Math.hypot(sky.w, sky.h)), a: ((now / 2400) * TAU) % TAU };
}

function applyResult(n, r) {
  n.status = r.st; n.last = r.last; prep(n);
  if (!reduceMotion) blips.push({ n, t: performance.now() });
  const d = panelData;
  if (d && d.ship === n.ship && (d.status !== n.status || d.last !== n.last)) {
    d.status = n.status; d.last = n.last;
    const pd = $('pdot'), ps = $('psub');
    if (pd) pd.innerHTML = dot(d.status);
    if (ps) ps.innerHTML = panelSub(d);
  }
}
// after a batch lands: redraw the sky now, the legend and list at most
// once a second (they're heavier and don't need every frame)
function afterApply(force) {
  sky.dirty = true; kick();
  const t = performance.now();
  if (force || t - listAt > 1000) { listAt = t; legend(); listedFor = undefined; listFor(sky.ctx); }
}

// reveal every held result whose ship the line crossed since last frame
function reveal(g, now) {
  const from = sweepPrev ?? g.a;
  sweepPrev = g.a;
  if (!held.size) return;
  const swept = (g.a - from + TAU) % TAU;
  let any = false;
  for (const [n, r] of held) {
    const dx = n.sx - g.cx, dy = n.sy - g.cy;
    let hit = now - r.t > 3000 || !sky.drawn.includes(n) || Math.hypot(dx, dy) > g.R + 4;
    if (!hit) hit = (g.a - Math.atan2(dy, dx) + 2 * TAU) % TAU <= swept;
    if (hit) { held.delete(n); applyResult(n, r); any = true; }
  }
  if (any) afterApply(!held.size);
}

function drawSweep(c, now) {
  const g = sweepGeom(now), { cx, cy, R, a } = g, span = 1.2, col = P.live;
  if (c.createConicGradient) {
    const g = c.createConicGradient(a - span, cx, cy);
    g.addColorStop(0, rgba(col, 0));
    g.addColorStop(span / TAU, rgba(col, 0.2));
    g.addColorStop(Math.min(1, span / TAU + 0.001), rgba(col, 0));
    c.fillStyle = g;
  } else c.fillStyle = rgba(col, 0.08);
  c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, R, a - span, a); c.closePath(); c.fill();
  c.strokeStyle = rgba(col, 0.55); c.lineWidth = 1.2;
  c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); c.stroke();
  reveal(g, now);
}

// a ring that flares out from a ship when its answer (or silence) comes in
function drawBlips(c, now) {
  for (let i = blips.length - 1; i >= 0; i--) {
    const b = blips[i], p = (now - b.t) / 900;
    if (p >= 1 || !sky.drawn.includes(b.n)) { blips.splice(i, 1); continue; }
    c.strokeStyle = P[b.n.c] || P.ink; c.lineWidth = 1.5; c.globalAlpha = 1 - p;
    c.beginPath(); c.arc(b.n.sx, b.n.sy, b.n.sr + 2 + p * Math.min(b.n.sr * 2 + 8, 18), 0, TAU); c.stroke();
  }
  c.globalAlpha = 1;
}

// which galaxy / star the view is centred inside, for crumbs and the title
function updateContext() {
  const k = pxScale(), { x, y } = sky.cam;
  const inside = (n) => n && Math.hypot(n.x - x, n.y - y) < n.R && n.R * k > 120;
  let g = null, s = null;
  for (const gg of T.gals) if (inside(gg)) { g = gg; break; }
  if (g) for (const ss of g.kids) if (ss.kind === 'star' && inside(ss)) { s = ss; break; }
  const ctx = s || g || null;
  if (ctx === sky.ctx) return;
  sky.ctx = ctx;
  renderContext();
}

function renderContext() {
  if ($('explore').hidden) return;
  const ctx = sky.ctx;
  const chain = [];
  for (let n = ctx; n; n = n.parentNode) chain.unshift(n);
  const sel = sky.sel && !chain.includes(sky.sel) ? sky.sel : null;
  const parts = [...chain, ...(sel ? [sel] : [])];
  crumbs.innerHTML = parts.length
    ? `<a href="#/">network</a>` + parts.map((n, i) => `<span class="sep">›</span>` + (i === parts.length - 1 ? `<b>${esc(n.ship)}</b>` : `<a href="#/${esc(n.ship)}">${esc(n.ship)}</a>`)).join('') + `<span class="muted crumbnote">by sponsor</span>`
    : '<b>network</b><span class="muted crumbnote">ships placed under their current sponsor</span>';
  if (!ctx) {
    const st = T.gals.reduce((a, g) => a + g.ns, 0);
    $('title').innerHTML = `<b>256 galaxies</b><span>${st.toLocaleString()} sponsored stars · zoom in to open a galaxy</span>`;
  } else if (ctx.kind === 'galaxy') {
    const own = ctx.allStars.filter((s) => !s.adopted).length;
    const shown = ctx.kids.filter((s) => s.kind === 'star').length;
    $('title').innerHTML = `<b>${esc(ctx.ship)}</b><span>${shown} ${showCold ? '' : 'booted '}star${shown === 1 ? '' : 's'}${showCold ? '' : ` of ${ctx.ns} sponsored`}${ctx.ns - own ? ` · ${ctx.ns - own} adopted` : ''}${ctx.np ? ` · ${ctx.np} planets` : ''}</span>`;
  } else {
    const shown = ctx.loaded ? ctx.kids.length : null;
    $('title').innerHTML = `<b>${esc(ctx.ship)}</b><span>${shown == null ? `sponsors ${ctx.n.toLocaleString()} planets` : `${shown.toLocaleString()} ${showCold ? '' : 'booted '}planet${shown === 1 ? '' : 's'}${showCold ? '' : ` of ${ctx.n.toLocaleString()}`}`} · via ${esc(ctx.parentNode.ship)}</span>`;
  }
  if (!sky.sel) renderPanel(null);
  listFor(ctx);
}

function frame(now) {
  sky.raf = 0;
  try { draw(now); } catch (e) { console.error('sextant draw', e); sky.fly = null; }
}
function draw(now) {
  if (sky.fly) stepFly(now);
  if (sky.dirty) { drawBase(); sky.dirty = false; }
  const c = sky.canvas.getContext('2d'), { dpr } = sky;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.drawImage(sky.base, 0, 0);
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  let loop = !!sky.fly || sky.dirty;
  if (!reduceMotion && scanning()) { drawSweep(c, now); loop = true; } else sweepPrev = null;
  if (blips.length) { drawBlips(c, now); loop = true; }
  if (trace && T) { drawTrace(c, now); loop = true; }
  if (T && !sky.fly) { drawEscapes(c); drawWatched(c); }
  if (glides.length) { drawGlides(c, now); loop = true; }
  if (!sky.fly) {
    const live = sky.drawn.filter((n) => n.c === 'live' && matches(n));
    if (!reduceMotion && live.length && live.length < 3000) {
      c.strokeStyle = P.live; c.lineWidth = 1;
      for (const n of live) {
        const ph = (now / 2600 + hash(n.idx ?? 0)) % 1;
        c.globalAlpha = (1 - ph) * 0.55;
        c.beginPath(); c.arc(n.sx, n.sy, n.sr + 1 + ph * Math.min(n.sr * 2 + 6, 16), 0, TAU); c.stroke();
      }
      c.globalAlpha = 1; loop = true;
    }
    for (const [n, col, extra] of [[sky.hover, P.ink, 4], [sky.sel, P.accent, 6]]) {
      if (!n || !sky.drawn.includes(n)) continue;
      c.strokeStyle = col; c.lineWidth = 1.5;
      c.beginPath(); c.arc(n.sx, n.sy, n.sr + extra, 0, TAU); c.stroke();
    }
    if (sky.hover !== sky.sel) nameTag(c, sky.hover, P.ink);
    nameTag(c, sky.sel, P.accent);
  }
  if (loop) kick();
}
function kick() { if (!sky.raf) sky.raf = requestAnimationFrame(frame); }

// ---------------------------------------------------------------- camera

// fly: zoom on a log scale and move so the target slides in smoothly
function flyTo(x, y, z, instant = false) {
  z = clamp(z, 0.6, ZMAX);
  if (instant || reduceMotion) { sky.cam = { x, y, z }; sky.fly = null; sky.dirty = true; kick(); return; }
  sky.fly = { from: { ...sky.cam }, to: { x, y, z }, t0: performance.now(), dur: 1100 };
  kick();
}
function stepFly(now) {
  const f = sky.fly, t = Math.min(1, (now - f.t0) / f.dur), e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const lz0 = Math.log(f.from.z), lz1 = Math.log(f.to.z), z = Math.exp(lz0 + (lz1 - lz0) * e);
  // weight the move by 1/z so the target tracks naturally while zooming
  const i0 = 1 / f.from.z, i1 = 1 / f.to.z, u = Math.abs(i1 - i0) < 1e-12 ? e : (1 / z - i0) / (i1 - i0);
  sky.cam = { x: f.from.x + (f.to.x - f.from.x) * u, y: f.from.y + (f.to.y - f.from.y) * u, z };
  sky.dirty = true;
  if (t >= 1) sky.fly = null;
}
const fitZ = (R) => (Math.min(sky.w, sky.h) * 0.42) / (R * unit());
function flyToNode(n, instant) {
  if (!n) return flyTo(0, 0, 1, instant);
  if (n.kind === 'planet' || n.kind === 'moon') return flyTo(n.x, n.y, fitZ(n.R * 7), instant);
  flyTo(n.x, n.y, fitZ(n.R), instant);
}

function zoomAt(sx, sy, f) {
  sky.fly = null;
  const k0 = pxScale(), z = clamp(sky.cam.z * f, 0.6, ZMAX), k1 = unit() * z;
  const wx = sky.cam.x + (sx - sky.w / 2) / k0, wy = sky.cam.y + (sy - sky.h / 2) / k0;
  sky.cam = { x: wx - (sx - sky.w / 2) / k1, y: wy - (sy - sky.h / 2) / k1, z };
  sky.dirty = true; kick();
}

function pick(sx, sy) {
  let best = null, bd = Infinity;
  for (const n of sky.drawn) {
    const dx = n.sx - sx, dy = n.sy - sy, d = dx * dx + dy * dy, lim = Math.max(8, n.sr + 4);
    if (d < lim * lim && d < bd) { bd = d; best = n; }
  }
  return best;
}

const ptrs = new Map();
let dragged = false, pinch = null;
const local = (e) => { const r = sky.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
sky.canvas.addEventListener('pointerdown', (e) => {
  sky.canvas.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, local(e)); dragged = false; sky.fly = null;
  if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) }; }
});
sky.canvas.addEventListener('pointermove', (e) => {
  const pt = local(e), prev = ptrs.get(e.pointerId);
  if (!prev) {
    const n = pick(...pt);
    if (n !== sky.hover) { sky.hover = n; kick(); }
    tip(n, pt);
    sky.canvas.style.cursor = n ? 'pointer' : 'grab';
    return;
  }
  ptrs.set(e.pointerId, pt);
  if (ptrs.size === 2 && pinch) {
    const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, d / pinch.d); pinch.d = d; dragged = true;
  } else if (ptrs.size === 1) {
    const dx = pt[0] - prev[0], dy = pt[1] - prev[1];
    if (dragged || Math.abs(dx) + Math.abs(dy) > 3) {
      dragged = true;
      const k = pxScale();
      sky.cam.x -= dx / k; sky.cam.y -= dy / k; sky.dirty = true;
      sky.canvas.style.cursor = 'grabbing'; tip(null); kick();
    } else ptrs.set(e.pointerId, prev);
  }
});
const endPtr = (e) => {
  const was = ptrs.has(e.pointerId);
  ptrs.delete(e.pointerId);
  if (ptrs.size < 2) pinch = null;
  if (was && !dragged && ptrs.size === 0 && e.type === 'pointerup') {
    const n = pick(...local(e));
    if (n && n === sky.sel) dive(n);
    else select(n);
  }
  if (ptrs.size === 0) sky.canvas.style.cursor = 'grab';
};
sky.canvas.addEventListener('pointerup', endPtr);
sky.canvas.addEventListener('pointercancel', endPtr);
sky.canvas.addEventListener('pointerleave', () => { if (sky.hover) { sky.hover = null; kick(); } tip(null); });
sky.canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(...local(e), Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))); }, { passive: false });
sky.canvas.addEventListener('dblclick', (e) => { const n = pick(...local(e)); if (n) dive(n); else zoomAt(...local(e), 2.5); });
document.querySelectorAll('[data-z]').forEach((b) => (b.onclick = () => {
  const z = b.dataset.z;
  if (z === 'reset') { location.hash = '#/'; flyTo(0, 0, 1); }
  else zoomAt(sky.w / 2, sky.h / 2, z === 'in' ? 1.8 : 1 / 1.8);
}));
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input')) return;
  if (e.key === 'Escape') { if (sky.sel) select(null); else up(); }
  else if (e.key === '+' || e.key === '=') zoomAt(sky.w / 2, sky.h / 2, 1.5);
  else if (e.key === '-') zoomAt(sky.w / 2, sky.h / 2, 1 / 1.5);
  else if (e.key === '0') { location.hash = '#/'; flyTo(0, 0, 1); }
});

function tip(n, pt) {
  const el = $('tip');
  if (!n) { el.hidden = true; return; }
  const rel = n.target && n.leech ? 'mutual pal' : n.target ? 'you added them' : n.leech ? 'they added you' : '';
  const spon = n.kind === 'galaxy' ? `sponsors ${n.ns} stars${n.np ? `, ${n.np} planets` : ''}` : n.kind === 'star' ? `sponsors ${n.n.toLocaleString()} planets · under ${n.parentNode.ship}` : `under ${n.parentNode?.ship ?? ''}`;
  el.innerHTML = `<b>${esc(n.ship)}</b><span>${esc(n.kind)} · ${esc(n.life === 0 ? 'never booted' : statusText(n.status))}${n.status && n.last ? ' · ' + ago(n.last) : ''}</span><span>${esc(spon)}</span>${n.adopted ? `<span class="pal">adopted · spawned under ${esc(n.origin)}</span>` : ''}${n.peer ? '<span>your ship has talked to it</span>' : ''}${n.probing ? '<span>checking…</span>' : ''}${rel ? `<span class="pal">${rel}</span>` : ''}`;
  el.hidden = false;
  const x = Math.min(pt[0] + 14, sky.w - el.offsetWidth - 8), y = pt[1] + 16 + el.offsetHeight > sky.h ? pt[1] - el.offsetHeight - 10 : pt[1] + 16;
  el.style.transform = `translate(${x}px, ${y}px)`;
}

function legend() {
  const el = $('legend');
  if (!T) { el.innerHTML = ''; return; }
  const all = [...T.gals, ...T.gals.flatMap((g) => g.allStars)];
  const count = (k) => (k === 'peer' ? PEERS.size : all.filter((n) => (k === 'pal' ? n.pal : n.c === k)).length);
  const ownerChip = OWNED ? `<button data-owner class="on" title="stop highlighting this address's points">◎ ${esc(OWNER.slice(0, 6) + '…' + OWNER.slice(-4))} · ${OWNED.size} ✕</button>` : '';
  el.innerHTML = ownerChip + CLASSES.map(([k, label]) => {
    const n = count(k);
    if (!n) return '';
    if (k === 'cold') return `<button data-cold class="${showCold ? '' : 'off'}" title="${showCold ? 'hide' : 'show'} ships that were spawned but never booted"><i class="dot cold"></i>never booted <span>${showCold ? n.toLocaleString() : 'hidden'}</span></button>`;
    return `<button data-focus="${k}" class="${sky.focus === k ? 'on' : ''}" title="${k === 'peer' ? 'show only ships your ship has talked to, and the galaxies and stars they live under' : `show only: ${label} (counts are galaxies and stars)`}"><i class="dot ${k}"></i>${label} <span>${n.toLocaleString()}</span></button>`;
  }).join('');
  const oc = el.querySelector('[data-owner]');
  if (oc) oc.onclick = () => { OWNED = null; OWNER = null; OWNED_HOSTS = new Set(); sky.dirty = true; legend(); kick(); };
  el.querySelectorAll('[data-focus]').forEach((b) => (b.onclick = () => {
    sky.focus = sky.focus === b.dataset.focus ? null : b.dataset.focus;
    sky.dirty = true; legend(); kick();
  }));
  const cb = el.querySelector('[data-cold]');
  if (cb) cb.onclick = () => {
    showCold = !showCold;
    try { localStorage.setItem('sextant-show-cold', showCold ? '1' : '0'); } catch {}
    for (const g of T.gals) layoutNode(g);
    sky.ctx = undefined; listedFor = undefined;
    sky.dirty = true; legend(); kick();
  };
}

// ---------------------------------------------------------------- sigils

const sigilOK = (p) => typeof window.urbitSigil === 'function' && [1, 2, 4].includes(p.replace(/[~-]/g, '').length / 3);
function sigilSvg(p, size, fg, bg) {
  if (!sigilOK(p)) return null;
  try { return window.urbitSigil({ point: p, size, foreground: fg, background: bg, space: 'default' }); } catch { return null; }
}
// sigils sit straight on the ship's status colour, drawn in the sky colour
const statusColor = (n) => P[cls(n)] || P.cold;
const sigilImgs = new Map();
function sigilImage(p, bg) {
  const key = p + bg;
  if (sigilImgs.has(key)) { const im = sigilImgs.get(key); return im.complete && im.naturalWidth ? im : null; }
  const svg = sigilSvg(p, 128, P.bg, bg);
  const im = new Image();
  if (svg) { im.onload = () => { sky.dirty = true; kick(); }; im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace('viewbox', 'viewBox')); }
  sigilImgs.set(key, im);
  return null;
}
function sigilBox(n, size = 72) {
  const bg = statusColor(n);
  const svg = sigilSvg(n.ship, size, P.bg, bg);
  return svg ? `<div class="sigil" style="background:${bg}" aria-hidden="true">${svg}</div>` : '';
}

// ---------------------------------------------------------------- panel

const fact = (k, v) => `<div><dt>${k}</dt><dd title="${esc(v)}">${v == null || v === '' ? '<span class="muted">—</span>' : esc(v)}</dd></div>`;
const link = (p) => (p ? `<a href="#/${esc(p)}">${esc(p)}</a>` : '<span class="muted">—</span>');
const lfact = (k, p) => `<div><dt>${k}</dt><dd>${link(p)}</dd></div>`;
const opens = openable;

let panelFor = null;
async function select(n) {
  if (trace && (!n || n.ship !== trace.ship)) stopTrace();
  sky.sel = n; kick();
  renderContext();
  if (!n) { panelFor = null; renderPanel(null); return; }
  panelFor = n.ship;
  $('panel').innerHTML = `<h2 class="pname">${dot(n.status)}${esc(n.ship)}</h2><div class="muted">reading…</div>`;
  try {
    const d = await cget('/ship/' + n.ship);
    if (panelFor === n.ship) renderPanel(d, n);
  } catch (e) { $('panel').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

let panelData = null;
const panelSub = (d) => `${esc(d.kind)} · ${d.life === 0 ? 'never booted' : statusText(d.status)}${d.status && d.last ? ' · heard ' + ago(d.last) : ''}`;
function renderPanel(d, node = null) {
  const el = $('panel');
  panelData = d;
  if (!d) {
    const ctx = sky.ctx;
    if (ctx) {
      const own = ctx.kind === 'galaxy' ? ctx.allStars.filter((s) => !s.adopted).length : null;
      el.innerHTML = `<div class="phead">${sigilBox(ctx)}<div><h2 class="pname">${dot(ctx.status)}${esc(ctx.ship)}</h2>
        <div class="sub">${esc(ctx.kind)} · ${ctx.life === 0 ? 'never booted' : statusText(ctx.status)}</div></div></div>
        <dl class="facts">
          ${ctx.kind === 'galaxy' ? fact('stars sponsored', ctx.ns) + fact('its own stars', own) + fact('adopted stars', ctx.ns - own) + fact('planets sponsored', ctx.np) : fact('planets sponsored', ctx.n.toLocaleString()) + lfact('sponsor', ctx.parentNode.ship)}
        </dl>
        <p class="muted">Click any ship to select it and see details. Click it again to zoom in.</p>`;
      return;
    }
    const st = T ? T.gals.reduce((a, g) => a + g.ns, 0) : 0;
    const live = T ? T.gals.filter((g) => g.c === 'live').length : 0;
    el.innerHTML = `<h2 class="pname">The network</h2>
      <p class="muted">Every ship is drawn under the ship that sponsors it right now, not where it was spawned. Galaxies sit on one spiral. Zoom into a galaxy to see the stars it sponsors, then into a star to see its planets.</p>
      <dl class="facts">${fact('galaxies', 256)}${fact('sponsored stars', st.toLocaleString())}${fact('galaxies live from you', live)}${fact('points on azimuth', (me?.points ?? 0).toLocaleString())}${fact('viewing from', me?.ship)}</dl>
`;
    return;
  }
  const sponsorNote = d.sponsor && d.sponsor !== d.parent && d.kind !== 'galaxy' ? ' (adopted, not its parent)' : '';
  const badges = [
    d.layer && `<span class="badge">azimuth ${esc(d.layer)}</span>`,
    d.life === 0 && `<span class="badge">never booted (no keys)</span>`,
    d.target && d.leech && `<span class="badge pal">mutual pal</span>`,
    d.target && !d.leech && `<span class="badge pal">you added them</span>`,
    d.leech && !d.target && `<span class="badge pal">they added you</span>`,
    myChain.has(d.ship) && `<span class="badge pal">your ${d.ship === me?.ship ? 'ship' : 'lineage'}</span>`,
    d.escape && `<span class="badge">escaping to ${esc(d.escape)}</span>`,
    !node && d.kind !== 'galaxy' && `<span class="badge">not on the chart (no sponsor or not on azimuth)</span>`,
  ].filter(Boolean).join('');
  const pal = palParts(d);
  el.innerHTML = `
    <div class="phead">${sigilBox(d)}<div class="ptitle"><h2 class="pname"><span id="pdot">${dot(d.status)}</span>${esc(d.ship)}</h2>
    <div class="sub" id="psub">${panelSub(d)}</div>
    ${opens(node) ? `<button class="primary dive" id="dive">Zoom into ${node.kind === 'galaxy' ? 'its stars' : 'its planets'} ›</button>` : ''}</div></div>
    <div class="seg ptabs" role="tablist">
      <button role="tab" data-ptab="overview">Overview</button>
      <button role="tab" data-ptab="apps">Apps <span id="appcount"></span></button>
    </div>
    <div class="ptab" data-pane="overview">
      <div class="actrow">${pal.button}<button id="watchbtn" class="${d.watched ? 'on' : ''}" title="${d.watched ? 'stop watching' : 'get a Landscape notification when it stops answering, comes back, or changes on Azimuth'}">${d.watched ? '★ Watching' : '☆ Watch'}</button><button id="tracebtn" title="Check every ship a packet passes through between you and ${esc(d.ship)}">Trace route</button><button id="ping" ${me?.vitals ? '' : 'disabled title="needs %vitals (landscape)"'}>Check connection</button></div>
      <div class="actnote">${pal.state}<span id="pingres"></span></div>
      <div class="trace" id="trace"></div>
      <dl class="facts">
        <div><dt>sponsor</dt><dd>${link(d.sponsor)}${esc(sponsorNote)}</dd></div>
        ${lfact('parent', d.parent)}
        ${fact('life / rift', d.life == null ? null : `${d.life} / ${d.rift}`)}
        ${fact('sponsors', d.residents == null ? null : `${d.residents} ship${d.residents === 1 ? '' : 's'}`)}
        ${fact('escape requests', d.requests)}
        ${afact('owner', d.owner)}
        ${afact('management proxy', d.managementProxy)}
        ${afact('spawn proxy', d.spawnProxy)}
      </dl>
      <div class="badges">${badges}</div>
    </div>
    <div class="ptab" data-pane="apps"><div class="apps" id="apps"></div></div>`;
  showTab(panelTab);
  el.querySelectorAll('[data-ptab]').forEach((b) => (b.onclick = () => showTab((panelTab = b.dataset.ptab))));
  $('ping').onclick = () => ping(d.ship);
  $('tracebtn').onclick = () => startTrace(d.ship);
  $('watchbtn').onclick = () => toggleWatch(d, node);
  if (trace && trace.ship === d.ship) renderTrace();
  const dv = $('dive'); if (dv) dv.onclick = () => dive(node);
  const pb = $('palbtn'); if (pb) pb.onclick = () => palAction(d, node, pb.dataset.act === 'add');
  loadApps(d.ship);
}

// ---------------------------------------------------------------- apps
//
// What a ship publishes for install comes from %treaty. A ship we haven't
// looked up yet has to be asked first (an "ally", exactly what Landscape's
// app search does); its desks then arrive one docket at a time.

const okUrl = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);
const okHex = (c) => (/^[0-9a-f]{6}$/i.test(c || '') ? '#' + c : 'var(--line)');
let appsPoll = null;
async function loadApps(ship, until = 0) {
  clearTimeout(appsPoll);
  const el = $('apps');
  if (!el || panelFor !== ship) return;
  let r;
  try { r = await get('/apps/' + ship); } catch { el.innerHTML = ''; return; }
  if (panelFor !== ship || !$('apps')) return;
  if (!r.treaty) { el.innerHTML = ''; return; }
  const waiting = until && Date.now() < until;
  const head = () => '';
  const ac = $('appcount'); if (ac) ac.textContent = r.allied && r.desks.length ? r.desks.length : '';
  if (!r.allied) {
    el.innerHTML = head() + `<div class="appsnote"><button id="allybtn">Look up apps ${esc(ship)} publishes</button>
      <span class="muted">Asks the ship for its app list through %treaty, the same as searching it in Landscape. It needs to be online.</span></div>`;
    $('allybtn').onclick = async () => {
      $('allybtn').disabled = true; $('allybtn').textContent = 'asking…';
      const p = await fetch(`${API}/apps/${ship}`, { method: 'POST', credentials: 'include' }).catch(() => null);
      if (!p || !p.ok) { $('allybtn').textContent = p && p.status === 403 ? 'log in to look up apps' : 'lookup failed'; return; }
      loadApps(ship, Date.now() + 60000);
    };
    return;
  }
  const got = new Set(r.apps.map((a) => a.desk));
  const pending = r.desks.filter((d) => !got.has(d));
  const cards = r.apps.sort((a, b) => a.title.localeCompare(b.title)).map((a) => appCard(a)).join('');
  const status = pending.length && (waiting || r.apps.length)
    ? `<div class="muted appsnote">${waiting ? 'loading' : 'waiting on'} ${pending.length} more: ${pending.map((d) => '%' + esc(d)).join(' ')}</div>`
    : !r.desks.length ? `<div class="muted appsnote">${waiting ? `asking ${esc(ship)}…` : 'Publishes no apps, or hasn\'t answered yet.'}</div>` : '';
  el.innerHTML = cards + status;
  wireApps(el, ship);
  if (waiting && (pending.length || !r.desks.length)) appsPoll = setTimeout(() => loadApps(ship, until), 3000);
}

// one app card; .withShip adds the publisher (for the network-wide list)
function appCard(a, withShip = false, rank = 0) {
  const icon = okUrl(a.image)
    ? `<img src="${esc(a.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" style="background:${okHex(a.color)}">`
    : `<span class="appicon" style="background:${okHex(a.color)}">${esc((a.title || a.desk).slice(0, 1).toUpperCase())}</span>`;
  const by = withShip ? ` · <a href="#/${esc(a.ship)}" title="show ${esc(a.ship)} on the map">${esc(a.ship)}</a>` : '';
  const pop = a.n ? `<span class="pop" title="${a.n} install${a.n === 1 ? '' : 's'} heard of from pals and their pals${a.mine ? ', including yours' : ''}${a.t >= 0.05 ? ` · trending ${a.t.toFixed(1)}` : ''}">${a.n} nearby</span>` : '';
  const via = a.heard ? '<span class="muted" title="known only through pals, not through a publisher you follow"> · via pals</span>' : '';
  return `<div class="app">${rank ? `<span class="rank">${rank}</span>` : ''}${icon}<div class="appbody"><div class="apptitle"><b>${esc(a.title || a.desk)}</b><span class="muted">%${esc(a.desk)} · ${esc(a.version)}${by}${via}</span></div>
    ${a.info ? `<div class="appinfo">${esc(a.info)}</div>` : ''}</div>
    <div class="appside">${pop}${a.installed ? '<span class="badge">installed</span>' : `<button class="appinstall" data-ship="${esc(a.ship || '')}" data-desk="${esc(a.desk)}" data-title="${esc(a.title || a.desk)}">Install</button>`}</div></div>`;
}
// install buttons, and icons that fail to load fall back to a lettered tile
function wireApps(el, ship) {
  el.querySelectorAll('.appinstall').forEach((b) => (b.onclick = () => installApp(ship || b.dataset.ship, b)));
  el.querySelectorAll('.app img').forEach((im) => (im.onerror = () => {
    const t = document.createElement('span');
    t.className = 'appicon'; t.style.background = im.style.background;
    t.textContent = (im.closest('.app').querySelector('.apptitle b')?.textContent || '?').slice(0, 1).toUpperCase();
    im.replaceWith(t);
  }));
}
async function installApp(ship, b) {
  const desk = b.dataset.desk;
  if (!confirm(`Install "${b.dataset.title}" (%${desk}) from ${ship}?\n\nApps run on your ship with full access to it. Only install from publishers you trust.`)) return;
  b.disabled = true; b.textContent = 'installing…';
  const r = await fetch(`${API}/install/${ship}/${encodeURIComponent(desk)}`, { method: 'POST', credentials: 'include' }).catch(() => null);
  b.textContent = r && r.ok ? 'started · see Landscape' : r && r.status === 403 ? 'log in first' : 'failed';
}

// ---------------------------------------------------------------- %pals

// panel tabs: remembered across selections
let panelTab = 'overview';
function showTab(t) {
  document.querySelectorAll('#panel [data-ptab]').forEach((b) => { b.classList.toggle('on', b.dataset.ptab === t); b.setAttribute('aria-selected', b.dataset.ptab === t); });
  document.querySelectorAll('#panel [data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== t));
}

// eth addresses: short, click to copy, with an Etherscan link
const isAddr = (a) => /^0x[0-9a-f]{40}$/i.test(a || '');
function afact(k, a) {
  if (!isAddr(a)) return fact(k, null);
  return `<div><dt>${k}</dt><dd class="addr"><button class="copy" data-copy="${esc(a)}" title="copy ${esc(a)}">${esc(a.slice(0, 6) + '…' + a.slice(-4))}</button><a href="#/owner/${esc(a.toLowerCase())}" title="every point this address controls" aria-label="every point this address controls">◎</a><a href="https://etherscan.io/address/${esc(a)}" target="_blank" rel="noopener noreferrer" title="open on Etherscan" aria-label="open on Etherscan">↗</a></dd></div>`;
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch {}
  const ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch {}
  ta.remove(); return ok;
}
$('panel').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  const was = b.textContent, ok = await copyText(b.dataset.copy);
  b.textContent = ok ? 'copied' : 'copy failed'; b.classList.add('done');
  setTimeout(() => { b.textContent = was; b.classList.remove('done'); }, 1200);
});

function palParts(d) {
  if (!me?.pals || d.ship === me.ship) return { button: '', state: '' };
  let state;
  if (d.target && d.leech) state = '★ mutual pals';
  else if (d.target) state = 'you added them · ' + (d.palAck === true ? 'they got your request; waiting for them to add you back' : d.palAck === false ? 'they rejected the request' : "your request hasn't reached them yet");
  else if (d.leech) state = 'they added you · add them back to become mutuals';
  else state = 'not a pal';
  const btn = d.target
    ? '<button id="palbtn" data-act="del">Remove pal</button>'
    : `<button id="palbtn" class="primary" data-act="add">${d.leech ? 'Add back' : 'Add pal'}</button>`;
  return { button: btn, state: `<span class="${d.target || d.leech ? 'pal' : 'muted'}">${esc(state)}</span>` };
}

async function palAction(d, node, add) {
  const pb = $('palbtn'); if (pb) { pb.disabled = true; pb.textContent = add ? 'adding…' : 'removing…'; }
  try {
    const r = await fetch(`${API}/pal/${d.ship}`, { method: add ? 'POST' : 'DELETE', credentials: 'include' });
    if (!r.ok) throw new Error(r.status === 403 ? 'log in to manage pals' : 'failed (' + r.status + ')');
    cache.delete('/ship/' + d.ship); cache.delete('/pals');
    const n = node || T?.byName.get(d.ship);
    if (n) { n.target = add; prep(n); }
    legend(); sky.dirty = true; kick();
    await new Promise((res) => setTimeout(res, 800));
    const fresh = await cget('/ship/' + d.ship);
    if (panelFor === d.ship) renderPanel(fresh, n || null);
  } catch (e) { if (pb) { pb.disabled = false; pb.textContent = e.message; } }
}

// ---------------------------------------------------------------- live status
//
// Ames only knows what it last heard, so on its own a ship's status goes
// stale (a ship last heard two weeks ago reads "dead" forever). While the
// map is open we keep sending the booted ships on screen, plus the selected
// one, to /api/status. For the owner the agent probes any it hasn't heard
// from in five minutes (a remote scry it cancels after 20s; silent ships
// back off up to a day, and at most 50 are out at once) and the next
// reads pick up the answers. While answers are pending a radar sweep turns
// over the galaxy or star in view, and each result lands with a blip.

const AUTO_MAX = 400, AUTO_EVERY = 10000, AUTO_BUSY = 3000;
const auto = { on: true, n: 0, live: 0, dead: 0, checking: 0, busy: false, sig: '', k: 0 };
try { auto.on = localStorage.getItem('sextant-auto') !== '0'; } catch {}
const inView = () => sky.drawn.filter((n) => n.life !== 0 && n.ship !== me?.ship).slice(0, AUTO_MAX);

function scanHud() {
  const btn = $('scanbtn'), res = $('scanres');
  if (!btn) return;
  btn.textContent = auto.on ? 'Live status: on' : 'Live status: off';
  btn.title = auto.on
    ? 'Ships on screen are checked automatically: one small remote-scry request each, at most every 5 minutes (silent ships back off to once a day), cancelled after 20 seconds if unanswered. Click to pause.'
    : 'Paused: statuses are whatever your ship last heard. Click to check ships on screen automatically.';
  const where = sky.ctx ? sky.ctx.ship : 'network';
  res.innerHTML = auto.on && auto.n
    ? `${auto.checking ? `scanning ${esc(where)} · ${auto.checking} waiting · ` : ''}<b class="on">${auto.live} online</b> · ${auto.dead} offline · ${auto.n} in view`
    : '';
}

$('scanbtn').onclick = () => {
  auto.on = !auto.on;
  try { localStorage.setItem('sextant-auto', auto.on ? '1' : '0'); } catch {}
  if (!auto.on && held.size) { for (const [n, r] of held) applyResult(n, r); held.clear(); afterApply(true); }
  scanHud();
  if (auto.on) refreshStatus();
};

// called after every frame: when the set of ships on screen settles, re-check
function viewMoved() {
  if (!auto.on) return;
  const d = sky.drawn, sig = d.length + ':' + (d[0]?.ship || '') + ':' + (d[d.length - 1]?.ship || '') + ':' + (sky.sel?.ship || '');
  if (sig === auto.sig) return;
  auto.sig = sig;
  clearTimeout(auto.k);
  auto.k = setTimeout(refreshStatus, 800);
}

async function refreshStatus() {
  if (!auto.on || auto.busy || document.hidden || !T || $('explore').hidden) return;
  const ships = inView();
  if (sky.sel && !ships.includes(sky.sel)) ships.push(sky.sel);
  if (!ships.length) { auto.n = 0; scanHud(); return; }
  auto.busy = true;
  try {
    const r = await fetch(API + '/status', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(ships.map((n) => n.ship)),
    });
    if (!r.ok) return;
    const res = await r.json();
    let live = 0, dead = 0, checking = 0, now = false;
    const t = performance.now();
    for (const n of ships) {
      const v = res[n.ship];
      if (!v) continue;
      const [st, last, probing] = v;
      const h = held.get(n), was = h ? h.st : n.status, wasLast = h ? h.last : n.last;
      const moved = was !== st || wasLast !== last, answered = n.probing && !probing;
      seen.set(n.ship, { status: st, last, t: Date.now() });
      n.probing = probing;
      if (st === 'live') live++; else if (st === 'dead') dead++;
      if (probing) checking++;
      if (!moved && !answered) continue;
      // hand it to the sweep, unless there's no sweep to wait for
      if (reduceMotion) { applyResult(n, { st, last }); now = true; }
      else held.set(n, { st, last, t: h ? h.t : t });
    }
    Object.assign(auto, { n: ships.length, live, dead, checking });
    if (now) afterApply(true);
    if (held.size || checking) kick();
  } catch {} finally { auto.busy = false; scanHud(); }
}
// poll quickly while answers are pending, slowly otherwise
(function tick() {
  refreshStatus().finally(() => setTimeout(tick, auto.checking ? AUTO_BUSY : AUTO_EVERY));
})();

function dive(n) { if (opens(n)) location.hash = '#/' + n.ship; }
function up() {
  const p = sky.ctx?.parentNode;
  location.hash = p ? '#/' + p.ship : '#/';
}

async function ping(p) {
  const btn = $('ping'), out = $('pingres');
  btn.disabled = true; out.textContent = 'checking…';
  const labels = { yes: '✓ reachable', 'no-data': 'no data yet', 'no-dns': 'your ship has no DNS', 'no-our-galaxy': 'your galaxy is unreachable',
    'no-our-planet': 'your planet is unreachable', 'no-sponsor-hit': 'their sponsor sees them, but you can\'t', 'no-sponsor-miss': 'offline (their sponsor can\'t reach them either)',
    'no-their-galaxy': 'their galaxy is unreachable', crash: 'check crashed', 'setting-up': 'setting up…', 'trying-dns': 'checking DNS…', 'trying-local': 'checking your sponsor…',
    'trying-target': 'contacting ' + p + '…', 'trying-sponsor': 'asking their sponsor…' };
  try {
    const r0 = await fetch(`${API}/ping/${p}`, { method: 'POST', credentials: 'include' });
    if (r0.status === 403) { out.textContent = 'log in to run checks'; btn.disabled = false; return; }
    const t0 = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      const r = await get('/ping/' + p);
      out.textContent = labels[r.result] || r.result;
      if ((r.state === 'complete' && r.at >= t0 - 2000) || Date.now() - t0 > 60000) break;
    }
  } catch (e) { out.textContent = 'error: ' + e.message; }
  btn.disabled = false;
}

// ---------------------------------------------------------------- route tracer
//
// The hops a packet climbs from us to a ship: up our sponsor chain to where
// it meets theirs (or galaxy to galaxy), then down. Tracing probes every hop
// at once; the map draws the route and the panel says where it breaks.

let trace = null; // { ship, hops, t0, poll }
const LANE = { direct: 'direct', relayed: 'via relay', none: 'no address', mesa: 'mesa', unknown: '', self: '' };

function hopRole(h, i, hops) {
  if (h.lane === 'self') return 'you';
  if (i === hops.length - 1) return 'target';
  const g = h.kind === 'galaxy';
  if (h.side === 'us') return g ? 'your galaxy' : 'your sponsor';
  if (h.side === 'both') return g ? 'shared galaxy' : 'shared sponsor';
  return g ? 'their galaxy' : 'their sponsor';
}
// the first hop that has finished without answering, or -1
const breakAt = (hops) => hops.findIndex((h, i) => i > 0 && h.lane !== 'self' && !h.waiting && h.status !== 'live');

async function startTrace(ship) {
  stopTrace();
  const el = $('trace');
  if (el) el.innerHTML = '<div class="muted">tracing…</div>';
  const r = await fetch(`${API}/trace/${ship}`, { method: 'POST', credentials: 'include' }).catch(() => null);
  if (!r || !r.ok) { if (el) el.textContent = r && r.status === 403 ? 'log in to trace routes' : 'trace failed'; return; }
  trace = { ship, hops: await r.json(), t0: performance.now() };
  fitTrace(); renderTrace(); kick(); pollTrace();
}
function pollTrace() {
  const t = trace;
  if (!t) return;
  if (!t.hops.some((h) => h.waiting) || performance.now() - t.t0 > 30000) return;
  t.poll = setTimeout(async () => {
    try {
      const hops = await get('/trace/' + t.ship);
      if (trace !== t) return;
      t.hops = hops; landTrace(hops); renderTrace(); kick();
    } catch {}
    pollTrace();
  }, 1000);
}
function stopTrace() { if (trace) clearTimeout(trace.poll); trace = null; kick(); }

// what a trace learns about each hop is a real status: show it on the map
function landTrace(hops) {
  let any = false;
  for (const h of hops) {
    const n = T?.byName.get(h.ship);
    if (!n || h.waiting || (n.status === h.status && n.last === h.last)) continue;
    seen.set(h.ship, { status: h.status, last: h.last, t: Date.now() });
    applyResult(n, { st: h.status, last: h.last }); any = true;
  }
  if (any) afterApply(true);
}

// zoom out (or in) so every hop on the chart fits
function fitTrace() {
  const ns = trace.hops.map((h) => T?.byName.get(h.ship)).filter((n) => n && n.x != null);
  if (ns.length < 2) return;
  const xs = ns.map((n) => n.x), ys = ns.map((n) => n.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  flyTo((x0 + x1) / 2, (y0 + y1) / 2, fitZ(Math.max(x1 - x0, y1 - y0, 0.004) * 0.62));
}

function renderTrace() {
  const el = $('trace');
  if (!el || !trace || panelFor !== trace.ship) return;
  const hops = trace.hops, b = breakAt(hops), waiting = hops.filter((h) => h.waiting).length;
  const rows = hops.map((h, i) => {
    const bad = i === b, meta = h.waiting ? 'asking…' : [h.rtt != null ? h.rtt + 'ms' : h.status === 'live' ? '' : 'no answer', LANE[h.lane]].filter(Boolean).join(' · ');
    return `<div class="hop${bad ? ' bad' : ''}${h.waiting ? ' wait' : ''}">${h.lane === 'self' ? '<i class="dot live"></i>' : dot(h.waiting ? null : h.status)}<span class="role">${esc(hopRole(h, i, hops))}</span><a href="#/${esc(h.ship)}" title="${esc(h.ship)}">${esc(h.ship)}</a><span class="meta">${esc(meta)}</span></div>`;
  }).join('');
  let verdict = '', hi = null;
  const tgt = hops[hops.length - 1];
  if (waiting) verdict = `tracing… ${hops.length - 1 - waiting} of ${hops.length - 1} hops have answered`;
  else if (b < 0) verdict = `<b class="on">Route OK.</b> ${esc(tgt.ship)} answers${tgt.rtt != null ? ` in ${tgt.rtt}ms` : ''}.`;
  else {
    const h = hops[b], later = hops.slice(b + 1).find((x) => x.status === 'live');
    if (later) { verdict = `${esc(h.ship)} didn't answer, but ${esc(later.ship)} behind it did, so it's up. It has probably just never heard of your ship.`; hi = h.ship; }
    else if (h.lane === 'none' && h.kind === 'galaxy') verdict = `<b class="off">Breaks at ${esc(h.ship)}.</b> Your ship has no address for this galaxy (it has no DNS entry), so nothing under it can be reached from here.`;
    else if (b === hops.length - 1) verdict = `<b class="off">${esc(h.ship)} didn't answer.</b> Everything up to it is fine, so it's probably offline.`;
    else verdict = `<b class="off">Breaks at ${esc(h.ship)}</b> (${esc(hopRole(h, b, hops))}): no answer in 20s.`;
  }
  el.innerHTML = `<div class="hops">${rows}</div><p class="verdict">${verdict}</p>${hi ? `<button id="hibtn" title="Send ${esc(hi)} one hello, like |hi, so it learns of your ship">Say hi to ${esc(hi)}</button>` : ''}`;
  const hb = $('hibtn');
  if (hb) hb.onclick = async () => {
    hb.disabled = true; hb.textContent = 'saying hi…';
    const r = await fetch(`${API}/hi/${hi}`, { method: 'POST', credentials: 'include' }).catch(() => null);
    if (!r || !r.ok) { hb.textContent = r && r.status === 403 ? 'log in first' : 'failed'; return; }
    setTimeout(() => { if (trace && panelFor === trace.ship) startTrace(trace.ship); }, 2500);
  };
}

// the route on the map: solid up to the break, dashed after, a pulse
// running along the part that works, and a ring on every hop
function drawTrace(c, now) {
  const hops = trace.hops, b = breakAt(hops);
  const pts = [];
  hops.forEach((h, i) => {
    const n = T.byName.get(h.ship);
    if (!n || n.x == null) return;
    const [x, y] = toScreen(n.x, n.y);
    pts.push({ x, y, h, i, r: Math.max(n.sr || 0, 3) });
  });
  if (!pts.length) return;
  c.lineWidth = 2;
  for (let k = 1; k < pts.length; k++) {
    const p0 = pts[k - 1], p1 = pts[k], into = p1.i;
    const ok = b < 0 ? !p1.h.waiting : into < b;
    c.strokeStyle = ok ? P.live : into === b ? P.dead : P.muted;
    c.globalAlpha = ok ? 0.85 : 0.6;
    c.setLineDash(ok ? [] : [5, 5]);
    c.lineDashOffset = p1.h.waiting ? -now / 40 : 0;
    c.beginPath(); c.moveTo(p0.x, p0.y); c.lineTo(p1.x, p1.y); c.stroke();
  }
  c.setLineDash([]); c.lineDashOffset = 0;
  // pulse along the working stretch
  const good = pts.filter((p) => (b < 0 ? !p.h.waiting : p.i < b));
  if (good.length > 1 && !reduceMotion) {
    const seg = [];
    let L = 0;
    for (let k = 1; k < good.length; k++) { const d = Math.hypot(good[k].x - good[k - 1].x, good[k].y - good[k - 1].y); seg.push(d); L += d; }
    let at = ((now / 1800) % 1) * L, k = 0;
    while (k < seg.length - 1 && at > seg[k]) { at -= seg[k]; k++; }
    const f = seg[k] ? at / seg[k] : 0, a0 = good[k], a1 = good[k + 1];
    const x = a0.x + (a1.x - a0.x) * f, y = a0.y + (a1.y - a0.y) * f;
    c.globalAlpha = 1; c.fillStyle = P.live;
    c.beginPath(); c.arc(x, y, 3.5, 0, TAU); c.fill();
    c.globalAlpha = 0.25; c.beginPath(); c.arc(x, y, 8, 0, TAU); c.fill();
  }
  // hop rings and names
  c.font = '11px ui-monospace, "SF Mono", Menlo, monospace'; c.textAlign = 'left';
  const placed = [];
  for (const p of pts) {
    const w = p.h.waiting, col = w ? P.ink : p.h.status === 'live' ? P.live : P.dead;
    c.globalAlpha = w ? 0.4 + 0.4 * Math.sin(now / 200) : 0.9;
    c.strokeStyle = col; c.lineWidth = 1.5;
    c.beginPath(); c.arc(p.x, p.y, p.r + 5, 0, TAU); c.stroke();
    // name only the galaxies and the target, and never on top of another
    if (!(p.h.kind === 'galaxy' || p.i === hops.length - 1)) continue;
    if (placed.some(([x, y]) => Math.abs(x - p.x) < 90 && Math.abs(y - p.y) < 14)) continue;
    placed.push([p.x, p.y]);
    c.globalAlpha = 1; c.lineWidth = 3.5; c.strokeStyle = P.bg; c.lineJoin = 'round';
    const label = p.h.ship.length > 16 ? p.h.ship.slice(0, 14) + '…' : p.h.ship;
    c.strokeText(label, p.x + p.r + 9, p.y + 4); c.fillStyle = col; c.fillText(label, p.x + p.r + 9, p.y + 4);
  }
  c.globalAlpha = 1; c.lineWidth = 1;
}

// ---------------------------------------------------------------- feed
//
// Azimuth events as %azimuth reports them (breaches, first boots, key
// changes, escapes, transfers), and the ships the owner watches. New
// events pop up on the map; a finished escape glides the ship to its new
// sponsor. Pending escape requests are drawn as dashed arcs.

let WATCHED = null;      // ships we watch
let EVENTS = [], evNewest = 0;
const glides = [];
const EVICO = { breach: '⟲', keys: '⚿', sponsor: '⇢', escape: '↝', owner: '⇄', layer2: '②' };
const EVNAME = { breach: 'breaches', keys: 'keys & boots', escape: 'escape requests', sponsor: 'escapes done', owner: 'transfers', layer2: 'layer 2' };

async function toggleWatch(d, node) {
  const b = $('watchbtn'), add = !d.watched;
  b.disabled = true;
  const r = await fetch(`${API}/watch/${d.ship}`, { method: add ? 'POST' : 'DELETE', credentials: 'include' }).catch(() => null);
  b.disabled = false;
  if (!r || !r.ok) { b.textContent = r && r.status === 403 ? 'log in first' : 'failed'; return; }
  d.watched = add; cache.delete('/ship/' + d.ship);
  if (!WATCHED) WATCHED = new Set();
  add ? WATCHED.add(d.ship) : WATCHED.delete(d.ship);
  b.classList.toggle('on', add); b.textContent = add ? '★ Watching' : '☆ Watch';
  kick();
}

async function pollEvents() {
  try {
    const ev = await get('/events');
    const newest = ev[0]?.at || 0;
    if (evNewest && newest > evNewest) {
      for (const e of ev.filter((x) => x.at > evNewest).slice(0, 4).reverse()) { toast(e); glideFor(e); }
    }
    evNewest = Math.max(evNewest, newest) || newest;
    EVENTS = ev;
    if (location.hash === '#/feed') drawFeed();
  } catch {}
}
setInterval(() => { if (!document.hidden && me) pollEvents(); }, 60000);

function evLine(e) {
  return `<b>${esc(e.ship)}</b> ${esc(e.text)}`;
}
function toast(e) {
  const box = $('toasts');
  if (!box || $('explore').hidden) return;
  const a = document.createElement('a');
  a.className = 'toast'; a.href = '#/' + e.ship;
  a.innerHTML = `<span class="evico">${EVICO[e.what] || '•'}</span><span>${evLine(e)}</span>`;
  box.prepend(a);
  while (box.children.length > 4) box.lastChild.remove();
  setTimeout(() => { a.classList.add('out'); setTimeout(() => a.remove(), 700); }, 9000);
}
// a finished escape: the ship flies from where it sat to its new sponsor
function glideFor(e) {
  if (e.what !== 'sponsor' || !e.to || reduceMotion || !T) return;
  const n = T.byName.get(e.ship), h = T.byName.get(e.to);
  if (!n || !h || n.x == null || h.x == null) return;
  glides.push({ x0: n.x, y0: n.y, x1: h.x, y1: h.y, t0: performance.now(), n });
  kick();
}
function drawGlides(c, now) {
  for (let i = glides.length - 1; i >= 0; i--) {
    const g = glides[i], p = (now - g.t0) / 2600;
    if (p >= 1) { glides.splice(i, 1); continue; }
    const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    const [a0, b0] = toScreen(g.x0, g.y0), [a1, b1] = toScreen(g.x1, g.y1);
    const mx = (a0 + a1) / 2 - (b1 - b0) * 0.25, my = (b0 + b1) / 2 + (a1 - a0) * 0.25;
    const q = (t) => [(1 - t) * (1 - t) * a0 + 2 * (1 - t) * t * mx + t * t * a1, (1 - t) * (1 - t) * b0 + 2 * (1 - t) * t * my + t * t * b1];
    c.strokeStyle = P.accent; c.lineWidth = 1.5; c.globalAlpha = 0.5 * (1 - p);
    c.beginPath();
    for (let t = Math.max(0, e - 0.25); t <= e; t += 0.02) { const [x, y] = q(t); t === Math.max(0, e - 0.25) ? c.moveTo(x, y) : c.lineTo(x, y); }
    c.stroke();
    const [x, y] = q(e);
    c.globalAlpha = 1; c.fillStyle = P.accent;
    c.beginPath(); c.arc(x, y, 4, 0, TAU); c.fill();
  }
  c.globalAlpha = 1;
}
// pending escape requests: a dashed arc from the ship to where it asked to go
function drawEscapes(c) {
  c.save();
  c.strokeStyle = P.accent; c.lineWidth = 1.2; c.setLineDash([4, 4]);
  for (const n of sky.drawn) {
    if (!n.escape) continue;
    const h = T.byName.get(n.escape);
    if (!h || h.x == null) continue;
    const [a1, b1] = toScreen(h.x, h.y), a0 = n.sx, b0 = n.sy;
    const mx = (a0 + a1) / 2 - (b1 - b0) * 0.2, my = (b0 + b1) / 2 + (a1 - a0) * 0.2;
    c.globalAlpha = matches(n) ? 0.65 : 0.12;
    c.beginPath(); c.moveTo(a0, b0); c.quadraticCurveTo(mx, my, a1, b1); c.stroke();
    c.setLineDash([]); c.beginPath(); c.arc(a1, b1, 2.5, 0, TAU); c.fillStyle = P.accent; c.fill(); c.setLineDash([4, 4]);
  }
  c.restore();
}
// watched ships wear a small four-point marker
function drawWatched(c) {
  if (!WATCHED?.size) return;
  c.strokeStyle = P.accent; c.lineWidth = 1.3; c.globalAlpha = 0.9;
  for (const n of sky.drawn) {
    if (!WATCHED.has(n.ship)) continue;
    const r = n.sr + 7;
    c.beginPath();
    for (let q = 0; q < 4; q++) {
      const a = Math.PI / 4 + (q * TAU) / 4;
      c.moveTo(n.sx + Math.cos(a) * r, n.sy + Math.sin(a) * r);
      c.lineTo(n.sx + Math.cos(a) * (r + 4), n.sy + Math.sin(a) * (r + 4));
    }
    c.stroke();
  }
  c.globalAlpha = 1;
}

const feedUi = { kind: null };
async function feedView() {
  setTab('feed'); mapMode(false);
  crumbs.innerHTML = '<b>feed</b><span class="muted crumbnote">azimuth events, and the ships you watch</span>';
  const [w] = await Promise.all([get('/watch').catch(() => []), pollEvents()]);
  if (location.hash !== '#/feed') return;
  WATCHED = new Set(w.map((x) => x.ship));
  $('view').innerHTML = `<section class="card" id="wl"></section>
    <section class="card"><div class="lhead"><div class="ltitle"><h2>Azimuth events</h2><span class="count" id="evn"></span></div>
      <div class="chips" id="evk"></div></div>
      <div class="evrows" id="evr"></div></section>`;
  list($('wl'), 'Watching ★', w, 'Not watching any ships. Open a ship and click ☆ Watch to get a Landscape notification when it stops answering, comes back, or changes on Azimuth.');
  drawFeed();
}
function drawFeed() {
  const el = $('evr');
  if (!el) return;
  const counts = {};
  for (const e of EVENTS) counts[e.what] = (counts[e.what] || 0) + 1;
  $('evk').innerHTML = [`<button data-k="" class="${feedUi.kind ? '' : 'on'}">all <span>${EVENTS.length}</span></button>`,
    ...Object.keys(EVNAME).filter((k) => counts[k]).map((k) => `<button data-k="${k}" class="${feedUi.kind === k ? 'on' : ''}">${EVICO[k]} ${EVNAME[k]} <span>${counts[k]}</span></button>`)].join('');
  $('evk').querySelectorAll('[data-k]').forEach((b) => (b.onclick = () => { feedUi.kind = b.dataset.k || null; drawFeed(); }));
  const rows = EVENTS.filter((e) => !feedUi.kind || e.what === feedUi.kind);
  $('evn').textContent = rows.length ? `${rows.length} since this ship started listening` : '';
  el.innerHTML = rows.length ? rows.slice(0, 300).map((e) => `<a class="evrow${WATCHED?.has(e.ship) ? ' watched' : ''}" href="#/${esc(e.ship)}"><span class="t" title="${esc(new Date(e.at).toLocaleString())}">${esc(ago(e.at))}</span><span class="evico">${EVICO[e.what] || '•'}</span><span>${evLine(e)}</span></a>`).join('')
    : '<div class="evnote muted">Nothing yet. Sextant starts listening to %azimuth when it is installed, and new breaches, first boots, key changes, escapes and transfers show up here (and pop up on the map) as they happen.</div>';
}

async function ownerView(addr) {
  setTab(''); mapMode(false);
  const short = addr.slice(0, 6) + '…' + addr.slice(-4);
  crumbs.innerHTML = `<b>owner ${esc(short)}</b><span class="muted crumbnote">every point this address owns or is a proxy for</span>`;
  if (!/^0x[0-9a-f]{40}$/.test(addr)) { $('view').innerHTML = '<section class="card err">That isn\'t an Ethereum address.</section>'; return; }
  $('view').innerHTML = '<section class="card"><div class="muted evnote">scanning azimuth…</div></section>';
  const pts = await get('/owner/' + addr);
  if (location.hash !== '#/owner/' + addr) return;
  const by = (k) => pts.filter((p) => p.kind === k).length;
  const owns = pts.filter((p) => p.roles.includes('owner')).length;
  $('view').innerHTML = `<section class="card"><div class="ownhead">
      <code>${esc(addr)}</code>
      <span class="stats">${owns} owned · ${pts.length - owns} as proxy only · ${['galaxy', 'star', 'planet'].map((k) => `${by(k)} ${k}${by(k) === 1 ? '' : 's'}`).join(' · ')}</span>
      <button id="ownmap" ${pts.length ? '' : 'disabled'}>Highlight on the map</button>
      <a href="https://etherscan.io/address/${esc(addr)}" target="_blank" rel="noopener noreferrer">Etherscan ↗</a>
    </div><div id="ol"></div></section>`;
  list($('ol'), 'Points', pts, 'This address controls no points.');
  $('ownmap').onclick = () => {
    OWNER = addr; OWNED = new Set(pts.map((p) => p.ship)); OWNED_HOSTS = new Set();
    for (const p of pts) for (let h = p.sponsor || p.parent; h; ) { if (OWNED_HOSTS.has(h)) break; OWNED_HOSTS.add(h); const n = T?.byName.get(h); h = n?.parentNode?.ship; }
    sky.dirty = true;
    location.hash = '#/';
    setTimeout(legend, 300);
  };
}

// ---------------------------------------------------------------- list view

const shortAgo = (ms) => (ms ? ago(ms).replace(' ago', '') : '');
function row(s) {
  const cold = s.life === 0 || (s.life == null && !s.status);
  const pal = s.target && s.leech ? '<span class="pals" title="mutual pal">★</span>' : s.target || s.leech ? '<span class="pals" title="pal">☆</span>' : '';
  const meta = s.life === 0 ? 'no keys' : (s.status === 'live' || s.status === 'stale') && s.last ? shortAgo(s.last) : (s.kind === 'star' && s.n ? s.n.toLocaleString() + 'p' : '');
  return `<a class="row${cold ? ' cold' : ''}${s.adopted ? ' adopted' : ''}" href="#/${esc(s.ship)}" data-ship="${esc(s.ship)}" title="${esc(s.ship)}${s.adopted ? ' · adopted from ' + esc(s.origin) : ''}">${dot(s.status)}<span class="nm">${esc(s.ship)}</span>${pal}<span class="meta">${esc(meta)}</span></a>`;
}

function list(el, title, ships, emptyMsg) {
  const filters = { all: () => true, live: (s) => s.status === 'live', booted: (s) => s.life > 0, pals: (s) => s.target || s.leech };
  let mode = 'all', cap = RENDER_CAP;
  const draw = () => {
    const rows = ships.filter(filters[mode]);
    const live = ships.filter(filters.live).length;
    el.innerHTML = `
      <div class="lhead">
        <div class="ltitle"><h2>${esc(title)}</h2><span class="count">${rows.length.toLocaleString()}${live ? ` · <b class="on">${live} live</b>` : ''}</span></div>
        <div class="seg" role="tablist">${Object.keys(filters).map((f) => `<button role="tab" data-f="${f}" class="${f === mode ? 'on' : ''}" aria-selected="${f === mode}">${f}</button>`).join('')}</div>
      </div>
      <div class="rows">${rows.length ? rows.slice(0, cap).map(row).join('') : `<div class="empty">${esc(emptyMsg)}</div>`}
      ${rows.length > cap ? `<button class="more">show ${Math.min(RENDER_CAP, rows.length - cap)} more of ${(rows.length - cap).toLocaleString()}</button>` : ''}</div>`;
    el.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => { mode = b.dataset.f; cap = RENDER_CAP; draw(); }));
    const more = el.querySelector('.more');
    if (more) more.onclick = () => { cap += RENDER_CAP; draw(); };
  };
  draw();
  // hovering a row lights the ship up on the map
  el.onmouseover = (e) => {
    const r = e.target.closest('.row'); const n = r && T?.byName.get(r.dataset.ship);
    if (n !== sky.hover) { sky.hover = n && !n.hidden ? n : null; kick(); }
  };
  el.onmouseleave = () => { if (sky.hover) { sky.hover = null; kick(); } };
}

let listedFor;
function listFor(ctx) {
  if (listedFor === ctx && (!ctx || ctx.loaded || ctx.kind === 'galaxy')) return;
  listedFor = ctx;
  if (!ctx) list($('list'), 'Galaxies', T.gals, 'none');
  else if (ctx.kind === 'galaxy') list($('list'), `Ships sponsored by ${ctx.ship}`, ctx.kids, 'Sponsors nothing.');
  else list($('list'), `Planets sponsored by ${ctx.ship}`, ctx.kids, ctx.loaded || !ctx.n ? 'Sponsors no planets.' : 'Zoom in to load its planets.');
}

// ---------------------------------------------------------------- routing

function setTab(t) { document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === t)); }
function mapMode(on) { $('explore').hidden = !on; $('view').hidden = on; if (on) resize(); }
const overlay = (msg) => { $('loading').hidden = !msg; if (msg) $('loading').textContent = msg; };

async function ensureTree() {
  if (T) return;
  overlay('reading the sponsorship tree from azimuth…');
  T = buildTree(await get('/tree'));
  overlay(null);
  legend();
  loadPeers();
  sky.dirty = true; kick();
}

// find a ship on the chart, loading its sponsor's planets if needed
async function locate(name) {
  if (T.byName.has(name)) return T.byName.get(name);
  const d = await cget('/ship/' + name);
  if (d.kind === 'planet' && d.sponsor && T.byName.has(d.sponsor)) {
    const sp = T.byName.get(d.sponsor);
    if (!sp.loaded) { loading.clear(); await ensureKids(sp); }
    return T.byName.get(name) || null;
  }
  if ((d.kind === 'moon' || d.kind === 'comet') && d.parent) return locate(d.parent);
  return null;
}

let firstRoute = true;
async function route() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  try {
    if (!me) {
      me = await get('/me');
      $('host').textContent = 'via ' + me.ship + (me.public ? ' · public' : '');
      try { const mine = await get('/ship/' + me.ship); myChain = new Set(mine.chain); } catch {}
    }
    if (h === 'pals') return await pals();
    if (h === 'peers') return await peers();
    if (h === 'apps') return await appsView();
    if (h === 'feed') return await feedView();
    if (h.startsWith('owner/')) return await ownerView(h.slice(6).toLowerCase());
    if (!WATCHED) { try { WATCHED = new Set((await get('/watch')).map((x) => x.ship)); } catch { WATCHED = new Set(); } }
    if (!evNewest) pollEvents();
    setTab('net'); mapMode(true);
    await ensureTree();
    const instant = firstRoute; firstRoute = false;
    if (!h.startsWith('~')) { select(null); flyToNode(null, instant); return; }
    const n = await locate(h);
    if (n && n.hidden) {
      flyToNode(n.parentNode, instant);
      sky.sel = null; panelFor = h;
      renderPanel(await cget('/ship/' + h), null);
    } else if (n) {
      flyToNode(n, instant);
      if (n.ship === h && !opens(n)) select(n); else if (sky.sel && sky.sel.ship !== h) select(null);
    } else {
      sky.sel = null; panelFor = h;
      renderPanel(await cget('/ship/' + h));
    }
  } catch (e) {
    overlay(null);
    if (e.message !== 'login') { mapMode(false); $('view').innerHTML = `<section class="card err">Couldn't load: ${esc(e.message)}</section>`; }
  }
}

async function pals() {
  setTab('pals'); mapMode(false); crumbs.innerHTML = '<b>%pals</b>';
  if (!me?.pals) { $('view').innerHTML = `<section class="card empty">%pals isn't running on ${esc(me?.ship)}. Install it with <code>|install ~paldev %pals</code>.</section>`; return; }
  const ps = await cget('/pals', 15000);
  $('view').innerHTML = '<section class="card" id="m"></section><section class="card" id="o"></section><section class="card" id="i"></section>';
  list($('m'), 'Mutuals ★', ps.filter((s) => s.target && s.leech), 'No mutual pals yet.');
  list($('o'), 'You added (waiting on them)', ps.filter((s) => s.target && !s.leech), 'none');
  list($('i'), 'Added you (pending)', ps.filter((s) => s.leech && !s.target), 'none');
}

async function peers() {
  setTab('peers'); mapMode(false); crumbs.innerHTML = '<b>ships ' + esc(me?.ship) + ' knows</b>';
  const ps = await cget('/peers', 15000);
  ps.sort((a, b) => (b.status === 'live') - (a.status === 'live') || (b.last || 0) - (a.last || 0));
  $('view').innerHTML = '<section class="card" id="p"></section>';
  list($('p'), 'Peers', ps, 'No peers yet.');
}

// ---------------------------------------------------------------- apps
//
// Every app our ship knows is published anywhere, via %treaty: from the
// publishers it follows (allies), including any added here.

const appsUi = { q: '', by: null, hideHave: false, poll: 0, sort: 'popular' };
try { appsUi.sort = localStorage.getItem('sextant-appsort') || 'popular'; } catch {}
// trending: every install counts 1 now, halving each day after
const trend = (ats) => ats.reduce((t, at) => t + Math.pow(0.5, Math.max(0, Date.now() - at) / 86400000), 0);
// treaty apps and gossiped hits, merged by publisher/desk
function mergeApps(c) {
  const by = new Map();
  for (const a of c.apps) by.set(a.ship + '/' + a.desk, { ...a, n: 0, at: [], mine: false });
  for (const h of c.hits || []) {
    const k = h.ship + '/' + h.desk, a = by.get(k);
    if (a) Object.assign(a, { n: h.n, at: h.at, mine: h.mine });
    else by.set(k, { ...h, heard: true });
  }
  for (const a of by.values()) a.t = trend(a.at);
  return [...by.values()];
}
async function appsView() {
  setTab('apps'); mapMode(false); crumbs.innerHTML = '<b>apps on the network</b><span class="muted crumbnote">as %treaty knows them</span>';
  clearTimeout(appsUi.poll);
  let c;
  try { c = await get('/catalog'); } catch (e) { $('view').innerHTML = `<section class="card err">${esc(e.message)}</section>`; return; }
  if (location.hash !== '#/apps') return;
  if (!c.treaty) { $('view').innerHTML = '<section class="card empty">%treaty isn\'t running on this ship (it comes with %landscape).</section>'; return; }
  const fresh = !$('appq');
  if (fresh) {
    $('view').innerHTML = `<section class="card appdir">
      <div class="lhead">
        <div class="ltitle"><h2>Apps</h2><span class="count" id="appn"></span></div>
        <form id="allyform" class="allyform" autocomplete="off">
          <input id="allyq" placeholder="add a publisher: ~sampel-palnet" spellcheck="false" aria-label="Publisher to add">
          <button>Add</button>
        </form>
      </div>
      <div class="appfilters">
        <input id="appq" type="search" placeholder="search apps" spellcheck="false" aria-label="Search apps">
        <div class="seg" role="tablist" id="appsort">
          <button data-s="popular">popular</button><button data-s="trending">trending</button><button data-s="az">a–z</button>
        </div>
        <label class="muted"><input type="checkbox" id="apphave"> hide installed</label>
      </div>
      <div class="sharerow muted"><label><input type="checkbox" id="appshare"> share my installs</label>
        <span>Install counts come from mutual pals running sextant, and their pals (2 hops), like %hits. Each install is anonymous; only apps installed from a publisher count.</span></div>
      <div class="chips" id="appby"></div>
      <div class="appnote muted" id="appnote"></div>
      <div class="appgrid" id="appgrid"></div>
    </section>`;
    $('appq').oninput = (e) => { appsUi.q = e.target.value.toLowerCase(); drawApps(appsUi.cat); };
    $('apphave').onchange = (e) => { appsUi.hideHave = e.target.checked; drawApps(appsUi.cat); };
    $('appsort').querySelectorAll('[data-s]').forEach((b) => (b.onclick = () => {
      appsUi.sort = b.dataset.s;
      try { localStorage.setItem('sextant-appsort', appsUi.sort); } catch {}
      drawApps(appsUi.cat);
    }));
    $('appshare').onchange = async (e) => {
      const on = e.target.checked;
      const r = await fetch(`${API}/share/${on ? 'on' : 'off'}`, { method: 'POST', credentials: 'include' }).catch(() => null);
      if (!r || !r.ok) { e.target.checked = !on; $('appnote').textContent = r && r.status === 403 ? 'log in to change sharing' : 'failed'; }
    };
    $('allyform').onsubmit = (e) => { e.preventDefault(); addPublisher(normalize($('allyq').value)); };
  }
  $('apphave').checked = appsUi.hideHave; $('appq').value = appsUi.q; $('appshare').checked = !!c.share;
  appsUi.cat = c;
  drawApps(c);
}
function drawApps(c) {
  const name = (a) => a.title || a.desk;
  const order = {
    popular: (a, b) => b.n - a.n || b.t - a.t || name(a).localeCompare(name(b)),
    trending: (a, b) => b.t - a.t || b.n - a.n || name(a).localeCompare(name(b)),
    az: (a, b) => name(a).localeCompare(name(b)),
  }[appsUi.sort] || ((a, b) => b.n - a.n);
  $('appsort').querySelectorAll('[data-s]').forEach((b) => b.classList.toggle('on', b.dataset.s === appsUi.sort));
  const apps = mergeApps(c).sort(order);
  const pubs = new Map();
  for (const a of apps) pubs.set(a.ship, (pubs.get(a.ship) || 0) + 1);
  for (const al of c.allies) if (!pubs.has(al.ship)) pubs.set(al.ship, 0);
  if (appsUi.by && !pubs.has(appsUi.by)) appsUi.by = null;
  $('appby').innerHTML = [`<button data-by="" class="${appsUi.by ? '' : 'on'}">all <span>${apps.length}</span></button>`,
    ...[...pubs].sort((a, b) => b[1] - a[1]).map(([s, n]) => `<button data-by="${esc(s)}" class="${appsUi.by === s ? 'on' : ''}">${esc(s)} <span>${n}</span></button>`)].join('');
  $('appby').querySelectorAll('[data-by]').forEach((b) => (b.onclick = () => { appsUi.by = b.dataset.by || null; drawApps(c); }));
  const q = appsUi.q;
  const shown = apps.filter((a) => (!appsUi.by || a.ship === appsUi.by) && (!appsUi.hideHave || !a.installed)
    && (!q || [a.title, a.desk, a.info, a.ship].some((x) => (x || '').toLowerCase().includes(q))));
  const heard = apps.reduce((t, a) => t + a.n, 0);
  $('appn').textContent = `${shown.length} of ${apps.length} · ${pubs.size} publishers · ${heard} installs heard of`;
  const el = $('appgrid');
  el.innerHTML = shown.length ? shown.map((a, i) => appCard(a, true, appsUi.sort === 'az' ? 0 : i + 1)).join('') : `<div class="empty">${apps.length ? 'No apps match.' : 'No apps yet. Add a publisher above to see what it offers.'}</div>`;
  wireApps(el);
}
// follow a publisher through %treaty, then wait for its apps to arrive
async function addPublisher(ship) {
  const note = $('appnote');
  if (!ship) { note.textContent = 'enter a ship name, like ~paldev'; return; }
  note.textContent = `asking ${ship} for its apps…`;
  const r = await fetch(`${API}/apps/${ship}`, { method: 'POST', credentials: 'include' }).catch(() => null);
  if (!r || !r.ok) { note.textContent = r && r.status === 403 ? 'log in to add publishers' : 'failed'; return; }
  $('allyq').value = '';
  const until = Date.now() + 60000;
  const tick = async () => {
    if (location.hash !== '#/apps') return;
    try {
      const c = await get('/catalog');
      appsUi.cat = c;
      const n = c.apps.filter((a) => a.ship === ship).length;
      if (n) { appsUi.by = ship; note.textContent = `${ship} publishes ${n} app${n === 1 ? '' : 's'}`; drawApps(c); return; }
      drawApps(c);
    } catch {}
    if (Date.now() < until) appsUi.poll = setTimeout(tick, 3000);
    else note.textContent = `${ship} hasn't answered. It may be offline, or publish nothing.`;
  };
  tick();
}

function normalize(q) {
  q = q.trim().toLowerCase().replace(/^~?/, '~').replace(/\s+/g, '');
  return /^~[a-z-]+$/.test(q) ? q : null;
}
// ---------------------------------------------------------------- search

// suggestions: galaxies, sponsored stars and loaded planets from the tree,
// plus pals and peers. Prefix matches first, then booted, then live ships.
const sugg = { el: $('sugg'), q: $('q'), items: [], i: -1 };
function suggest() {
  const raw = sugg.q.value.trim().toLowerCase().replace(/^~/, '').replace(/\s+/g, '');
  if (!raw || !/^[a-z-]+$/.test(raw)) return hideSugg();
  const seen = new Set(), out = [];
  const consider = (name, n) => {
    if (seen.has(name)) return;
    const bare = name.slice(1), at = bare.indexOf(raw);
    if (at < 0 || (at > 0 && raw.length < 3)) return;
    seen.add(name);
    out.push({ name, n, score: (at === 0 ? 0 : 10) + (n && n.life > 0 ? 0 : 3) + (n && n.status === 'live' ? -1 : 0) + bare.length / 100 });
  };
  if (T) for (const [name, n] of T.byName) consider(name, n);
  for (const [name, p] of PEERS) consider(name, T?.byName.get(name) || p);
  for (const p of cache.get('/pals')?.v || []) consider(p.ship, T?.byName.get(p.ship) || p);
  out.sort((a, b) => a.score - b.score);
  sugg.items = out.slice(0, 8);
  const typed = normalize(sugg.q.value);
  if (typed && !seen.has(typed)) sugg.items.push({ name: typed, n: null, go: true });
  sugg.i = sugg.items.length ? 0 : -1;
  renderSugg();
}
function renderSugg() {
  if (!sugg.items.length) return hideSugg();
  sugg.el.innerHTML = sugg.items.map((it, i) => {
    const n = it.n, kind = n?.kind || '', where = n?.parentNode?.ship || n?.sponsor || '';
    return `<div class="srow${i === sugg.i ? ' on' : ''}" role="option" aria-selected="${i === sugg.i}" data-i="${i}">${it.go ? '<span class="sgo">go to</span>' : dot(n?.status)}<span class="nm">${esc(it.name)}</span>${n?.pal ? '<span class="pals">☆</span>' : ''}<span class="meta">${esc(kind)}${where && kind !== 'galaxy' ? ' · ' + esc(where) : ''}</span></div>`;
  }).join('');
  sugg.el.hidden = false; sugg.q.setAttribute('aria-expanded', 'true');
}
function hideSugg() { sugg.items = []; sugg.i = -1; sugg.el.hidden = true; sugg.q.setAttribute('aria-expanded', 'false'); }
function pickSugg(i) {
  const it = sugg.items[i];
  if (!it) return;
  hideSugg(); sugg.q.value = ''; sugg.q.blur();
  location.hash = '#/' + it.name;
}
sugg.q.addEventListener('input', suggest);
sugg.q.addEventListener('focus', suggest);
sugg.q.addEventListener('blur', () => setTimeout(hideSugg, 150));
sugg.q.addEventListener('keydown', (e) => {
  if (sugg.el.hidden) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    sugg.i = (sugg.i + (e.key === 'ArrowDown' ? 1 : -1) + sugg.items.length) % sugg.items.length;
    renderSugg();
  } else if (e.key === 'Escape') hideSugg();
});
sugg.el.addEventListener('mousedown', (e) => { const r = e.target.closest('.srow'); if (r) { e.preventDefault(); pickSugg(+r.dataset.i); } });
$('search').onsubmit = (e) => {
  e.preventDefault();
  if (sugg.i >= 0 && !sugg.el.hidden) return pickSugg(sugg.i);
  const addr = $('q').value.trim().toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(addr)) { hideSugg(); $('q').value = ''; location.hash = '#/owner/' + addr; return; }
  const p = normalize($('q').value);
  if (p) { hideSugg(); $('q').value = ''; location.hash = '#/' + p; }
};

// keep it live: re-read the tree every 5 minutes without moving the view
setInterval(async () => {
  if (!T || document.hidden || $('explore').hidden) return;
  try {
    const raw = await get('/tree');
    const selName = sky.sel?.ship, ctxName = sky.ctx?.ship;
    for (const k of [...cache.keys()]) if (k.startsWith('/residents/')) cache.delete(k);
    T = buildTree(raw);
    cache.delete('/peers'); loadPeers();
    sky.ctx = null; sky.hover = null;
    sky.sel = selName ? T.byName.get(selName) || null : null;
    legend(); sky.dirty = true; kick();
    void ctxName;
  } catch {}
}, 5 * 60 * 1000);

const crumbs = $('crumbs');
readPalette();
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { readPalette(); sky.dirty = true; kick(); });
new ResizeObserver(resize).observe(sky.stage);
window.addEventListener('hashchange', route);
route();
