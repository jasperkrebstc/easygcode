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
  flat, undomed disc where it isn't strictly needed). Optional **material density
  (g/cm³)** and **material price (per kg)** (0 = skip, the default) show a raw
  material cost estimate alongside the print time. Both correctly account for
  foaming: the nominal G-code numbers (bead area, commanded feedrate) reflect what
  the firmware's own `M221`/`M220` overrides act on at print time, not something the
  generator scales itself — so the stats line tracks the REAL raw material consumed
  and REAL print time separately (equal to the nominal numbers whenever foam never
  activates), weighting each foam-active layer's contribution by the foam extrusion
  % and scaling its time by the same factor (foam mode keeps flow constant by
  moving faster in exact proportion to using less material, so both scale together).

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
  at the center, even at the rim). These three styles print over a configurable
  number of **bottom layers**. A fourth style, **filleted**, does away with the
  idea of separate bottom and wall pieces entirely: one flat layer fills the
  footprint, then a **fillet** — a quarter-circle rounding worked out in scale
  space so it generalizes to any base shape and is geometrically exact for a
  circle — carries that same spiral straight on up into the wall with no seam
  or handoff of any kind, as one continuous line. Its height is a plain
  **fillet height (mm)** input in place of a bottom-layer count (an oversized
  value is clamped to leave at least one full wall layer, with a warning). The
  very start of the fillet is a genuine 90° overhang (the wall is momentarily
  vertical right off the flat floor), so it reuses the lampshade's own
  overhang-compensation trick — rather than widening the bead sideways, each
  turn's physical Z step shrinks in proportion to `cos(angle)` (floored at 0.05
  so a true 90° turn doesn't send the step to zero), while extrusion is still
  computed at the full, un-shrunk layer height; the resulting deliberate
  overfill is what spreads the bead sideways to bridge the steep turns near
  the bottom. The fillet's target scale where it meets the wall is read
  straight off the overall radius profile at that exact height, so the wall
  that follows is always an exact continuation even when a profile control
  point sits close to the bottom. The **wall** is then a continuous
  vase-mode spiral just outside the bottom; with a ring-style bottom it starts again
  at `z = 0` (so the bottom sits inside it) and ramps extrusion up over the first
  revolution, while with the true-spiral or filleted bottom it continues from the
  handoff with no travel and no ramp — for the filleted style this handoff sits
  partway through a layer height rather than on a layer boundary, so the wall's
  revolution count adjusts to still land exactly on the configured wall height. A **radius
  profile** — bottom / top scale control points plus a configurable **2–5 profile
  points** total (0–3 extra middle points, each its own height 0–1 and scale), lofted
  with a Catmull-Rom curve and shown as a live side-silhouette preview — tapers the
  wall with height for cones, bellied vases, and flared trays (all `1` = a straight
  prism; 2 points = a plain bottom-to-top loft, no middle control at all). The wall
  height snaps to a whole number of layers. A **top finish** dropdown picks how the
  wall ends: **flat cap** (default) adds one extra revolution that holds `z` constant
  and ramps the extrusion back down to zero, closing the top cleanly; **open spiral**
  adds nothing — the wall simply completes its last revolution at full flow and
  stops, leaving an even full-width bead all the way to the end (with the spiral's
  one-layer helical step at the seam). Separate **brim** settings, like the other
  projects.
