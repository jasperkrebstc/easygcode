# EasyGCode

For creating G-code on the go, easily. The app is organized into **project tabs** that
share the same engine (extrusion math, printer modes, start/end G-code, previews) but
keep **fully independent settings** per project:

- **Coat hanger** — the vase-mode generator described below.
- **Bend stool** — the seat disc: concentric rings offset inward by one
  line width, traced inner→outer as one continuous path. Two selectable **seam
  styles**: *staircase* (all rings one direction; each stops one line width before its
  start, so the seam shifts per ring) or *zipper* (every other ring flips direction; the
  seam is a straight slot — the seam line offset both ways by half a line width — and
  every ring turns around exactly where it crosses those two parallel lines, so all
  U-turn connectors run along them, parallel and one line width apart, gap-free).
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
  and extrusion follows each loop's actual bead height. The very last (topmost) layer is
  always a FULL lh everywhere, even over a domed center — it still follows the domed
  surface below it (so the disc stays non-planar there), but its own thickness and
  extrusion are the full nominal layer, giving the print a full-strength top skin.
  Optional **foaming** (Klipper
  pellet mode only, needs ≥3 layers): the first and last layers print at the normal
  pellet zone temps; every layer between prints at separate **foam zone up/mid/down temperatures**
  (mirroring the base pellet zone temps, so a temperature ramp across the zones is
  possible), which expand the material, so only a **foam extrusion %** is exposed — the
  matching **speed %** is derived (`10000/extrusionPct`) to keep flow constant rather
  than being a second number to keep in sync by hand. Entering/exiting foam, the disc
  pauses at the end of a layer, lifts clear to **double the tallest point printed
  anywhere so far** (not just the current point's own Z — a domed disc's outer rings
  can already be taller than wherever the transition happens to trigger, so clearance
  is measured against the print's running max, not the local height), travels to
  machine **X0 Y0**, waits for the new zone temps, and prints a short straight **prime
  line** (its own length /
  line width / layer height / feed — independent settings for the entering and
  exiting primer, since exiting typically needs to flush more) before continuing. The
  wait itself is a tolerant `TEMPERATURE_WAIT` (Klipper's own gcode, `SENSOR=extruder` /
  `extruder1` / `extruder2` for the up/mid/down zones) rather than an exact-match wait —
  a PID-controlled zone settles *near* its setpoint but often never hits it exactly, so
  an exact wait can stall the print indefinitely. Entering foam only the **down zone**
  (closest to the nozzle, doing the actual expansion) has to be up to temperature, so it
  waits for `MINIMUM=target-2`; exiting foam all **three zones** need to have cooled back
  down, so each waits for `MAXIMUM=target+2`. Both
  primers always print at 100 % speed/extrusion: entering, the `M220`/`M221` overrides
  are applied *after* the prime line; exiting, they're reverted to 100/100 *before* it
  — so neither primer ever needs its own override math. Enabling foaming outside
  Pellet mode, or with fewer than 3 layers, is ignored with a warning rather than
  blocked, since testing shape/scale in filament mode with foaming left on is normal.
  The **first layer prints outside-in** (outermost ring/legs inward to the seat
  center) — every other layer stays inside-out — led in by a straight **entrance
  primer**: a fixed-length radial line (25% of the seat diameter, so it scales with
  size; same line width/layer height as the print itself) ending exactly at the
  outermost ring's own seam point, so the corner from primer to ring is a real 90°
  turn (radial into tangential). The reversed ring order reuses each ring's own
  already-built points (just walked backwards) rather than new geometry, since the
  forward chaining already guarantees ring i's start equals ring i-1's end. Always
  applied when legs are enabled or the zipper seam is on; the plain legless-staircase
  disc keeps its ordinary inside-out first layer. With a **brim enabled**, the
  entrance primer is skipped automatically — the brim already primes the nozzle,
  and the primer's outward radial lead-in would otherwise sit right where the
  brim's own rings are — while the first layer still prints outside-in and travels
  straight to the seam point (brim-clearance aware). Finally, the disc is always
  **rotated 15°** and the rotated bounding box is **recentered on the bed-center
  input** — the 3-leg layout is roughly triangular, and this fits a rectangular bed
  better than printing it axis-aligned (a legless circular disc is rotationally
  symmetric, so only its seam position visibly shifts). The resulting bounding box
  size — pure centerline coordinates, no line-width margin added, since the bed has
  room to spare beyond where the head travels — is shown live in the hint and in the
  G-code header, computed by the same shared function in both places so the numbers
  always match exactly. Optional **constant volumetric flow** feed mode: instead of
  a fixed print feed, set a target flow (mm³/s) and the feed is derived per segment
  from its own bead cross-section (`flow × 60 ÷ area`), so the dome's thinner center
  beads print faster and full-height beads print slower, holding flow constant
  throughout — an `F` value is only re-emitted when it changes, exactly like normal.
  The primer lines (entrance, foam) keep their own dedicated feeds regardless of this
  mode. Whichever number isn't already fixed by the current mode is shown live and in
  the G-code header — the resulting feed range in flow mode, or the resulting flow
  range at the fixed feed in constant mode — both from the same shared bead-height
  range the generator itself uses, so preview and output always agree. Every
  layer-to-layer travel (not just under the dome — the overhang drop can locally
  sink points below their nominal height too) goes through a two-move safety margin
  instead of a direct line: one diagonal move aimed 2 layer heights ABOVE the next
  layer's actual start (still one straight line, just higher), then one straight
  drop down to the real start. A domed disc's inner rings sit lower than the current
  layer's taller outer rings, so a direct travel can otherwise cut down through
  material already printed at a different radius; a full lift-in-place-and-move
  (like the brim/foam clearance hops) would instead leave a small blob of oozed
  material sitting on the print, worse under foaming — so this stays to exactly the
  two moves, always applied (harmless — two quick non-extruding moves — even on a
  flat, undomed disc where it isn't strictly needed).

- **Vessel** — simple trays, vases and cylinders. Reuses the same base **shapes**
  (circle, rounded rectangle, ellipse, polygon, star, squircle) and **print
  settings / printer modes** as the other projects. A **closed bottom** is printed
  first as a concentric solid fill of the footprint (scaled inward from a true
  one-line-width offset so its outer edge butts the wall's inner face), in the same
  *staircase* or *zipper* **seam** styles as the bend-stool seat — or as a **true
  spiral**: one continuous seamless path that never stops or closes. It opens at
  the exact center — the first revolution grows from the centroid point outward,
  a real spiral start with no closed circle to crowd — then winds out at exactly
  one line width per revolution (any footprint shape) and — since a spiral can't
  end flush all the way around — simply keeps going one extra revolution onto the
  wall curve. The wall is the next turn of the same line, so the spacing is one
  line width everywhere except the innermost turn, where the footprint's leftover
  radius lands (the ring ladder is anchored at the wall); there extrusion follows
  the locally covered width instead of overfilling. Stacked bottom
  layers alternate direction — out, in, out, … — each starting where the previous
  ended, with the first layer's direction chosen by parity so the last always runs
  outward onto the wall (its transition revolutions are the wall's lowest layers)
  and straight into the helix. The whole vessel is therefore a single unbroken
  extrusion with **zero travel moves**, whatever the layer count (odd counts start
  at the center, even at the rim). All styles print over a configurable
  number of **bottom layers**. The **wall** is then a continuous
  vase-mode spiral just outside the bottom; with a ring-style bottom it starts again
  at `z = 0` (so the bottom sits inside it) and ramps extrusion up over the first
  revolution, while with the true-spiral bottom it continues from the handoff with
  no travel and no ramp. A **radius
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

The final lift in both end blocks clears to **5x the tallest point actually printed**
(an absolute move, not a small fixed bump) — enough real headroom to reach in and finish
the part by hand (trim drooping filament/oozing, etc.) once it's done, rather than the
head parking just a few mm above the print. Floored at the old fixed value (10 mm
pellet / 5 mm filament) so a trivial near-zero-height job still lifts.

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
  length varies. 0 = every spike the same length. The **bump feedrate** only slows the
  move OUT to the tip — the move back in prints at the normal print feed, not the bump
  feed — since a slow approach with a fast retreat gave cleaner spikes in practice than
  slowing both directions. An optional **tip dwell (s)** inserts a `G4` pause right at
  the tip, after the slow move out and before heading back in at normal speed (e.g. very
  slow out + a few seconds dwell + fast back in).

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

The transition loops aren't stacked directly on top of each other — each point slides
sideways toward the plain profile as the hanger shape washes out — so a steep transition
(few transition loops, or a big gap %) is a real overhang with its own sagging risk, on
top of the single bridging loop above. An **overhang angle** (degrees from vertical) and
**overhang feedrate** cover this: any transition-loop segment whose sideways shift from
the loop directly below it exceeds what the angle allows for the current layer height
prints at the overhang feedrate instead of the normal print feed.

An **export profile SVG** button (next to the hanger inputs) downloads the **gap opening
itself** — not the wall outline, but the actual hole a bracket needs to hook through. It's
bounded on one side by the bridging loop's new bezier/pocket path (the innermost extent,
where the wall sits at the bottom of the gap) and on the other by the plain base curve's
own back arc between those same two points (the outermost extent, where the wall sits
once the transition has fully closed the gap back up) — both curves already meet exactly
there, so stitching bridging-path-forward + base-arc-backward is already a closed loop.
Exported at the raw toolpath centerline (unoffset — offsetting for the bead's material
width is left to the CAD tool), in part-local mm coordinates (centered on the shape,
independent of bed position), for bringing straight into a CAD tool to design a mating
bracket.

### Brim

An optional brim prints first as flat offset loops of the base shape (at the brim layer
height). The first brim line sits `brimWidth/2 + lineWidth/2` from the base wall
(gap-free); each additional line is one brim width further out (**outer**) or in
(**inner**). A travel move (at the travel feedrate) connects each loop. Inner brim lines
that would exceed the shape's size are skipped with a warning, so over-specifying is safe.
A **print order** setting (shared across all three projects) picks *in → out* (default —
the line adjacent to the part prints first) or *out → in* (the farthest line prints
first, moving inward toward the part last). Only the printed ORDER changes — the same
lines, at the same offsets — so switching it is always safe.
When a brim is printed, the first travel to the body (wall / disc / bottom) **clears the
brim**: it lifts to twice the brim layer height, moves over, then drops to the start Z, so
the nozzle never drags across the brim on its way in. This applies to all three projects.

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

The **3D preview** orbits with a drag (Z-up), pinch/wheel zooms, two fingers pan, and a
double-tap resets. The toolpath is colored by feedrate — blue = fastest, red = slowest —
so brim / wall / bump feed differences are visible at a glance.

## Files

`index.html` · `styles.css` · `app.js` (UI) · `geometry.js` (shapes, resampling,
offsetting) · `gcode.js` (bead/spiral/brim math) · `manifest.webmanifest` + `sw.js` +
icons (PWA).

## Roadmap

Freehand draw + auto-close → Notes-style shape snapping → AI text-to-shape → coat-hanger
taper/twist → more surface patterns → speed variation.
