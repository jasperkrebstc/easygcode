# EasyGCode

For creating G-code on the go, easily. A dead-simple, phone-first tool to generate
**vase-mode G-code** for **Klipper pellet 3D printing**. Pick a cross-section shape, set
layer height / line width / total height, optionally add a brim, and get a continuous
spiral of `G1` moves with **volumetric (mm³) extrusion**. No app store, no install — it
runs as a web page / PWA.

## Use it

Open `index.html` — locally, or via GitHub Pages once enabled (Settings → Pages →
deploy from the working branch, root). On iPhone, tap **Share → Add to Home Screen** to
install it like an app; it then works offline.

Export options: **Copy**, **Download .gcode** (saves to Files), or **Share** (AirDrop /
send to another app via the iOS share sheet).

**Settings presets:** "Save settings" downloads all inputs as a JSON file; "Load settings"
reads one back. The latest settings are also remembered automatically (localStorage), so
reopening the app keeps them — the JSON file is the durable backup (iOS may clear local
storage after ~7 days of not opening the app).

## How it works

### Bead cross-section (volume)

Each extruded line is modeled as a "stadium" — a rectangle with a half-circle on each
end — where width `w` = line width and height `h` = layer height:

```
beadArea(w, h) = (w - h) * h + π * (h/2)²        // mm²  (w clamped to ≥ h)
```

Extrusion is **relative** (`M83`) and **volumetric**: every `G1 E` value is that
segment's volume, `E = beadArea * segmentLength` (mm³). Positioning is **absolute**
(`G90`). There is **no start/end G-code** yet (no heating/homing) — add your own, or
it's coming in a later step.

### Vase spiral + ramp-up

The footprint is sampled into evenly spaced points and traced as one continuous spiral:
Z rises by `layerHeight` per full loop with no seam and no retractions. The **first
turn ramps up**: it starts at `Z = 0` with 0% extrusion and linearly climbs to
`layerHeight` at 100% extrusion over one loop, so the wall builds off the bed cleanly.

### Adaptive resolution

The base curve is built to a **chord tolerance** (mm): the shape is densely sampled then
simplified (Douglas–Peucker) so flat sections use few points and tight curves use more.
This is geometry only — it's never emitted directly when a pattern is active.

### Seam

The loop is rotated so its start (the seam) sits where the Y-axis crosses the curve —
**Back (+Y)** by default, or **Front (−Y)**.

### Patterns

Choose a pattern **type**; each displaces the toolpath sideways along the horizontal
normal (tangent × Z). Settings are split into **general** (shared by all pattern types,
present and future) and **type-specific**:

- **General:** enable, type, amplitude, **Z-angle** (−90…90°; rotates the displacement
  vector in the vertical plane so bumps rise/fall on the way out and reverse on the way
  back — 0° = flat, ±90° = straight up/down), **coverage %** (the patterned band is
  centered on the seam and grows both directions — 100% = whole loop), **patternless
  layers top/bottom**, and **bump feedrate** (used on bump moves; plain wall moves keep
  the print feed).
- **Weave (type-specific: bumps/revolution):** continuous displacement
  `amplitude · cos(π · (L + u) · bumps)`. Emitted points are the union of base-curve
  vertices (shape fidelity) and bump positions, so the weave is smooth and accurate.
  Because the phase shifts by `(-1)^bumps` per layer, **even bumps/rev = vertical flutes,
  odd = woven**.
- **Random spikes (type-specific: number of spikes, seed):** blue-noise (Mitchell
  best-candidate) outward pokes distributed evenly-but-random across the confined area.
  Each spike is a triangle whose base width equals the line width (so the inner wall reads
  as continuous), with the tip at full amplitude. Deterministic per **seed** — change the
  seed to re-roll.

### Brim

An optional brim prints first as flat offset loops of the base shape (at the brim layer
height). The first brim line sits `brimWidth/2 + lineWidth/2` from the base wall
(gap-free); each additional line is one brim width further out (**outer**) or in
(**inner**). A travel move (at the travel feedrate) connects each loop. Inner brim lines
that would exceed the shape's size are skipped with a warning, so over-specifying is safe.

## Inputs

- **Shape:** circle (radius); rounded rectangle (width, length, fillet); ellipse;
  polygon; star; squircle.
- **Print:** layer height, line width, total height, print feed, travel feed,
  chord tolerance, seam side, bed center X/Y.
- **Pattern:** enable, amplitude, bumps/revolution, coverage %, patternless layers
  top/bottom.
- **Brim:** enable, outer/inner, number of lines, brim line width, brim layer height,
  brim feedrate.

The **3D preview** orbits at a fixed zoom (drag to rotate, Z-up), and colors the toolpath
by feedrate — blue = fastest, red = slowest — so brim / wall / bump feed differences are
visible at a glance.

## Files

`index.html` · `styles.css` · `app.js` (UI) · `geometry.js` (shapes, resampling,
offsetting) · `gcode.js` (bead/spiral/brim math) · `manifest.webmanifest` + `sw.js` +
icons (PWA).

## Roadmap

Freehand draw + auto-close → Notes-style shape snapping → AI text-to-shape → vertical
taper/twist → more surface patterns → speed variation → nonplanar → start/end G-code
presets + bottom layers.
