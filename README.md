# %sextant

A live map of the Urbit network. All 256 galaxies sit on one spiral. Zoom into a
galaxy to see the stars it sponsors right now, then into a star to see its
planets. Ships are placed under their **current sponsor**, not where they were
spawned. Status colours come from your ship's Ames state. `%pals` and `%vitals`
are used when they're installed.

Everything is read from the host ship's own scries (`%azimuth`, `%ames`, `%pals`,
`%vitals`, `%treaty`). No outside services are involved.

## Layout

```
desk/
  app/sextant.hoon   agent: JSON API, HTTP serving, cached sponsorship tree
  web/               index.html, app.js (canvas map), style.css, sigil.js, icon.png
  desk.docket-0      Landscape tile
dev.sh               copy desk/ into a pier and |commit
```

`web/sigil.js` is `@urbit/sigil-js` 2.2.0 (MIT), vendored as a plain script.

## Develop on a fake or dev ship

```sh
# once, in the ship's dojo
|new-desk %sextant
|mount %sextant
# then, after each edit
./dev.sh ~/urbit-dev/devcomet devcomet   # pier dir, tmux session running the ship
# first time only, in the dojo
|install our %sextant
```

Open `http://localhost:<port>/apps/sextant`.

## Publish from a real ship

On the host ship, for example `~nosfyl`:

```
|new-desk %sextant
|mount %sextant
```

Copy `desk/*` into `<pier>/sextant/`, then:

```
|commit %sextant
|install our %sextant
:treaty|publish %sextant
```

Anyone can then install it with `|install ~nosfyl %sextant`, or by searching
`~nosfyl` in Landscape.

To let people browse your map without logging in (read-only), run
`:sextant [%public &]`. Adding pals, connection checks and scans always need
the owner's login.

## API (all GET, JSON)

| path | what |
|---|---|
| `/api/me` | host ship, what's installed, point count |
| `/api/tree` | every galaxy plus every sponsored star, compact rows (cached, rebuilt every 5 min) |
| `/api/ship/~p` | one point in detail, including sponsor, chain and pal receipt |
| `/api/residents/~p` | ships sponsored by `~p`, plus pending escape requests |
| `/api/kids/~p`, `/api/galaxies`, `/api/pals`, `/api/peers` | lists |
| `/api/ping/~p` | latest `%vitals` result (POST starts a check: owner only) |
| `/api/pal/~p` | POST adds a pal, DELETE removes one (owner only) |
| `/api/apps/~p` | apps `~p` publishes, via `%treaty`; POST looks the ship up first (owner only) |
| `/api/install/~p/desk` | POST installs that desk from `~p` through `%kiln-install` (owner only) |
