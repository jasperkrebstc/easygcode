# EasyGCode

For creating G-code on the go, easily. The app is organized into **project tabs** that
share the same engine (extrusion math, printer modes, start/end G-code, previews) but
keep **fully independent settings** per project:

- **Coat hanger** — the vase-mode generator described below.
- **Bend stool** — (in progress) the seat disc: concentric rings offset inward by one
  line width, traced inner→outer as one continuous path. Two selectable **seam
  styles**: *staircase* (all rings one direction; each stops one line width before its
  start, so the seam shifts per ring) or *zipper* (every other ring flips direction and
  turns around half a line width before the seam line, so the seam stays fixed — at the
  cost of hard U-turns).
  The diameter snaps to the nearest multiple of `2 × line width` (ties round up) so
  the beads meet half-half in the center. Optional **legs**: three, 120° apart (one
  pointing left, two right), printed flat as nested hairpins radiating from the outer
  rings — each hairpin pair joins one ring (leg width snaps like the diameter), with
  tangent **fillets** at the junctions and concentric tip caps. **Seat height** is
  measured rim edge → tip edge (cap arcs included). The seam is anchored at 0°
  (between the two right legs) on the outermost ring; inner rings absorb the
  staircase drift. The brim follows the full outline including legs. Supports
  stacked layers. Optional **bend-zone spread** (attractor points): one point per
  leg on the center→tip line (position in mm from the rim), with a full-effect
  radius R1 and a smoothstep falloff to R2. Inside R1 every legged loop is locally
  offset outward so line spacing becomes `lw + gap·lw` (hairpin q from the spine
  moves (2q+1)/2·gap·lw); seat-only rings never move. Applied per primitive during
  construction, so it cannot self-intersect — fillets shrink toward their centers
  and, when the displacement exceeds them, become the exact offset corner (the
  tight-corner case). With multiple layers the spread grows linearly from zero at
  the bottom (lines collected) to maximum at the top. The **overhang drop** (0–1,
  default 0.5) then compensates the overhang: each point moves toward the same
  (less-spread) point on the layer below — down AND inward along the overhang
  slope — by `drop × local overhang steepness`, accumulating layer over layer.
  Because the move is along the slope the wall **angle is preserved** while the
  layers pack denser along it (at drop 0.5 the along-slope layer spacing halves at
  the steepest point); EXTRUSION stays at the full local layer height so the
  tighter gap is deliberately overfilled — slanted layers need more material. The
  max overhang angle and along-slope packing are shown in the hint and the G-code
  header. The reheat-and-bend zone softens exactly there. Finally an optional **dome**
  (center layer-height multiplier, 0–1, 1 = flat): after a uniform first layer, each
  loop's layer height is bezier-eased from `dome × lh` at the innermost circle (slow
  start, fast middle, tiny end falloff) up to the full `lh` at the outermost leg
  curve — heights accumulate into a dished, curvy seat, the legs get a U-profile,
  and extrusion follows each loop's actual bead height.