- **Spoon** — a small fun one: a flat lollipop shape, an Archimedean **spiral**
  (pitch = one line width per turn, so adjacent arms sit edge to edge, filling a solid
  disc) that ends in a straight **stick** continuing past the last turn in the radial
  direction — a ~90° turn away from the spiral's own tangential travel there, same as a
  lollipop's stick sticking straight out from the candy. **Turns**, **start radius**,
  **stick length**, and a **layers** count (the whole flat path repeated at rising Z, a
  stack of identical passes rather than a vase-mode helix) are the only shape inputs;
  everything else is the same print settings / printer modes as the other projects. No
  brim, hanger, or pattern options — kept intentionally minimal. Its own fully separate
  generator function (not threaded through the vase-mode one the other three projects
  share), so it can't affect their output at all. A **print direction** dropdown picks
  which end starts: *center → stick* (default, spiral first) or *stick → center* (stick
  first) — a plain reversal of the same point list (unlike the coat hanger's CW/CCW
  setting, nothing here derives an inward/outward offset from the direction of travel,
  so no compensating sign is needed anywhere else for it to come out correct). The whole
  shape is rotated 45° and its (rotated) bounding box recentered on the bed — the disc +
  stick's own axis-aligned box is much longer than it is wide, so tilting it onto a
  square bed's diagonal fits a longer spoon (or needs a smaller bed) than printing it
  axis-aligned; shares the same rotate+recenter helper the bend stool uses for its own
  fixed bed-fit rotation, generalized to take an angle instead of a hardcoded one, so the
  bend stool's own output is unaffected. Optional **stick line width** and **stick layer
  height** (each 0 = same as the spiral) change ONLY the bead cross-section used to
  compute `E` on the stick's own single segment — its length, direction, and Z are still
  governed entirely by the spiral's own line width/layer height, same idea as the coat
  hanger's per-spike extrusion override. A **stick feed (mm/min, 0 = same as spiral)**
  lets the stick print at its own manual feedrate independent of the spiral's print feed.
  An optional **constant volumetric flow** toggle (same idea as the bend stool's own)
  takes a target flow (mm³/s) instead of a fixed feed and derives feed from each
  segment's own bead area — since the stick can have its own bead area, this naturally
  resolves to two independent feeds (spiral and stick) rather than one, shown live in the
  print settings hint and logged in the G-code header. Flow mode takes priority over the
  manual stick feed when both are set, since deriving feed automatically is the whole
  point of turning it on.
- **Lampshade** — a shade that screws straight onto a standard **E14** or **E27**
  lampholder. The mount is the interesting part: instead of modelling a thread, the
  **throat is a plain vase-mode helix whose pitch equals the socket's own thread pitch**,
  so the lampholder's thread crests groove into the inside of the wall as it's screwed
  on. That makes **layer height a derived value, not an input** — it *is* the pitch. The
  relevant standard is **IEC 60399** ("barrel thread for lampholders with shade holder
  ring", i.e. the external thread the decorative ring screws onto — not the M10×1 internal
  fixing thread): **E14 = ⌀28 × 2.0 mm**, **E27 = ⌀40 × 2.5 mm**, both built in, plus a
  **custom** option for measuring your own. The wall's inner surface lands on the thread,
  so the toolpath sits half a line width outside it; a **fit tolerance** (± mm) shifts
  that inner surface — negative for an interference fit where the crests press further
  into the plastic. The helix always runs counter-clockwise as it rises, which is a
  **right-hand thread** (what Edison sockets use); handedness survives flipping the part,
  so it's correct in both print orientations.
  The profile is a **revolve curve in r/z**: a straight **throat** (the length given is
  the full-diameter section that actually grips — the fillet is added *above* it rather
  than eating into it), a tangent-arc **fillet**, then one of four **shade shapes** out to
  the **bottom opening ⌀**. It's carried as a dense `(r, z, angle)` polyline rather than
  an analytic description, so a new shape only has to produce that polyline — nothing
  downstream needs to know which shape made it. **Print orientation** picks throat-down or
  wide-edge-down.
  - **Straight cone** — constant angle over a given **transition height**.
  - **Arc, flaring outward (bell)** — leaves the throat tangentially and bends outward.
    Fitted to the same box the arc is fully determined and ends at exactly *twice* the
    equivalent cone's angle (a box that gives a 45° cone gives an arc finishing
    horizontal). An optional **max angle** caps that; past the cap the curve carries on
    straight at the cap angle so the rim still lands where it was asked to. A cap
    shallower than the straight-line angle is unreachable and is reported rather than
    silently ignored.
  - **Arc, turning out then curling back (dome)** — the mirror image: leaves the throat
    steeply and curves back to vertical at the rim, starting at 90° when the opening and
    height are equal. The **fillet** is what makes that printable — see below.
  - **Sphere** — the throat cuts one hole and the **bottom opening ⌀** the other, sized by
    **sphere ⌀**. Parametrised by polar angle rather than z so samples stay even at the
    poles, which is exactly where the wall angle changes fastest. The wall is steep just
    above the throat, vertical at the equator, and steepens again as it closes — a small
    opening pushes the closing overhang past 80°, so it's the shape most worth testing
    the machine's limits with.

  The **fillet is generic over the curve**, not a closed form per shape: a circle of
  radius F tangent to the throat wall has its centre at `rThroat + F`, so the blend point
  is wherever the curve first satisfies `r + F·cos(a) = rThroat + F`, and everything below
  that is dropped. On a straight cone this reproduces the textbook `t = F·tan(a/2)`
  exactly; on the arcs and the sphere it lands *further up* the curve, which is what makes
  a near-90° departure printable — by the time the fillet ends the curve has flattened, and
  a bigger fillet pushes the join shallower still (on the dome shape, fillet 0/10/35/120 mm
  gives a join angle of 90°/81°/66°/46°).
  **Overhang compensation:** a wall leaning `a` from vertical steps sideways by
  `lh·tan(a)` per turn, putting consecutive bead centres `lh/cos(a)` apart measured along
  the wall — so `cos(a)` is the whole story, and it's offered two ways. **Line width**
  mode widens the bead by `1/cos(a)` (1.41× at 45°, 2× at 60°, clamped by a max
  multiplier). **Layer height** mode shrinks the physical Z rise by `cos(a)` while
  extrusion keeps using the **full** layer height — that deliberate over-fill *is* the
  squeeze that spreads the bead sideways, and extruding for the reduced height instead
  would just print a thinner wall and achieve nothing. A **strength %** blends between no
  compensation and the full geometric factor. Both modes are recomputed **per revolution
  from the local wall angle, sampled at the turn's midpoint** — on the arc and sphere
  shapes the angle swings a long way within a single turn, and reading it at the turn's
  start alone would leave the compensation a full revolution behind wherever the curve
  bends hardest. On a sphere the bead width traces the shape: base width at the throat,
  widest on the steep flank, back to base at the equator, wide again as it closes. The live hint and G-code header
  report the wall angle, the resulting bead width / layer rise, and the **support ratio**
  — the fraction of each bead that lands on the one below, which is the number that
  actually predicts drooping. Warns past ~50°. An optional **constant volumetric flow** toggle takes a
  target flow (mm³/s) instead of a fixed print feed and derives the feed from each
  revolution's own bead area. It matters more here than anywhere else in the app: width
  compensation deliberately grows the bead on the overhangs, and at a constant feed that
  is a straight flow increase exactly where the material is least supported — deriving
  the feed backs the head off in proportion instead. The **throat and shade get separate
  flow targets** (shade 0 = same as the throat), because the shade's revolutions are
  longer and so each layer has more cooling time before the nozzle returns to it. Stepping
  between the two would band the surface, so the flow **ramps across the fillet** — the
  one stretch where the throat geometrically becomes the shade — giving every revolution
  in between its own interpolated value. The ramp is resolved in the profile's own
  coordinates, so it stays on the same part of the shade whichever way up it prints. The
  bell never gets a fillet (it leaves the throat tangentially), so a **flow ramp height**
  input gives the ramp somewhere to happen there; leave it at 0 to use the fillet, and the
  G-code header calls out the hard step if there is neither. Both the opening and closing
  revolutions hold a **constant radius**: the closing one so it lands squarely on the turn
  below rather than still flaring into mid-air, and the opening one so it is a true circle
  — the brim outside it is perfectly circular, and a radius drifting across that first
  revolution would make the gap wobble around the circumference. The opening revolution
  takes the radius the *second* one begins at, so that turn stacks straight onto it. With
  the throat on the bed this changes nothing (the throat is a cylinder, so the radius is
  already constant); it matters when the wide rim goes down first and the wall is already
  sloping at z=0.

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
(filament default 100%, pellet default 0%) — this is the coat hanger's default **fan
mode**. The alternative, **fan only during bumps / bridging**, keeps the fan off
otherwise and switches it on/off around exactly the segments that need cooling to hold
their shape: a spike's full out+dwell+in sequence (not just the slow move out — the fan
stays on through the move back in too, only turning off once fully back at the wall),
weave's own bump zones, and the wall hanger's slow bridging (bezier/pocket) and
overhang-triggered segments. Useful when the fan has to stay off elsewhere to avoid
warping the base (long thin shapes especially) but the bumps still need to solidify
rigid enough to hold their shape.

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

