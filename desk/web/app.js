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
const statusText = (st) => ({ live: 'live route', dead: 'unreachable', unborn: 'pending', null: 'never contacted' }[st] ?? 'never contacted');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------------------------------------------------------------- classes

function cls(s) {
  if (s.status === 'live') return 'live';
  if (s.status === 'dead') return 'dead';
  if (s.status === 'unborn') return 'unborn';
  if (s.life === 0) return 'cold';
  return 'keyed';
}
const isPal = (s) => !!(s.target || s.leech);
const CLASSES = [
  ['live', 'live route'], ['dead', 'unreachable'], ['unborn', 'pending'],
  ['keyed', 'booted, not contacted'], ['cold', 'spawned, never booted'], ['pal', '%pals'],
];
const PRI = { cold: 0, keyed: 1, unborn: 2, dead: 3, live: 4 };
const SIZE = { cold: 0.7, keyed: 0.9, unborn: 1, dead: 1, live: 1.15 };

let P = {};
function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (k) => cs.getPropertyValue('--' + k).trim();
  P = {
    bg: v('sky-bg'), ring: v('sky-ring'), slot: v('sky-slot'), dust: v('sky-dust'),
    keyed: v('sky-keyed'), cold: v('sky-cold'), live: v('live'), dead: v('dead'),
    unborn: v('unborn'), accent: v('accent'), ink: v('ink'), muted: v('muted'),
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

const ST = [null, 'live', 'dead', 'unborn'];
let T = null; // { gals, byName, guide }

function buildTree(raw) {
  T0 = raw.g; GALAXY_BY_SUFFIX.clear();
  const byName = new Map();
  const gals = raw.g.map((r, i) => ({
    ship: r[0], kind: 'galaxy', idx: i, status: ST[r[1]], life: r[2] < 0 ? null : r[2],
    target: !!(r[3] & 1), leech: !!(r[3] & 2), ns: r[4], np: r[5], kids: [], allStars: [], allPlanets: [], parentNode: null,
  }));
  for (const r of raw.s) {
    const g = gals[r[1]];
    g.allStars.push({ ship: r[0], kind: 'star', idx: r[2], status: ST[r[3]], life: r[4] < 0 ? null : r[4],
      target: !!(r[5] & 1), leech: !!(r[5] & 2), n: r[6], kids: [], allPlanets: [], parentNode: g,
      origin: gals[hash8(r[0])]?.ship });
  }
  const G = spiral(256, ...SP.galaxy);
  for (const g of gals) {
    g.x = G.pos[2 * g.idx]; g.y = G.pos[2 * g.idx + 1]; g.R = G.d * DISC;
    g.n = g.ns + g.np;
    byName.set(g.ship, g);
    for (const s of g.allStars) byName.set(s.ship, s);
  }
  for (const n of byName.values()) prep(n);
  for (const g of gals) layoutNode(g);
  return { gals, byName, guide: G.pos };
}

// Never-booted ships (life 0: spawned on Azimuth but no keys ever set) are
// hidden unless the legend toggle shows them. Re-lay a host's visible
// children, and their children in turn, since those hang off their position.
let showCold = false;
try { showCold = localStorage.getItem('sextant-show-cold') === '1'; } catch {}
function layoutNode(node) {
  const all = [...(node.allStars || []), ...(node.allPlanets || [])];
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
  if (n.kind === 'galaxy') return n.kids.length > 0 || (n.np > 0 && !n.loaded);
  if (n.kind === 'star') return n.loaded ? n.kids.length > 0 : n.n > 0;
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
function prep(n) {
  n.c = cls(n); n.pal = isPal(n); n.mine = myChain.has(n.ship);
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
    for (const p of ps) { p.parentNode = node; p.kids = []; prep(p); T.byName.set(p.ship, p); }
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
  if (n.kind === 'galaxy') return Math.min(34, Math.max(Math.min(discPx * 0.4, 6.5), discPx * 0.16));
  if (n.kind === 'star') return Math.min(22, Math.max(1, Math.min(discPx * 0.42, 4.5), discPx * 0.15));
  return Math.min(11, Math.max(1.4, discPx * 0.42));
}
const OPEN = 46; // a disc opens once it is this many px in radius

function resize() {
  const r = sky.stage.getBoundingClientRect();
  sky.dpr = Math.min(2, window.devicePixelRatio || 1);
  sky.w = Math.max(1, r.width); sky.h = Math.max(1, r.height);
  for (const c of [sky.canvas, sky.base]) { c.width = Math.round(sky.w * sky.dpr); c.height = Math.round(sky.h * sky.dpr); }
  sky.canvas.style.width = sky.w + 'px'; sky.canvas.style.height = sky.h + 'px';
  sky.dirty = true; kick();
}

function matches(n) {
  if (!sky.focus) return true;
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

  // graduated rim around the whole network
  const R = 1.05 * k;
  if (R < Math.hypot(w, h) * 3) {
    c.strokeStyle = P.ring; c.lineWidth = 1;
    c.beginPath(); c.arc(ox, oy, R, 0, TAU); c.stroke();
    c.beginPath(); c.arc(ox, oy, R + 14, 0, TAU); c.stroke();
    c.beginPath();
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * TAU - Math.PI / 2, len = i % 8 === 0 ? 14 : i % 2 === 0 ? 7 : 3.5;
      c.moveTo(ox + Math.cos(a) * R, oy + Math.sin(a) * R);
      c.lineTo(ox + Math.cos(a) * (R + len), oy + Math.sin(a) * (R + len));
    }
    c.stroke();
  }
  // the galaxy spiral
  drawGuide(c, T.guide, 256, 0, 0, 1, 1);

  const later = [];
  for (const g of T.gals) {
    const [sx, sy] = toScreen(g.x, g.y), Rpx = g.R * k;
    if (!onScreen(sx, sy, Rpx)) continue;
    if (Rpx > OPEN && openable(g)) drawContainer(c, g, sx, sy, Rpx, later);
    if (Rpx > OPEN * 4 && g.np && !g.loaded) ensureKids(g);
    later.push([g, sx, sy, dotPx(g, Rpx), 1]);
  }
  // kids first, hubs on top
  for (const [n, sx, sy, r, a] of later) drawNode(c, n, sx, sy, r, a);
  drawLabels(c);
  updateContext();
  if (!scan || !scan.running) scanHud();
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
  const a = clamp((Rpx - OPEN) / 70, 0, 1);
  const k = pxScale();
  c.strokeStyle = P.ring; c.lineWidth = 1;
  c.globalAlpha = 0.6 * a; c.beginPath(); c.arc(sx, sy, Rpx, 0, TAU); c.stroke();
  const L = node.layout;
  if (L && node.slotKids) {
    c.strokeStyle = P.slot; c.lineWidth = 1.2; c.globalAlpha = a;
    c.beginPath();
    if (!L.m) {
      // a handful of children: one even orbit, with a short spoke to each
      c.arc(sx, sy, L.ring * Rpx, 0, TAU);
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
    if (kid.kind === 'star' && kr > OPEN && openable(kid)) drawContainer(c, kid, x, y, kr, later);
    later.push([kid, x, y, dotPx(kid, kr), a]);
  }
}

function drawNode(c, n, sx, sy, r, alpha) {
  r *= SIZE[n.c];
  const a = (matches(n) ? 1 : 0.1) * alpha, col = P[n.c];
  if (a <= 0.01) return;
  if (n.c === 'live' || n.c === 'dead' || n.c === 'unborn') {
    c.globalAlpha = 0.18 * a; c.fillStyle = col;
    c.beginPath(); c.arc(sx, sy, r + Math.min(r * 1.6, 9), 0, TAU); c.fill();
  }
  c.globalAlpha = a; c.fillStyle = col;
  c.beginPath(); c.arc(sx, sy, r, 0, TAU); c.fill();
  if (n.pal) { c.strokeStyle = P.accent; c.lineWidth = 1.2; c.beginPath(); c.arc(sx, sy, r + 2.5, 0, TAU); c.stroke(); }
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

// greedy label placement: reserve every dot, then name the most interesting
// ships first and skip any name that would collide
function drawLabels(c) {
  const { w, h } = sky, CW = 6, cols = Math.floor(w / CW), rows = Math.floor(h / CW);
  const occ = new Uint8Array(cols * rows);
  const span = (x, y, tw, th) => [Math.floor(x / CW), Math.floor((x + tw) / CW), Math.floor(y / CW), Math.floor((y + th) / CW)];
  const mark = (x, y, tw, th) => {
    const [c0, c1, r0, r1] = span(x, y, tw, th);
    for (let r = Math.max(0, r0); r <= Math.min(rows - 1, r1); r++) for (let q = Math.max(0, c0); q <= Math.min(cols - 1, c1); q++) occ[r * cols + q] = 1;
  };
  const tryPlace = (x, y, tw, th) => {
    const [c0, c1, r0, r1] = span(x, y, tw, th);
    if (c0 < 0 || r0 < 0 || c1 >= cols || r1 >= rows) return false;
    for (let r = r0; r <= r1; r++) for (let q = c0; q <= c1; q++) if (occ[r * cols + q]) return false;
    mark(x, y, tw, th);
    return true;
  };
  const text = (t, x, y) => { c.lineWidth = 3.5; c.strokeStyle = P.bg; c.lineJoin = 'round'; c.strokeText(t, x, y); c.fillText(t, x, y); };
  // big hubs (open galaxies and stars) are named first, centred under the
  // hub, so their own children's dots can't crowd the name out
  const hubs = sky.drawn.filter((n) => n.sr > 10 && matches(n)).sort((a, b) => b.sr - a.sr);
  c.font = '600 12px ui-monospace, "SF Mono", Menlo, monospace'; c.textAlign = 'center';
  for (const n of hubs) {
    const tw = n.ship.length * 7.3, y = n.sy + n.sr + 6;
    if (!tryPlace(n.sx - tw / 2, y, tw, 14)) continue;
    c.globalAlpha = 1; c.fillStyle = n.pal || n.mine ? P.accent : P.ink;
    text(n.ship, n.sx, y + 11);
  }
  c.textAlign = 'left';
  for (const n of sky.drawn) mark(n.sx - n.sr - 1, n.sy - n.sr - 1, 2 * n.sr + 2, 2 * n.sr + 2);
  const named = new Set(hubs);
  const order = [...sky.drawn].sort((a, b) => (b === sky.sel) - (a === sky.sel) || b.mine - a.mine || b.pal - a.pal || b.sr - a.sr || PRI[b.c] - PRI[a.c]);
  let placed = 0;
  for (const n of order) {
    if (placed > 400) break;
    if (named.has(n) || n.sr > 10 || !matches(n) || (n.sr < 2.2 && n !== sky.sel)) continue;
    const big = n.sr > 12;
    c.font = big ? '600 12px ui-monospace, "SF Mono", Menlo, monospace' : '10.5px ui-monospace, "SF Mono", Menlo, monospace';
    // start one grid cell past the dot's own reserved cells
    const tw = n.ship.length * (big ? 7.3 : 6.4), x = n.sx + n.sr + CW + 1, y = n.sy - 7;
    if (!tryPlace(x, y, tw, 13)) continue;
    c.globalAlpha = n.c === 'cold' ? 0.5 : n.c === 'keyed' ? 0.8 : 1;
    c.fillStyle = n.pal || n.mine ? P.accent : n.c === 'live' ? P.live : P.ink;
    text(n.ship, x, n.sy + 4);
    placed++;
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
  if (n.kind === 'planet') return flyTo(n.x, n.y, fitZ(n.R * 7), instant);
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
  el.innerHTML = `<b>${esc(n.ship)}</b><span>${esc(n.kind)} · ${esc(n.life === 0 ? 'never booted' : statusText(n.status))}${n.status && n.last ? ' · ' + ago(n.last) : ''}</span><span>${esc(spon)}</span>${n.adopted ? `<span class="pal">adopted · spawned under ${esc(n.origin)}</span>` : ''}${n.scanned ? `<span>scan: ${esc({ yes: 'online', 'no-sponsor-hit': 'online (reachable via its sponsor)', 'no-sponsor-miss': 'offline', 'no-their-galaxy': 'unknown (its galaxy is unreachable)', timeout: 'no answer in 45s' }[n.scanned] || n.scanned)}</span>` : ''}${rel ? `<span class="pal">${rel}</span>` : ''}`;
  el.hidden = false;
  const x = Math.min(pt[0] + 14, sky.w - el.offsetWidth - 8), y = pt[1] + 16 + el.offsetHeight > sky.h ? pt[1] - el.offsetHeight - 10 : pt[1] + 16;
  el.style.transform = `translate(${x}px, ${y}px)`;
}

function legend() {
  const el = $('legend');
  if (!T) { el.innerHTML = ''; return; }
  const all = [...T.gals, ...T.gals.flatMap((g) => g.allStars)];
  const count = (k) => all.filter((n) => (k === 'pal' ? n.pal : n.c === k)).length;
  el.innerHTML = CLASSES.map(([k, label]) => {
    const n = count(k);
    if (!n) return '';
    if (k === 'cold') return `<button data-cold class="${showCold ? '' : 'off'}" title="${showCold ? 'hide' : 'show'} ships that were spawned but never booted"><i class="dot cold"></i>never booted <span>${showCold ? n.toLocaleString() : 'hidden'}</span></button>`;
    return `<button data-focus="${k}" class="${sky.focus === k ? 'on' : ''}" title="show only: ${label} (counts are galaxies and stars)"><i class="dot ${k}"></i>${label} <span>${n.toLocaleString()}</span></button>`;
  }).join('');
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

function renderPanel(d, node = null) {
  const el = $('panel');
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
  el.innerHTML = `
    <div class="phead">${sigilBox(d)}<div><h2 class="pname">${dot(d.status)}${esc(d.ship)}</h2>
    <div class="sub">${esc(d.kind)} · ${d.life === 0 ? 'never booted' : statusText(d.status)}${d.status ? ' · ' + ago(d.last) : ''}</div></div></div>
    ${opens(node) ? `<button class="primary" id="dive">Zoom into ${node.kind === 'galaxy' ? 'its stars' : 'its planets'} ›</button>` : ''}
    <dl class="facts">
      <div><dt>sponsor</dt><dd>${link(d.sponsor)}${esc(sponsorNote)}</dd></div>
      ${lfact('parent', d.parent)}
      ${fact('life / rift', d.life == null ? null : `${d.life} / ${d.rift}`)}
      ${fact('residents (sponsored)', d.residents)}
      ${fact('escape requests', d.requests)}
      ${fact('owner', d.owner)}
      ${fact('management proxy', d.managementProxy)}
      ${fact('spawn proxy', d.spawnProxy)}
    </dl>
    <div class="badges">${badges}</div>
    ${palBlock(d)}
    <div class="apps" id="apps"></div>
    <div class="actions"><button id="ping" ${me?.vitals ? '' : 'disabled title="needs %vitals (landscape)"'}>check connection</button><span id="pingres" class="muted"></span></div>`;
  $('ping').onclick = () => ping(d.ship);
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
  const head = (extra = '') => `<div class="appshead"><h3>Apps</h3>${extra}</div>`;
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
  const cards = r.apps.sort((a, b) => a.title.localeCompare(b.title)).map((a) => {
    const icon = okUrl(a.image)
      ? `<img src="${esc(a.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" style="background:${okHex(a.color)}">`
      : `<span class="appicon" style="background:${okHex(a.color)}">${esc((a.title || a.desk).slice(0, 1).toUpperCase())}</span>`;
    return `<div class="app">${icon}<div class="appbody"><div class="apptitle"><b>${esc(a.title || a.desk)}</b><span class="muted">%${esc(a.desk)} · ${esc(a.version)}</span></div>
      ${a.info ? `<div class="appinfo">${esc(a.info)}</div>` : ''}</div>
      ${a.installed ? '<span class="badge">installed</span>' : `<button class="appinstall" data-desk="${esc(a.desk)}" data-title="${esc(a.title || a.desk)}">Install</button>`}</div>`;
  }).join('');
  const status = pending.length && (waiting || r.apps.length)
    ? `<div class="muted appsnote">${waiting ? 'loading' : 'waiting on'} ${pending.length} more: ${pending.map((d) => '%' + esc(d)).join(' ')}</div>`
    : !r.desks.length ? `<div class="muted appsnote">${waiting ? `asking ${esc(ship)}…` : 'Publishes no apps, or hasn\'t answered yet.'}</div>` : '';
  el.innerHTML = head(r.desks.length ? `<span class="muted">${r.desks.length}</span>` : '') + cards + status;
  el.querySelectorAll('.appinstall').forEach((b) => (b.onclick = () => installApp(ship, b)));
  // icons that fail to load fall back to a lettered tile
  el.querySelectorAll('.app img').forEach((im) => (im.onerror = () => {
    const t = document.createElement('span');
    t.className = 'appicon'; t.style.background = im.style.background;
    t.textContent = (im.closest('.app').querySelector('.apptitle b')?.textContent || '?').slice(0, 1).toUpperCase();
    im.replaceWith(t);
  }));
  if (waiting && (pending.length || !r.desks.length)) appsPoll = setTimeout(() => loadApps(ship, until), 3000);
}

async function installApp(ship, b) {
  const desk = b.dataset.desk;
  if (!confirm(`Install "${b.dataset.title}" (%${desk}) from ${ship}?\n\nApps run on your ship with full access to it. Only install from publishers you trust.`)) return;
  b.disabled = true; b.textContent = 'installing…';
  const r = await fetch(`${API}/install/${ship}/${encodeURIComponent(desk)}`, { method: 'POST', credentials: 'include' }).catch(() => null);
  b.textContent = r && r.ok ? 'started · see Landscape' : r && r.status === 403 ? 'log in first' : 'failed';
}

// ---------------------------------------------------------------- %pals

function palBlock(d) {
  if (!me?.pals || d.ship === me.ship) return '';
  let state;
  if (d.target && d.leech) state = '★ mutual pals';
  else if (d.target) state = 'you added them · ' + (d.palAck === true ? 'they got your request; waiting for them to add you back' : d.palAck === false ? 'they rejected the request' : "your request hasn't reached them yet");
  else if (d.leech) state = 'they added you · add them back to become mutuals';
  else state = 'not a pal';
  const btn = d.target
    ? '<button id="palbtn" data-act="del">Remove pal</button>'
    : `<button id="palbtn" class="primary" data-act="add">${d.leech ? 'Add back' : 'Add pal'}</button>`;
  return `<div class="palrow"><span class="${d.target || d.leech ? 'pal' : 'muted'}">${esc(state)}</span>${btn}</div>`;
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

// ---------------------------------------------------------------- scan
//
// Nobody keeps a list of who is online: a ship only knows about ships it has
// exchanged packets with. A scan asks %vitals to run a connection check on
// each booted ship in the current view, a few at a time, and paints the
// results as they arrive.

const SCAN_MAX = 400, SCAN_PAR = 6;
let scan = null;
// what's on screen right now, booted ships only
const inView = () => sky.drawn.filter((n) => n.life !== 0 && n.ship !== me?.ship).slice(0, SCAN_MAX);

function scanHud() {
  const btn = $('scanbtn'), res = $('scanres'), bar = $('scanbar');
  if (!btn) return;
  if (!me?.vitals) { $('scanhud').hidden = true; return; }
  if (scan && scan.running) {
    btn.textContent = 'Stop scan';
    bar.parentElement.hidden = false; bar.style.width = (100 * scan.done) / scan.total + '%';
    res.innerHTML = `${scan.done}/${scan.total} · <b class="on">${scan.online} online</b> · ${scan.offline} offline${scan.unknown ? ` · ${scan.unknown} ?` : ''}`;
    return;
  }
  const n = inView().length;
  btn.textContent = n ? `Scan ${n} in view` : 'Scan view';
  btn.disabled = !n;
  btn.title = `Run a %vitals connection check on the ${n} booted ships on screen, ${SCAN_PAR} at a time. This sends traffic to those ships.`;
  if (scan && !scan.running) {
    bar.parentElement.hidden = false; bar.style.width = '100%';
    res.innerHTML = `last scan: <b class="on">${scan.online} online</b> · ${scan.offline} offline${scan.unknown ? ` · ${scan.unknown} ?` : ''}${scan.msg ? ' · ' + esc(scan.msg) : ''}`;
  } else { bar.parentElement.hidden = true; res.textContent = ''; }
}
const scanUI = scanHud;

$('scanbtn').onclick = () => {
  if (scan && scan.running) { scan.stop = true; scan.msg = 'stopped'; return; }
  runScan(inView());
};

async function runScan(ships) {
  if (!ships.length) return;
  scan = { total: ships.length, done: 0, online: 0, offline: 0, unknown: 0, stop: false, msg: '', running: true };
  scanHud();
  let i = 0;
  const worker = async () => {
    while (!scan.stop && i < ships.length) {
      const n = ships[i++];
      const r = await checkShip(n.ship);
      if (['no-dns', 'no-our-galaxy', 'no-our-planet'].includes(r)) { scan.stop = true; scan.msg = 'stopped: your own connection is down'; }
      else applyScan(n, r);
      scan.done++;
      scanHud();
    }
  };
  await Promise.all(Array.from({ length: SCAN_PAR }, worker));
  scan.running = false;
  legend(); scanHud();
  listedFor = undefined; listFor(sky.ctx);
}

async function checkShip(p) {
  try {
    const r0 = await fetch(`${API}/ping/${p}`, { method: 'POST', credentials: 'include' });
    if (!r0.ok) return 'error';
    const t0 = Date.now();
    while (Date.now() - t0 < 45000 && !scan.stop) {
      await new Promise((res) => setTimeout(res, 2000));
      const r = await get('/ping/' + p);
      if (r.state === 'complete' && r.at >= t0 - 2000) return r.result;
    }
  } catch {}
  return 'timeout';
}

function applyScan(n, r) {
  n.scanned = r;
  if (r === 'yes' || r === 'no-sponsor-hit') { n.status = 'live'; n.last = Date.now(); scan.online++; }
  else if (r === 'no-sponsor-miss') { n.status = 'dead'; scan.offline++; }
  else scan.unknown++;
  prep(n); sky.dirty = true; kick();
}

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

// ---------------------------------------------------------------- list view

const shortAgo = (ms) => (ms ? ago(ms).replace(' ago', '') : '');
const scanWord = { yes: 'online', 'no-sponsor-hit': 'online', 'no-sponsor-miss': 'offline' };
function row(s) {
  const cold = s.life === 0 || (s.life == null && !s.status);
  const pal = s.target && s.leech ? '<span class="pals" title="mutual pal">★</span>' : s.target || s.leech ? '<span class="pals" title="pal">☆</span>' : '';
  const meta = s.life === 0 ? 'no keys' : s.status === 'live' && s.last ? shortAgo(s.last) : scanWord[s.scanned] || (s.kind === 'star' && s.n ? s.n.toLocaleString() + 'p' : '');
  return `<a class="row${cold ? ' cold' : ''}${s.adopted ? ' adopted' : ''}" href="#/${esc(s.ship)}" data-ship="${esc(s.ship)}" title="${esc(s.ship)}${s.adopted ? ' · adopted from ' + esc(s.origin) : ''}">${dot(s.status)}<span class="nm">${esc(s.ship)}</span>${pal}<span class="meta">${esc(meta)}</span></a>`;
}
const tile = row;

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

function normalize(q) {
  q = q.trim().toLowerCase().replace(/^~?/, '~').replace(/\s+/g, '');
  return /^~[a-z-]+$/.test(q) ? q : null;
}
$('search').onsubmit = (e) => {
  e.preventDefault();
  const p = normalize($('q').value);
  if (p) location.hash = '#/' + p;
};

// keep it live: re-read the tree every 5 minutes without moving the view
setInterval(async () => {
  if (!T || document.hidden || $('explore').hidden) return;
  try {
    const raw = await get('/tree');
    const selName = sky.sel?.ship, ctxName = sky.ctx?.ship;
    for (const k of [...cache.keys()]) if (k.startsWith('/residents/')) cache.delete(k);
    T = buildTree(raw);
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