- **Vessel** — simple trays, vases and cylinders. Reuses the same base **shapes**
  (circle, rounded rectangle, ellipse, polygon, star, squircle) and **print
  settings / printer modes** as the other projects. A **closed bottom** is printed
  first as a concentric solid fill of the footprint (scaled inward from a true
  one-line-width offset so its outer edge butts the wall's inner face), in the same
  *staircase* or *zipper* **seam** styles as the bend-stool seat — or as a **true
  spiral**: one continuous seamless path that traces the innermost ring closed,
  morphs radially outward one line width per revolution (any footprint shape), and
  closes with the outermost ring so it butts the wall with no gap (a bare spiral
  can't end flush all the way around). Where the spiral peels off / merges into
  those closed end rings the line spacing shrinks below one width, so extrusion
  tapers with the local covered width (100% → 50%) instead of overfilling. All
  styles print over a configurable number of **bottom layers**. The **wall** is then a continuous
  vase-mode spiral just outside the bottom, starting again at `z = 0` (so the bottom
  sits inside it) and ramping extrusion up over the first revolution. A **radius
  profile** — bottom / middle / top scale control points, lofted with a Catmull-Rom
  curve and shown as a live side-silhouette preview — tapers the wall with height
  for cones, bellied vases, and flared trays (all `1` = a straight prism). The wall
  height snaps to a whole number of layers. A **top finish** dropdown picks how the
  wall ends: **flat cap** (default) adds one extra revolution that holds `z` constant
  and ramps the extrusion back down to zero, closing the top cleanly; **open spiral**
  adds nothing — the wall simply completes its last revolution at full flow and
  stops, leaving an even full-width bead all the way to the end (with the spiral's
  one-layer helical step at the seam). Separate **brim** settings, like the other
  projects.

The coat hanger is a dead-simple, phone-first tool to generate **vase-mode G-code** for
**Klipper pellet 3D printing** (or the Bambu P1P in filament mode). Pick a cross-section
shape, set layer height / line width / total height, optionally add a brim, and get a
continuous spiral of `G1` moves. No app store, no install — it runs as a web page / PWA.

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

Extrusion is **relative** (`M83`) with **absolute positioning** (`G90`). The **printer
mode** decides what `E` means:

- **Pellet (Klipper):** `E` is pure volume in mm³ (`beadArea × segmentLength`) — the
  Klipper rotation-distance setup converts it downstream.
- **Filament (Marlin):** `E` is linear mm of filament — segment volume divided by the
  filament cross-section (`π·(d/2)²`, diameter input, default 1.75 mm).

An **extrusion multiplier** scales all generated `E` values for per-material fine-tuning.

### Start / end G-code

Toggleable per print. Each mode ships a cleaned-up version of the user's proven files:

- **Filament (Marlin / Bambu P1P):** bed + nozzle temps and fan % are inputs; preheat at
  150 °C, home, prime, primer lines, and the retract/lift/heaters-off end are fixed.
- **Pellet (Klipper):** the `_GINGER_*` macro sequence — early bed heat, 3 extruder zone
  temps (up/mid/down inputs), purge parking, purge (quantity input), rotation-distance
  constants, pressure advance (input), buzzer. The bed wait window derives from the bed
  temp (min = bed − 10, max = bed + 40). End G-code is a basic explicit block (lift,
  `TURN_OFF_HEATERS`, fan off, motors off) instead of `END_PRINT`.

The part-cooling fan turns on **after the first (ramp) loop** so it bonds unfanned
(filament default 100%, pellet default 0%).

### Vase spiral + ramp-up

The footprint is sampled into evenly spaced points and traced as one continuous spiral:
Z rises by `layerHeight` per full loop with no seam and no retractions. The **first
turn ramps up**: it starts at `Z = 0` with 0% extrusion and linearly climbs to
`layerHeight` at 100% extrusion over one loop, so the wall builds off the bed cleanly.
The **last turn ramps down**: a final revolution holds Z constant (no height gain) while
the extrusion tapers to zero, so the top rim finishes level and clean, not on a spiral ramp.

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
  seed to re-roll. Each spike stays a clean base→tip→base triangle exactly one line width
  wide even through the hanger and transition loops (their dense points are dropped inside
  the spike window so the drop is never pinched narrow). An optional **length
  variation (± mm)** randomizes each spike's length within `amplitude ± var` (e.g.
  amplitude 50, variation 10 → lengths 40–60), deterministic per seed and drawn from
  a stream independent of the placement; the base stays one line width, only the
  length varies. 0 = every spike the same length.

### Wall hanger

An optional keyhole-style hanger, always placed **opposite the seam**. On the hanger
loop, a **gap cutout %** is removed from the back of the outline; an **insert pocket %**
arc centered on the seam is offset inward by one line width; tangent-matched beziers join
the gap edges to the pocket through the interior, forming a funnel. Keep the pocket %
smaller than the gap % so the beziers have room. Other inputs: **bottom normal loops**
(plain revolutions below), **transition loops** (the hanger shape tweens back into the
base curve over this many revolutions), and **bridge feedrate** — the first hanger loop
bridges over air, so only its new sections (beziers + pocket) print at this slow feed.
Patterns (weave/spikes) stay active through the hanger and transition loops. The 2D
preview shows the hanger loop dashed.

### Brim

An optional brim prints first as flat offset loops of the base shape (at the brim layer
height). The first brim line sits `brimWidth/2 + lineWidth/2` from the base wall
(gap-free); each additional line is one brim width further out (**outer**) or in
(**inner**). A travel move (at the travel feedrate) connects each loop. Inner brim lines
that would exceed the shape's size are skipped with a warning, so over-specifying is safe.

## Inputs

- **Printer & material:** printer mode (pellet/filament), extrusion multiplier,
  start/end toggle; filament → diameter, nozzle temp, bed temp, fan %; pellet → 3 zone
  temps, bed temp, pressure advance, purge quantity, fan %.
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