### Print direction

Coat hanger only. **Counter-clockwise** (default, matches every print from before this
setting existed) or **Clockwise** — reverses which way the nozzle sweeps around the same
outline, seam position and shape otherwise unchanged. Every offset that depends on the
direction of travel (brim rings, hanger pocket, weave lateral push, spike push-out) is
compensated so "inward"/"outward" still mean the same physical directions either way.
Useful for working around an asymmetric part-cooling fan (e.g. one that's off-center or
underperforming on one side) — reversing direction flips which physical side of the
nozzle consistently leads/trails, which can rebalance uneven cooling. Not offered on bend
stool or vessel (their bottom-fill and leg geometry have their own, separate winding
conventions not yet audited for this).

### Patterns

Choose a pattern **type**; each displaces the toolpath sideways along the horizontal
normal (tangent × Z). Settings are split into **general** (shared by all pattern types,
present and future) and **type-specific**:

- **General:** enable, type, amplitude, **Z-angle** (−90…90°; rotates the displacement
  vector in the vertical plane so bumps rise/fall on the way out and reverse on the way
  back — 0° = flat, ±90° = straight up/down), **coverage %** (the patterned band is
  centered on the seam and grows both directions — 100% = whole loop), **patternless
  layers top/bottom**, and a **bottom feedrate** (0 = use the normal print feed) that
  applies only to the patternless bottom revolutions, independent of the main print feed
  — e.g. a much slower start for extra first-layers-out adhesion time without slowing
  the rest of the print.
