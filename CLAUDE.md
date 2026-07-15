# CLAUDE.md — working on EasyGCode

Guidance for Claude Code (and humans) working in this repo. This project has
multiple collaborators, each on their own branch. Read this before starting.

## What this is

A phone-first, install-free web app that generates 3D-printer G-code. Pure
static files, **no build step, no bundler** — it must run straight from
`file://` and from GitHub Pages. Plain ES5-ish vanilla JS (no modules, no
TypeScript, no npm dependencies in the shipped app).

Three project tabs share one engine but keep fully independent settings:

- **Coat hanger** — vase-mode spiral (weave/spikes patterns, keyhole wall hanger).
- **Bend stool** — concentric-ring seat disc with legs, bend-zone spread, dome.
- **Vessel** — trays/vases/cylinders: concentric solid bottom + spiral wall + radius profile.

## Files

| File | Role | Global |
|------|------|--------|
| `geometry.js` | shape/offset/sampler/fill math | `window.Geo` |
| `gcode.js` | G-code generation (`generate(cfg)`) | `window.GcodeGen` |
| `app.js` | UI wiring, previews, settings persistence | — |
| `index.html` | markup for all three tabs | — |
| `styles.css` | styles | — |
| `sw.js` | PWA service worker (offline cache) | — |

Per-project input IDs are prefixed: coat hanger = no prefix, bend stool = `bs_`,
vessel = `ve_`. Shared readers in `app.js` take a prefix argument.

## Collaboration workflow (important)

Multiple people work in parallel on different branches. Git 3-way merges
non-overlapping changes automatically — conflicts only occur when two branches
edit the **same lines of the same file**. To keep merges clean:

1. **Before starting a task and before pushing/opening a PR, sync main:**
   ```
   git fetch origin main
   git merge origin/main        # (or rebase) — resolve conflicts locally
   ```
   On the GitHub PR page, the **"Update branch"** button does this too.
2. Resolve conflicts by **keeping the non-overlapping changes from both sides**.
   Never blindly "accept both" on a single-value line (it duplicates it).
3. Keep branches **short-lived**; merge small PRs often. Long branches drift
   from main and collide more.

### Hot files (rare conflict points)

- **`README.md`** — when two people add notes near each other; keep both.
- **`sw.js`** — only if two branches both edit the `ASSETS` list. There is **no
  version number to bump** (see below), so the old recurring conflict is gone.

## Conventions

- **Service worker / caching:** `sw.js` uses a **fixed** cache name and is
  network-first with `updateViaCache: 'none'`, revalidating every app asset, so
  a plain refresh gets the latest when online — **nothing to bump per release.**
  Only touch `sw.js` when adding/removing a shipped file (update `ASSETS`).
- **Volumetric extrusion:** every `G1 E` is the segment volume in mm³ (pellet)
  or filament mm (filament mode). Absolute positioning (`G90`), relative
  extrusion (`M83`). Bead model: `beadArea(w,h) = (w-h)*h + PI*(h/2)^2`.
- **Match surrounding style** — 2-space indent, small pure helpers, comments
  that explain the geometry/intent. No new runtime dependencies.

## Testing (no framework — quick node checks)

Syntax-check every file you touch:
```
node --check geometry.js && node --check gcode.js && node --check app.js
```

Headless generation test (stub `window`, require the two engine files, call
`GcodeGen.generate(cfg)`, assert on the returned `.gcode` / `.path` / `.warnings`):
```
node -e "global.window={}; require('./geometry.js'); require('./gcode.js');
  const r = window.GcodeGen.generate(cfg); /* assertions */"
```

**Regression rule:** a change scoped to one project must leave the **other two
projects' output byte-identical**. Diff generated G-code against the previous
`HEAD` for an unrelated config (ignore the timestamp comment line) to confirm.

UI wiring can be exercised with `jsdom` (installed ad-hoc in a scratch dir, not
added to the repo): load the three scripts into a `JSDOM` window, click a tab,
click `#regenBtn`, and read `#output` / `#warnings`.

Always regenerate all three tabs after a shared-engine change.