- **Weave (type-specific: bumps/revolution, bump feedrate):** continuous displacement
  `amplitude · cos(π · (L + u) · bumps)`. Emitted points are the union of base-curve
  vertices (shape fidelity) and bump positions, so the weave is smooth and accurate.
  Because the phase shifts by `(-1)^bumps` per layer, **even bumps/rev = vertical flutes,
  odd = woven**. The bump feedrate is used on bump moves both ways; plain wall moves
  keep the print feed.
- **Random spikes (type-specific: spike density, seed):** blue-noise (Mitchell
  best-candidate) outward "staples" distributed evenly-but-random across the confined
  area — not a taper to a point. **Spike density (spikes / cm²)** replaces a fixed count:
  the actual number placed is `density × (arc length of the patterned band × patterned
  height)`, so the same density setting looks equally sparse or dense whether the shape is
  small or large, short or tall, or coverage/patternless-layer settings shrink the
  patterned band — instead of a fixed count spreading thinner (or bunching tighter) as
  those change. The derived count is rounded to the nearest whole spike and shown in the
  G-code header comment. An optional **spacing balance** toggle (off by default) runs up
  to 30 damped relaxation passes over the blue-noise placement afterward: any pair of
  spikes closer together than an ideal hexagonal-packing spacing for that count and area
  (not a separate input — the most even a fixed number of points can be spread over a
  fixed area) gets nudged apart by half the shortfall, so the distances between neighbors
  converge toward each other instead of spanning a wide range, without adding or removing
  a single spike (density stays exact). This measures actual physical closeness (arc-length
  position and real height, not toolpath order), so two spikes landing at nearly the same
  position on adjacent layers — stacked right on top of each other — are caught by it same
  as any other close pair. Aiming for a very even spacing does trade away some of the
  "randomly scattered" look for consistency — push it hard enough and the layout starts
  reading as regular rather than random — so treat it as a knob between those two
  characters, not a pure bug fix. The stretch of wall each one replaces is pushed straight
  out (a 90° turn away from the wall), continues at that height for exactly the width it
  cut away (the same stretch of wall, just displaced outward — flat, not tapered, since
  both ends sit at the same amplitude), then turns 90° straight back in to rejoin the
  wall. Four 90° turns total: out, along, in, and back onto the wall's own direction. Both
  push-out arms use the SAME direction — the wall's tangent at the staple's own center,
  not each corner's own local tangent — so the two arms stay parallel (and the flat top
  a straight line the same distance out as the arms) even where the underlying curve
  bends sharply over that narrow a span, like inside a double-hanger keyhole's taper or
  cap. Base width = line width (so the inner wall reads as continuous). Deterministic per
  **seed** — change the seed to re-roll. Stays a clean shape even through the hanger and
  transition loops (their dense points are dropped inside the window so it never gets
  pinched narrow). An optional **length variation (± mm)** randomizes each one's length within
  `amplitude ± var` (e.g. amplitude 50, variation 10 → lengths 40–60), deterministic per
  seed and drawn from a stream independent of the placement; the base stays one line
  width, only the length varies. 0 = every one the same length. **Feedrate out**,
  **feedrate tip**, and **feedrate in** are three fully independent inputs — the initial
  90° push out, the flat pushed-out stretch itself, and the move back in each use their
  own value, so slow-out/fast-tip/fast-back-in, slow all three, or anything else is just
  a matter of what's typed in, not a fixed rule (feedrate tip defaults to feedrate out if
  left unset, matching the old behavior before it was split out). An optional **tip dwell
  (s)** inserts a `G4` pause right before heading back in — leave it at 0 for a plain
  back-and-forth with no
  pause (e.g. slow out, slow back in, no dwell at all). Optional **spike line width** and
  **spike layer height** (each 0 = same as the wall) change ONLY the bead cross-section
  used to compute `E` on the push-out/flat-tip/push-back-in moves — the spikes' actual
  XYZ path is still built entirely from the wall's own line width/layer height, so this
  over- or under-extrudes the same physical shape rather than resizing it. Useful for
  printing the spikes with, say, a taller/thinner or flatter/wider bead than the wall
  without touching the wall's own line width or layer height.

### Wall hanger

An optional keyhole-style hanger, with a **hanger mode** dropdown choosing between two
layouts. Only the inputs relevant to the selected mode are shown.

**Single** (the original layout) places one hanger **opposite the seam**. A **gap cutout
%** is removed from the back of the outline; an **insert pocket %** arc centered on the
seam is offset inward by one line width; tangent-matched beziers join the gap edges to
the pocket through the interior, forming a funnel. Keep the pocket % smaller than the
gap % so the beziers have room.

**Double** replaces the one large hanger with two smaller, independent ones, positioned
**opposite the seam** the same way the single hanger's own gap is — this matters because
the spike/weave pattern is centered ON the seam, so keeping the gap (the actually-removed
material) on the far side is what keeps the hanger and the pattern from colliding, same
as it always has for single mode. The same **gap %** input now picks two anchor points at
half that percentage either side of u=0.5 (e.g. 30% → anchors at 50%±15%); at each anchor
a **gap width (mm)** slice is cut (split evenly either side of the anchor) and bridged,
via the same tangent-matched-bezier funnel the single hanger uses, to a **pocket width
(mm)** arc at the mirrored point on the seam side instead (same side as its own gap, not
diametrically opposite it — diametrically opposite would put the two hangers' bridging
beziers on interleaved chords, which always cross, for any anchor spacing). Each hanger
is a self-contained loop spanning roughly a quarter of the perimeter, leaving the seam
and the antipode as plain wall. Because the gap and pocket sit closer together than in
single mode, the funnel beziers have less room to work with, and for a small shape with a
comparatively large gap/pocket width **it can still overlap** — watch for a "the loop
crosses itself" warning after generating, and shrink the gap/pocket width (mm) or grow
the shape/gap % if you see it. The **export profile SVG** button (below) is single-hanger
only for now.

Other inputs — **bottom normal loops** (plain revolutions below), **transition loops**
(the hanger shape tweens back into the base curve over this many revolutions), and
**bridge feedrate** (the first hanger loop bridges over air, so only its new sections —
beziers + pocket — print at this slow feed) — apply to both modes. Patterns (weave/spikes)
stay active through the hanger and transition loops. The 2D preview shows the hanger
loop(s) dashed.

The transition loops aren't stacked directly on top of each other — each point slides
sideways toward the plain profile as the hanger shape washes out — so a steep transition
(few transition loops, or a big gap %) is a real overhang with its own sagging risk, on
top of the single bridging loop above. An **overhang angle** (degrees from vertical) and
**overhang feedrate** cover this: any transition-loop segment whose sideways shift from
the loop directly below it exceeds what the angle allows for the current layer height
prints at the overhang feedrate instead of the normal print feed.

The hanger loop and the plain base curve are resampled at the SAME perimeter-fraction (u)
values for this tween, not independently by arc length — the hanger loop is longer than
the wall it replaces (the funnel bezier cuts a longer path than the straight stretch it
removes), so resampling each one to N points along its own length would land index i on a
different physical spot on each curve, and blending those two would subtly warp the
*entire* silhouette (not just the cutout) as it tweens, tightening every loop in the
transition band. Resampling both at the same u instead means any point away from a
gap/pocket is the exact same point on both curves, so it's completely unaffected by the
tween regardless of which layer it's on — only the gap/pocket itself actually changes.

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
height). **Outer** and **inner line counts** are independent — either or both can be
nonzero, so a single brim can ring both sides of the wall at once. The first line on
each side sits `brimWidth/2 + lineWidth/2` from the base wall (gap-free — exactly one
line width of clearance for the wall itself); each additional line is one brim width
further from the wall on its own side. Print order is fixed, not a choice: each side
always starts at its own far end (outer at the outermost line, inner at the innermost)
and prints TOWARD the wall — the far end is the least supported, so it's laid down
first, with each subsequent line anchoring progressively closer to the already-adhered
wall. Inner brim lines that would cross the shape don't get skipped or keep shrinking
toward the next line's own (smaller) offset — the naive per-vertex-normal offset can fold
back on itself locally well before the overall inradius is reached (a thin shape's
rounded ends especially), which would otherwise let an inner line cross the centerline
and interfere with lines from the opposite edge, or the outer wall. Safety is checked by
containment (every offset point must still land inside the true wall), not just area/
inradius, since those coarser checks can miss a local fold. The safe maximum offset is
found first (lines print far-to-near, so the largest requested offset — checked first —
has no "last one that worked" yet to fall back on otherwise); every line past the safe
range reuses that same maximum instead, so the requested line count still all prints, as
reinforcement at the safe boundary. On the bend stool, inner lines are always skipped
(with a warning) since the disc is solid at the center — only outer applies there.
When a brim is printed, the first travel to the body (wall / disc / bottom) **clears the
brim**: it lifts to twice the brim layer height, moves over, then drops to the start Z, so
the nozzle never drags across the brim on its way in. This applies to all three projects.

An **outer style** setting picks between the plain offset loops above and a **mouse-ear**
brim (coat hanger project, rounded-rectangle shape only): exactly the same offset loops
as a normal outer brim, just with the straight sections dropped — only the corner
(fillet) arcs survive, each printed as its own separate open path instead of one closed
loop. `roundedRect()` never actually generates a plain "straight" point — every sample
point already lies on one of the 4 corner arcs, and the straight side is purely the
implicit connecting segment between the last point of one arc and the first point of the
next — so a point can't be classified as "arc vs. straight" on its own. Instead each
point is labeled with which corner it belongs to (nearest corner whose radius matches,
within tolerance), and a straight section is wherever that label changes between
consecutive points; a run of points sharing one label is one corner's arc. This
naturally merges a "stadium" shape's two coincident corners (fillet = half the width)
into one combined half-circle ear per end, since both corners land on the same label.
Sharp corners (fillet = 0) print nothing, with a warning — there's no arc to keep. No
clipping, no completed circles: each of the N offset rings is still the same arc a normal
brim would use, just missing its straight sections.

The N rings ARE chained together, though — grouped by mouse ear (corner) rather than by
ring. For one corner, the outermost ring prints first (far end first, same as every other
brim), then each ring further in prints in the OPPOSITE direction from the one before it
— since ring k and ring k+1 are the same arc at adjacent radii, ring k's end point sits
right next to (one line width from) ring k+1's start point when read backwards, so the
travel between them is just that one line width instead of a retract-and-dash back to a
shared start. One corner's whole stack prints as a single boustrophedon (zigzag) chain
before moving to the next corner, instead of interleaving all 4 corners at every ring —
cuts total brim travel distance dramatically (about 70% on a typical shape) with the
exact same printed geometry, just reordered. Selecting mouse-ear anywhere it doesn't
apply (bend stool; vessel; any non-rounded-rectangle shape) falls back to a normal outer
brim with a warning rather than failing.

## Inputs

- **Printer & material:** printer mode (pellet/filament), extrusion multiplier,
  end lift above print (mm, default 50 — the clearance the nozzle rises to after the last
  move so the part can be finished by hand; measured ABOVE the tallest printed point, so
  it can never drive down into the print),
  start/end toggle; filament → diameter, nozzle temp, bed temp, fan %; pellet → 3 zone
  temps, bed temp, pressure advance, purge quantity, fan %; material density (g/cm³)
  and material price (per kg), each 0 = skip, for a raw material cost estimate
  alongside the print time (also on the bend stool, accounting for its foam mode;
  not on vessel or spoon).
- **Shape:** circle (radius); rounded rectangle (width, length, fillet); ellipse;
  polygon; star; squircle.
- **Print:** layer height, line width, total height, print feed, travel feed,
  chord tolerance, seam side, bed center X/Y.
- **Pattern:** enable, amplitude, bumps/revolution, coverage %, patternless layers
  top/bottom, bottom feedrate.
- **Brim:** enable, outer style (normal/mouse ear), outer lines, inner lines, brim line
  width, brim layer height, brim feedrate, brim extrusion multiplier (0 = same as the
  wall's) — a line printed flat on the bed spreads differently from a wall bead, so it
  gets its own. It's absolute, not relative: brim 1.0 against a wall multiplier of 2.0
  extrudes at 1.0. Present on every project that has a brim (coat hanger, bend stool,
  vessel, lampshade).

The **Spoon** tab has its own, much smaller set: printer & material (identical fields to
above), turns, start radius, stick length, layers, layer height, line width, print feed,
travel feed, bed center X/Y — no shape, pattern, brim, or hanger options.

The **Lampshade** tab: printer & material (identical fields to above), socket
(E14/E27/custom), fit tolerance, shade shape (cone / bell / dome / sphere) and its own
parameter (transition height, max angle, or sphere ⌀), throat length, fillet radius,
bottom opening ⌀, print orientation, line width, print feed, travel feed, chord
tolerance, bed center X/Y, overhang compensation mode/strength/max multiplier, an optional
constant-volumetric-flow targets for throat and shade plus their ramp height, and an
outer-only brim — **no layer height**, which is
the socket's thread pitch.

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
