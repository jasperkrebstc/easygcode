/*
 * gcode.js — vase-mode G-code generation.
 *
 * Conventions (locked with the user):
 *   - Absolute positioning (G90), relative extrusion (M83).
 *   - Volumetric extrusion: every G1 E is the segment volume in mm^3.
 *   - Optional start/end G-code per printer mode (Klipper pellet / Marlin).
 *
 * Bead cross-section ("stadium"): beadArea(w,h) = (w-h)*h + PI*(h/2)^2
 *
 * Pipeline: adaptive base curve (chord tolerance) -> seam at the chosen axis
 * crossing -> continuous spiral, where each revolution is one of:
 *   - normal loop (optional weave/spikes pattern, seam-centered coverage)
 *   - the wall-hanger loop: back gap + inward pocket at the seam joined by
 *     tangent beziers (new sections print at the bridge feedrate)
 *   - tween loops that morph the hanger loop back into the base curve
 * Pattern displacement is suppressed on hanger + tween loops.
 *
 * Exposed on window.GcodeGen.
 */
(function () {
  'use strict';

  const Geo = window.Geo;

  function beadArea(w, h) {
    const ww = Math.max(w, h);
    return (ww - h) * h + Math.PI * (h / 2) * (h / 2);
  }

  // Smooth radius profile through control points {h, s} (sorted, h in [0,1]).
  // Catmull-Rom for a natural curve through the points; scale clamped to a
  // small positive minimum so the wall can never collapse or invert.
  function makeProfile(cps) {
    return function (hf) {
      const x = Math.max(0, Math.min(1, hf));
      if (cps.length === 1) return Math.max(0.05, cps[0].s);
      let i = 0;
      while (i < cps.length - 2 && x > cps[i + 1].h) i++;
      const p1 = cps[i];
      const p2 = cps[i + 1];
      const p0 = cps[i - 1] || p1;
      const p3 = cps[i + 2] || p2;
      const t = (x - p1.h) / ((p2.h - p1.h) || 1e-9);
      const t2 = t * t;
      const t3 = t2 * t;
      const s =
        0.5 *
        (2 * p1.s +
          (-p0.s + p2.s) * t +
          (2 * p0.s - 5 * p1.s + 4 * p2.s - p3.s) * t2 +
          (-p0.s + 3 * p1.s - 3 * p2.s + p3.s) * t3);
      return Math.max(0.05, s);
    };
  }

  const f3 = (v) => v.toFixed(3);
  const f5 = (v) => v.toFixed(5);
  const dist3 = (a, b) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

  // Small seeded PRNG (deterministic) for the spike layout.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Mitchell's best-candidate sampling -> blue-noise points in [sMin,sMax]x[zMin,zMax].
  function bestCandidate(count, sMin, sMax, zMin, zMax, seed) {
    const rng = mulberry32(seed);
    const pts = [];
    const k = 15;
    for (let i = 0; i < count; i++) {
      let best = null;
      let bestD = -1;
      const tries = pts.length === 0 ? 1 : k;
      for (let c = 0; c < tries; c++) {
        const s = sMin + rng() * (sMax - sMin);
        const z = zMin + rng() * (zMax - zMin);
        let dmin = Infinity;
        for (let j = 0; j < pts.length; j++) {
          const dd = Math.hypot(s - pts[j].s, z - pts[j].z);
          if (dd < dmin) dmin = dd;
        }
        if (dmin > bestD) {
          bestD = dmin;
          best = { s, z };
        }
      }
      pts.push(best);
    }
    return pts;
  }

  // Best-candidate is only an approximation of true blue noise — nearest-
  // neighbor spacing across the field still varies more than it would in an
  // evenly-packed layout. This nudges any pair closer than a target spacing
  // apart by half their shortfall (damped, so many simultaneous violations
  // near one point don't overshoot), a few rounds, so distances converge
  // toward that target instead of spanning a wide range — no culling (so the
  // point count, and therefore density, never changes), no exposed min/max
  // distance (the target is derived from the area and count themselves, the
  // same way the density setting already is). The target is the spacing of
  // an ideal hexagonal packing of n points over the domain's area (each
  // point's Voronoi cell a regular hexagon of area/n, side-to-side distance
  // solved from that) — the most even a fixed number of points can be spread
  // over a fixed area, so aiming for it (without requiring it exactly, since
  // clamping to the domain and the placement's own randomness keep the
  // result short of a perfect grid) tightens the spread of distances as much
  // as a simple pairwise pass can. Not a full physics simulation: symmetric
  // pairwise correction converges in a few dozen iterations at the point
  // counts spikes run at (tens to a few hundred), same idea as the "resolve
  // overlaps" step in force-directed layouts.
  function relaxSpacing(pts, sMin, sMax, zMin, zMax) {
    const n = pts.length;
    if (n < 2) return pts;
    const area = (sMax - sMin) * (zMax - zMin);
    const target = Math.sqrt((2 / Math.sqrt(3)) * (area / n));
    const ITERS = 30;
    const DAMP = 0.5;
    for (let iter = 0; iter < ITERS; iter++) {
      const dx = new Array(n).fill(0);
      const dz = new Array(n).fill(0);
      let anyClose = false;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const ddx = pts[j].s - pts[i].s;
          const ddz = pts[j].z - pts[i].z;
          const dist = Math.hypot(ddx, ddz);
          if (dist < 1e-9) {
            // Coincident (practically never happens) — nudge apart along an
            // arbitrary axis so the next iteration has a direction to use.
            anyClose = true;
            dx[i] -= target * 0.5;
            dx[j] += target * 0.5;
          } else if (dist < target) {
            anyClose = true;
            const push = (target - dist) * 0.5 * DAMP;
            const nx = ddx / dist;
            const nz = ddz / dist;
            dx[i] -= nx * push;
            dz[i] -= nz * push;
            dx[j] += nx * push;
            dz[j] += nz * push;
          }
        }
      }
      if (!anyClose) break;
      for (let i = 0; i < n; i++) {
        pts[i].s = Math.min(sMax, Math.max(sMin, pts[i].s + dx[i]));
        pts[i].z = Math.min(zMax, Math.max(zMin, pts[i].z + dz[i]));
      }
    }
    return pts;
  }

  // ---- Start / end G-code builders ----
  // Values that change per material are injected; everything else is kept
  // fixed from the user's proven start/end files (cleaned up).

  function marlinStart(f) {
    return [
      '; --- start G-code (filament / Marlin) ---',
      'M140 S' + f.bed + ' ; set bed temp',
      'M104 S' + f.nozzle + ' ; set hotend temp (heats during bed wait + homing)',
      'M190 S' + f.bed + ' ; wait for bed temp',
      'G28 ; home all (incl. mesh bed level)',
      'G90 ; absolute coordinates',
      'G21 ; millimeter units',
      'M83 ; relative extrusion',
      'G0 F3000 X10.0 Y10.0 ; park',
      'M109 S' + f.nozzle + ' ; wait for hotend temp',
      'G1 F250 E20.788 ; load / prime nozzle',
      'G0 F8000 Z0.3',
      'M220 S100 ; reset speed factor',
      'M221 S100 ; reset extrude factor',
      '; primer lines',
      'G0 F8000 X50.0 Y14.0 Z0.2',
      'G1 F500 X110.0 E12',
      'G1 Y12.0 E0.5',
      'G1 X50.0 E12',
      'G1 Y14.0 E0.5',
      'G1 Y16.0 E0.5',
      'G1 X80.0 E4',
      'G1 Y45.2 E3',
      'M106 S0 ; fan off for the ramp loop',
      '; --- end of start G-code ---',
    ];
  }

  function marlinEnd(zLift) {
    return [
      '; --- end G-code (filament / Marlin) ---',
      'M83',
      'G1 E-0.8 F3000 ; retract',
      'G90 ; absolute coordinates',
      'G0 Z' + f3(zLift) + ' F8000 ; lift clear (5x tallest print height) for finishing',
      'M106 S0 ; fan off',
      'M140 S0 ; bed off',
      'M104 S0 ; hotend off',
      'M221 S100 ; reset flow',
      'M900 K0 ; reset linear advance',
      'M84 ; disable steppers',
    ];
  }

  function klipperStart(p) {
    // Bed wait window derived from the target (reproduces 40/90 at bed 50).
    const bedMin = Math.max(0, Math.round(p.bed - 10));
    const bedMax = Math.round(p.bed + 40);
    return [
      '; --- start G-code (pellet / Klipper) ---',
      'SET_PRESSURE_ADVANCE EXTRUDER=extruder SMOOTH_TIME=0.04',
      'SET_PRESSURE_ADVANCE EXTRUDER=extruder ADVANCE=0.0',
      '_GINGER_BUZZER_TONE_INITIAL',
      '_GINGER_BED_HEATING BED_TEMPERATURE=' + p.bed,
      '_GINGER_EXTRUDER_SET_UP S=' + p.up,
      '_GINGER_EXTRUDER_SET_MID S=' + p.mid,
      '_GINGER_EXTRUDER_SET_DOWN S=' + p.down,
      'G28 ; home',
      'BED_MESH_PROFILE LOAD=global',
      '_GINGER_PURGE_PARKING PURGE_LAYER_HEIGHT=2 PURGE_PARKING_SPEED=10000',
      '_GINGER_EXTRUDER_WAIT_UP S=' + p.up,
      '_GINGER_EXTRUDER_WAIT_MID S=' + p.mid,
      '_GINGER_EXTRUDER_WAIT_DOWN S=' + p.down,
      '_GINGER_BED_WAIT BED_TEMPERATURE_MIN=' + bedMin + ' BED_TEMPERATURE_MAX=' + bedMax,
      '_GINGER_EXTRUDER_MIXING_MULTIPLIER S=1',
      'SET_EXTRUDER_ROTATION_DISTANCE EXTRUDER=extruder DISTANCE=456',
      'SET_EXTRUDER_ROTATION_DISTANCE EXTRUDER=mixing_stepper DISTANCE=8000',
      // PURGE_LENGHT [sic]: parameter name must match the printer macro.
      '_GINGER_PURGE PURGE_LENGHT=400 PURGE_SPEED=500 PURGE_MATERIAL_QUANTITY=' + p.purge,
      'G90 ; absolute coordinates',
      'G92 E0',
      'M83 ; relative extrusion',
      'M220 S100 ; reset speed factor',
      'M221 S100 ; reset extrude factor',
      'SET_PRESSURE_ADVANCE EXTRUDER=extruder ADVANCE=' + p.pa,
      'SET_PRESSURE_ADVANCE EXTRUDER=extruder SMOOTH_TIME=0.5',
      'M106 S0 ; fan off for the ramp loop',
      '_GINGER_BUZZER_TONE_INITIAL',
      '; --- end of start G-code ---',
    ];
  }

  function klipperEnd(zLift) {
    return [
      '; --- end G-code (pellet / Klipper) ---',
      'M83',
      'G90 ; absolute coordinates',
      'G0 Z' + f3(zLift) + ' F3000 ; lift clear (5x tallest print height) for finishing',
      'TURN_OFF_HEATERS ; zones + bed off',
      'M106 S0 ; fan off',
      'M84 ; disable steppers',
    ];
  }

  // Angles of the three legs: one pointing left, two right (Mercedes rotated),
  // so the seam at 0 deg (right) sits in the gap between the two right legs.
  const LEG_ANGLES = [Math.PI, Math.PI / 3, -Math.PI / 3];

  // Fixed bed-fit rotation for the bend stool: the 3-leg layout is roughly
  // triangular, and 15 deg fits a rectangular bed noticeably better than
  // printing it axis-aligned. See the bsFit/bsShiftX/Y setup in generate().
  const BS_ROTATION_DEG = 15;

  // Fixed bed-fit rotation for the spoon: the shape is a disc with a long
  // straight stick off one side, so its own bounding box (axis-aligned) is
  // much longer than it is wide — 45 deg tilts that long axis onto a square
  // bed's diagonal, the longest straight line the bed offers, fitting a
  // longer spoon (or needing a smaller bed) than printing it axis-aligned.
  const SPOON_ROTATION_DEG = 45;

  // Rotated + bed-centered bounding box of an outline (shape-centered input
  // points). Shared by generate() and the 2D preview so both agree on
  // exactly the same numbers. Returns the box size and the shift that recenters
  // it on (centerX, centerY) — apply as: rotate(p) + {shiftX, shiftY} + {centerX, centerY}.
  // angleDeg defaults to the bend stool's own fixed rotation so its existing
  // callers are unaffected; the spoon passes its own (45 deg).
  function discBedFit(outline, centerX, centerY, angleDeg) {
    const rotRad = ((angleDeg != null ? angleDeg : BS_ROTATION_DEG) * Math.PI) / 180;
    const cosR = Math.cos(rotRad);
    const sinR = Math.sin(rotRad);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    (outline || []).forEach((p) => {
      const rx = p.x * cosR - p.y * sinR;
      const ry = p.x * sinR + p.y * cosR;
      if (rx < minX) minX = rx;
      if (rx > maxX) maxX = rx;
      if (ry < minY) minY = ry;
      if (ry > maxY) maxY = ry;
    });
    if (!isFinite(minX)) return { width: 0, height: 0, cosR: cosR, sinR: sinR, shiftX: 0, shiftY: 0 };
    return {
      width: maxX - minX,
      height: maxY - minY,
      cosR: cosR,
      sinR: sinR,
      shiftX: -(minX + maxX) / 2,
      shiftY: -(minY + maxY) / 2,
    };
  }

  // Dome layer-height range (used by the generator and the 2D preview, so both
  // agree on exactly the same numbers) — the smallest bead height is the
  // domed innermost ring (dome x lh), the largest is the nominal lh (every
  // edge ring, plus the always-full-height first/top layers). Undomed discs
  // have a single uniform height (hMin === hMax).
  function domeHeightRange(cfg) {
    const spec = discSpec(cfg);
    const lh = cfg.layerHeight;
    const dm = Math.max(0.05, Math.min(1, cfg.disc.dome != null ? cfg.disc.dome : 1));
    const domed = spec.ringN > 1 && dm < 1 - 1e-9;
    return { hMin: domed ? lh * dm : lh, hMax: lh, domed: domed };
  }

  // Shared disc + legs parameter derivation (used by the generator and the 2D
  // preview). Returns ring layout, snapped values, and leg spec or null.
  function discSpec(cfg) {
    const warnings = [];
    const lw = cfg.lineWidth;
    const ringN = Math.max(1, Math.round(cfg.disc.diameter / (2 * lw)));
    const snappedD = 2 * ringN * lw;
    if (Math.abs(snappedD - cfg.disc.diameter) > 1e-9) {
      warnings.push(
        'Disc diameter snapped to ' + snappedD + ' mm (' + ringN + ' rings; valid sizes step by ' +
          2 * lw + ' mm with ' + lw + ' mm lines).'
      );
    }
    const radii = [];
    for (let i = 0; i < ringN; i++) radii.push(lw / 2 + i * lw);

    let legs = null;
    const lc = cfg.disc.legs;
    if (lc && lc.enabled) {
      let m = Math.max(1, Math.round(lc.width / (2 * lw)));
      const snappedW = 2 * m * lw;
      if (Math.abs(snappedW - lc.width) > 1e-9) {
        warnings.push('Leg width snapped to ' + snappedW + ' mm (' + m + ' hairpin pair' + (m > 1 ? 's' : '') + ').');
      }
      if (m > ringN - 1) {
        m = Math.max(1, ringN - 1);
        warnings.push('Leg width clamped to ' + 2 * m * lw + ' mm — at least one plain center ring must remain.');
      }
      const fillet = Math.max(0, lc.fillet || 0);
      const rimR = ringN * lw; // outer bead edge of the seat
      // Concentric tip caps: outer plastic tip = tipCenter + m*lw. Seat height
      // is measured rim edge -> tip edge, so:
      const tipCenter = rimR + lc.seatHeight - m * lw;
      // The straight side must have positive length on the outermost curve.
      const R0 = radii[ringN - 1];
      const d0 = m * lw - lw / 2;
      const f0 = fillet;
      const t0 = Math.sqrt(Math.max(0, (R0 + f0) * (R0 + f0) - (d0 + f0) * (d0 + f0)));
      const minSeat = Math.ceil(t0 - rimR + m * lw + lw);
      if (tipCenter <= t0 + 1e-6) {
        warnings.push('Seat height too small for these legs (need at least ~' + minSeat + ' mm) — legs disabled.');
        legs = null;
      } else if (Math.atan2(d0 + f0, t0) > Math.PI / 3 - 0.02) {
        warnings.push('Leg width + fillet too large — junctions would collide (legs are 120° apart). Legs disabled.');
        legs = null;
      } else {
        legs = { m: m, snappedW: 2 * m * lw, tipCenter: tipCenter, fillet: fillet };
      }
    }
    const at = cfg.disc.attractor;
    if (at && at.enabled && !legs) {
      warnings.push('Bend-zone spread needs legs enabled — ignored.');
    }
    return { lw: lw, ringN: ringN, snappedD: snappedD, radii: radii, legs: legs, warnings: warnings };
  }

  // Build the per-ring polylines for a bend-stool disc in the chosen seam
  // style. Returns loops ordered inner->outer; each loop starts where the
  // previous one ends (angle-wise), so the segment between them is the radial
  // connector.
  // - 'staircase': all rings CCW; each stops one line width before its start,
  //   so the seam drifts by lw/r per ring (anchored at the outermost ring
  //   when legs are on).
  // - 'alternating': every other ring flips direction; each ring turns around
  //   half a line width before the seam line, so the seam never moves (a
  //   fixed "zipper" with hard U-turns at the connectors).
  // attrScale (0..1, default 1) scales the attractor displacement — used for
  // the vertical gradient: bottom layer 0 (lines collected), top layer 1
  // (maximum spread), linear in between.
  function discLoops(cfg, specIn, attrScale) {
    const scale = attrScale == null ? 1 : attrScale;
    const spec = specIn || discSpec(cfg);
    const lw = cfg.lineWidth;
    const tol = cfg.tolerance > 0 ? cfg.tolerance : 0.05;
    const n = spec.ringN;
    const legs = spec.legs;
    const alt = cfg.disc.seamStyle === 'alternating';
    const s0 = legs ? 0 : Math.PI / 2; // seam anchor angle

    function legFor(i) {
      if (!legs || i < n - legs.m) return null;
      const h = n - 1 - i;
      return {
        d: (legs.m - h) * lw - lw / 2,
        f: legs.fillet + h * lw,
        tipCenter: legs.tipCenter,
        angles: LEG_ANGLES,
      };
    }

    // Bend-zone attractor spread (legged loops only): hairpin q counted from
    // the spine outward moves (2q+1)/2 x gap x lw, so all spacings inside R1
    // become lw + gap*lw.
    const at = cfg.disc.attractor;
    const attrOn = !!(legs && at && at.enabled && at.r1 > 0 && at.r2 > at.r1 && at.gap > 0);
    let attrPts = null;
    if (attrOn) {
      const A = n * lw + (Number.isFinite(at.pos) ? at.pos : 0); // rim + offset
      attrPts = LEG_ANGLES.map((phi) => ({ x: A * Math.cos(phi), y: A * Math.sin(phi) }));
    }
    function attrFor(i) {
      if (!attrOn || scale <= 0 || i < n - legs.m) return null;
      const q = i - (n - legs.m);
      const Dfull = ((2 * q + 1) * at.gap * lw) / 2;
      // Lateral part of the overhang drop: compress the spread toward the spine
      // by drop * (Dfull / Dmax) = drop * (2q+1)/(2m-1). Combined with the
      // accumulating z-drop the move follows the overhang slope (angle kept).
      const T = Math.max(1, Math.round((cfg.disc && cfg.disc.layers) || 1));
      const drop = Math.max(0, Math.min(1, at.drop || 0));
      const slopeK = T > 1 && drop > 0 ? (drop * (2 * q + 1)) / (2 * legs.m - 1) : 0;
      return { points: attrPts, r1: at.r1, r2: at.r2, D: Dfull * scale, slopeK: slopeK };
    }

    const loops = [];
    if (alt) {
      // Zipper: the seam gap is a straight SLOT — the seam ray offset both
      // ways by half a line width. Each ring turns around where it crosses
      // those two parallel lines: at angle asin((lw/2)/r) off the seam, whose
      // perpendicular distance from the seam ray is exactly lw/2 on every
      // ring. All turnaround points sit on the two lines, so the U-turn
      // connectors run along them — parallel, one line width apart, filling
      // the slot with no gaps. Every other ring is reversed; the seam is fixed.
      for (let i = 0; i < n; i++) {
        const del = Math.asin(Math.min(1, lw / 2 / spec.radii[i]));
        const cw = i % 2 === 1;
        const pts = Geo.stoolLoop({
          r: spec.radii[i],
          tol: tol,
          aStart: s0 + del,
          gapAng: 2 * del,
          leg: legFor(i),
          attr: attrFor(i),
        });
        if (cw) pts.reverse();
        loops.push(pts);
      }
    } else {
      const starts = new Array(n);
      if (legs) {
        starts[n - 1] = 0;
        for (let i = n - 2; i >= 0; i--) starts[i] = starts[i + 1] + lw / spec.radii[i];
      } else {
        starts[0] = Math.PI / 2;
        for (let i = 1; i < n; i++) starts[i] = starts[i - 1] - lw / spec.radii[i - 1];
      }
      for (let i = 0; i < n; i++) {
        loops.push(
          Geo.stoolLoop({
            r: spec.radii[i],
            tol: tol,
            aStart: starts[i],
            gapAng: lw / spec.radii[i],
            leg: legFor(i),
            attr: attrFor(i),
          })
        );
      }
    }
    // Closed outermost outline (no seam gap) — brim base and preview.
    const outline = Geo.stoolLoop({
      r: spec.radii[n - 1],
      tol: tol,
      aStart: 0,
      gapAng: 0,
      leg: legFor(n - 1),
      attr: attrFor(n - 1),
    });
    if (outline.length > 1 && Geo.dist(outline[0], outline[outline.length - 1]) < 1e-6) outline.pop();
    return { spec: spec, loops: loops, outline: outline, attrOn: attrOn };
  }

  // Spoon: a flat Archimedean spiral + straight stick, stacked as identical
  // passes at rising Z (not vase-mode — every layer is the same flat path,
  // just one layerHeight higher, like stacking N solid coasters). Simple
  // enough, and different enough in shape from the other three projects'
  // spiral-wall vase mode, that it's kept as its own fully separate
  // function rather than threaded through generate()'s existing branching —
  // zero risk of disturbing coat hanger/bend stool/vessel output.
  function generateSpoon(cfg) {
    const warnings = [];
    const lines = [];
    const path = [];
    let totalVolume = 0;
    let pathLength = 0;
    let moveCount = 0;

    const cx = cfg.centerX;
    const cy = cfg.centerY;
    const lh = cfg.layerHeight;
    const lw = cfg.lineWidth;

    if (!(lw > 0) || !(lh > 0)) {
      return {
        gcode: '; ERROR: invalid line width/layer height',
        warnings: ['Enter a valid line width and layer height.'],
        stats: { volume: 0, pathLength: 0, moves: 0, loops: 0, timeMin: 0 },
        path: [],
      };
    }
    if (lw < lh) {
      warnings.push('Line width is less than layer height — bead width clamped to layer height.');
    }

    const sp = cfg.spoon || {};
    const turns = Math.max(0, sp.turns || 0);
    const startRadius = Math.max(0, sp.startRadius || 0);
    const stickLength = Math.max(0, sp.stickLength || 0);
    const layers = Math.max(1, Math.round(sp.layers || 1));

    if (turns <= 0 && stickLength <= 0) {
      return {
        gcode: '; ERROR: nothing to print',
        warnings: ['Enter at least some turns or a stick length.'],
        stats: { volume: 0, pathLength: 0, moves: 0, loops: 0, timeMin: 0 },
        path: [],
      };
    }

    const tol = 0.05; // fixed — the spiral is a single analytic curve, not worth a UI field
    let spiralPts = Geo.spoonPath(turns, startRadius, lw, stickLength, tol);
    // 'stick' starts at the stick's far tip and winds IN to the center
    // (pure array reversal — same points, same shape, opposite travel
    // order; nothing here depends on the local tangent direction the way
    // the coat hanger's offset/pattern math does, so no compensating sign
    // is needed anywhere else).
    if (sp.startPoint === 'stick') spiralPts = spiralPts.slice().reverse();
    // Bed-fit: rotate 45 deg (the disc+stick shape's long axis onto the bed's
    // diagonal) and recenter the ROTATED bounding box on (centerX, centerY) —
    // shared with the 2D preview so both agree on the exact same numbers.
    const spoonFit = discBedFit(spiralPts, cx, cy, SPOON_ROTATION_DEG);
    spiralPts = spiralPts.map((p) => ({
      x: p.x * spoonFit.cosR - p.y * spoonFit.sinR + spoonFit.shiftX,
      y: p.x * spoonFit.sinR + p.y * spoonFit.cosR + spoonFit.shiftY,
    }));
    const area = beadArea(lw, lh);
    // Stick can extrude as if printed with a different line width/layer
    // height than the spiral — 0 (either field) means "same as spiral," the
    // ordinary bead area. This ONLY changes the bead cross-section used to
    // compute E on the stick's own segment; its XYZ geometry (length,
    // direction, Z) is still governed entirely by the spiral's own
    // lineWidth/layerHeight, same idea as the coat hanger's per-spike
    // extrusion override. The stick is always exactly one straight segment
    // (Geo.spoonPath appends a single point past the last spiral point), so
    // identifying it is just "the first segment" (stick-first direction) or
    // "the last segment" (center-first) of the walked array — no per-point
    // tagging needed.
    const stickLineWidth = sp.stickLineWidth > 0 ? sp.stickLineWidth : lw;
    const stickLayerHeightForArea = sp.stickLayerHeight > 0 ? sp.stickLayerHeight : lh;
    const stickArea =
      stickLength > 0 && (sp.stickLineWidth > 0 || sp.stickLayerHeight > 0)
        ? beadArea(stickLineWidth, stickLayerHeightForArea)
        : null;
    const stickSegAt = stickLength > 0 ? (sp.startPoint === 'stick' ? 1 : spiralPts.length - 1) : -1;

    // ---- Volumetric flow feed mode ----
    // Same idea as the bend stool's own constant-flow toggle: hold a target
    // mm^3/s and derive feed from EACH segment's own bead area, instead of a
    // fixed printFeed. Since the stick can have its own bead area (the
    // override above), the two derived feeds are independent — a thinner
    // stick bead prints faster, a thicker one slower, at the same flow. Off
    // by default (byte-identical to a fixed printFeed).
    const flowCfg = sp.flowFeed || {};
    const flowOn = !!flowCfg.enabled && flowCfg.rate > 0;
    const areaStickEff = stickArea != null ? stickArea : area;
    // A manual stick feed (0 = same as spiral) only applies in constant-feed
    // mode — flow mode's whole point is deriving feed automatically, so it
    // takes priority over a manual override when both are set.
    function feedForArea(a, isStick) {
      if (flowOn) return (flowCfg.rate * 60) / Math.max(a, 1e-6);
      if (isStick && sp.stickFeed > 0) return sp.stickFeed;
      return cfg.printFeed;
    }
    const spiralFeed = feedForArea(area, false);
    const stickFeed = feedForArea(areaStickEff, true);

    // ---- Printer / extrusion mode (same convention as generate()) ----
    const printer = cfg.printer || {};
    const mode = printer.mode === 'filament' ? 'filament' : 'pellet';
    const mult = printer.multiplier > 0 ? printer.multiplier : 1;
    const fil = printer.filament || {};
    const pel = printer.pellet || {};
    const filDia = fil.diameter > 0 ? fil.diameter : 1.75;
    const eFactor = mult / (mode === 'filament' ? Math.PI * (filDia / 2) * (filDia / 2) : 1);
    const includeStartEnd = !!printer.includeStartEnd;
    // Same as the lampshade: the start G-code parks the fan off, so it has to
    // be switched back on here or it never runs.
    const fanPct = mode === 'filament' ? fil.fan || 0 : pel.fan || 0;
    const fanPWM = Math.round(Math.max(0, Math.min(100, fanPct)) * 2.55);

    lines.push('; EasyGCode — spoon (spiral + stick) generator');
    lines.push('; ' + new Date().toISOString());
    lines.push(
      '; turns=' + turns + ' startRadius=' + startRadius + ' stickLength=' + stickLength + ' layers=' + layers +
        ' startPoint=' + (sp.startPoint === 'stick' ? 'stick' : 'center')
    );
    lines.push(
      '; layerHeight=' + lh + ' lineWidth=' + lw +
        (stickArea != null
          ? ' stickExtrusion=' + stickLineWidth + 'x' + stickLayerHeightForArea + 'mm (geometry unaffected)'
          : '')
    );
    lines.push(
      '; bed-fit: rotated ' + SPOON_ROTATION_DEG + ' deg, bounding box ' + spoonFit.width.toFixed(1) +
        ' x ' + spoonFit.height.toFixed(1) + ' mm, centered at bed (' + cx + ', ' + cy + ')'
    );
    lines.push(
      flowOn
        ? '; volumetric flow mode: target ' + flowCfg.rate + ' mm3/s -> spiralFeed=' +
          spiralFeed.toFixed(0) + ' stickFeed=' + stickFeed.toFixed(0) + ' mm/min (bead area ' +
          area.toFixed(2) + ' / ' + areaStickEff.toFixed(2) + ' mm2)'
        : '; constant feed: spiralFeed=' + spiralFeed.toFixed(0) + ' stickFeed=' + stickFeed.toFixed(0) +
          ' mm/min -> volumetric flow spiral=' + ((spiralFeed * area) / 60).toFixed(2) + ' stick=' +
          ((stickFeed * areaStickEff) / 60).toFixed(2) + ' mm3/s (bead area ' + area.toFixed(2) + ' / ' +
          areaStickEff.toFixed(2) + ' mm2)'
    );
    lines.push(
      '; printer=' + mode + ' multiplier=' + mult +
        (mode === 'filament' ? ' filamentDiameter=' + filDia + ' (E in mm of filament)' : ' (E in mm^3, volumetric)')
    );
    if (includeStartEnd) {
      (mode === 'filament' ? marlinStart(fil) : klipperStart(pel)).forEach((l) => lines.push(l));
    }
    lines.push('G90 ; absolute positioning');
    lines.push('M83 ; relative extrusion');

    let prev = null;
    let lastFeed = null;
    let firstExtrude = true;
    let maxZEver = 0;
    function noteZ(z) {
      if (z > maxZEver) maxZEver = z;
    }
    function travelAbs(cur) {
      lines.push('G0 X' + f3(cur.x) + ' Y' + f3(cur.y) + ' Z' + f3(cur.z) + ' F' + Math.round(cfg.travelFeed));
      lastFeed = cfg.travelFeed;
      path.push({ x: cur.x, y: cur.y, z: cur.z, travel: true, feed: cfg.travelFeed });
      prev = cur;
      moveCount++;
    }
    function hopTravel(dest, clearMargin) {
      const clearZ = Math.max(prev.z, dest.z, clearMargin);
      if (clearZ > prev.z + 1e-6) travelAbs({ x: prev.x, y: prev.y, z: clearZ });
      travelAbs({ x: dest.x, y: dest.y, z: clearZ });
      if (dest.z < clearZ - 1e-6) travelAbs(dest);
    }
    function emitSeg(cur, feed, areaOvr) {
      const segLen = dist3(prev, cur);
      if (segLen < 1e-7) {
        prev = cur;
        return;
      }
      const dVol = (areaOvr || area) * segLen;
      totalVolume += dVol;
      pathLength += segLen;
      let line = 'G1 X' + f3(cur.x) + ' Y' + f3(cur.y) + ' Z' + f3(cur.z) + ' E' + f5(dVol * eFactor);
      if (feed !== lastFeed || firstExtrude) {
        line += ' F' + Math.round(feed);
        lastFeed = feed;
      }
      lines.push(line);
      path.push({ x: cur.x, y: cur.y, z: cur.z, travel: false, feed: feed });
      firstExtrude = false;
      moveCount++;
      prev = cur;
      noteZ(cur.z);
    }

    for (let L = 0; L < layers; L++) {
      const z = (L + 1) * lh;
      const start = { x: spiralPts[0].x + cx, y: spiralPts[0].y + cy, z: z };
      if (prev === null) {
        travelAbs(start);
      } else {
        hopTravel(start, z);
      }
      for (let i = 1; i < spiralPts.length; i++) {
        const isStickSeg = i === stickSegAt;
        emitSeg(
          { x: spiralPts[i].x + cx, y: spiralPts[i].y + cy, z: z },
          isStickSeg ? stickFeed : spiralFeed,
          isStickSeg ? stickArea : null
        );
      }
      if (L === 0 && includeStartEnd && fanPWM > 0) {
        lines.push('M106 S' + fanPWM + ' ; part cooling fan on after first layer');
      }
    }

    if (includeStartEnd) {
      const endLift = Math.max(5 * maxZEver, mode === 'filament' ? 5 : 10);
      (mode === 'filament' ? marlinEnd(endLift) : klipperEnd(endLift)).forEach((l) => lines.push(l));
    }

    let timeMin = 0;
    for (let i = 1; i < path.length; i++) {
      const d = dist3(path[i - 1], path[i]);
      if (path[i].feed > 0) timeMin += d / path[i].feed;
    }
    // No foam mode here, so the "actual" numbers are just the nominal ones —
    // same fields as generate()'s stats, so app.js can read them uniformly.
    const stats = {
      volume: totalVolume,
      pathLength: pathLength,
      moves: moveCount,
      loops: layers,
      timeMin: timeMin,
      materialVolume: totalVolume,
      actualTimeMin: timeMin,
    };
    return { gcode: lines.join('\n') + '\n', warnings, stats, path };
  }

  // Standard lampholder shade-ring threads (IEC 60399 "barrel thread for
  // lampholders with shade holder ring" — the external thread the decorative
  // ring screws onto, NOT the M10x1 internal fixing thread most searches turn
  // up). The printed throat is a plain helix whose pitch matches the socket's,
  // so the socket's thread crests groove into the inside of the wall as it is
  // screwed on — which means the LAYER HEIGHT is not a free setting on this
  // project, it IS the thread pitch.
  const LAMP_SOCKETS = {
    e14: { diameter: 28, pitch: 2.0, label: 'E14 28x2.0' },
    e27: { diameter: 40, pitch: 2.5, label: 'E27 40x2.5' },
  };

  // Lampshade: a threaded throat that screws onto an E14/E27 lampholder,
  // flaring through a tangent fillet into a conical shade. One continuous
  // vase-mode helix from the bed to the rim. Kept as its own generator (like
  // the spoon) rather than threaded through generate()'s branching — the
  // radius follows an arbitrary r/z profile with per-turn extrusion
  // compensation, which shares no logic with the other projects' walls.
  function generateLamp(cfg) {
    const warnings = [];
    const lines = [];
    const path = [];
    let totalVolume = 0;
    let pathLength = 0;
    let moveCount = 0;

    const cx = cfg.centerX;
    const cy = cfg.centerY;
    const ls = cfg.lamp || {};
    const lwBase = cfg.lineWidth;

    function bail(msg) {
      return {
        gcode: '; ERROR: ' + msg,
        warnings: [msg],
        stats: { volume: 0, pathLength: 0, moves: 0, loops: 0, timeMin: 0, materialVolume: 0, actualTimeMin: 0 },
        path: [],
      };
    }

    const sock =
      ls.socket === 'custom'
        ? { diameter: ls.customDiameter, pitch: ls.customPitch, label: 'custom' }
        : LAMP_SOCKETS[ls.socket] || LAMP_SOCKETS.e27;
    if (!(sock.diameter > 0) || !(sock.pitch > 0)) return bail('Enter a valid socket thread diameter and pitch.');
    // Layer height IS the thread pitch — that is what makes the printed helix
    // mate with the socket's own thread.
    const lh = sock.pitch;
    if (!(lwBase > 0)) return bail('Enter a valid line width.');
    if (lwBase < lh) {
      warnings.push('Line width is less than the thread pitch (layer height) — bead width clamped to layer height.');
    }

    // The wall's INNER surface has to land on the socket thread, so the
    // toolpath centreline sits half a line width outside it on each side.
    // Fit tolerance shifts the inner surface: negative = tighter (the socket's
    // crests press further into the plastic), positive = looser.
    const innerD = sock.diameter + (ls.fitTolerance || 0);
    const rThroat = (innerD + lwBase) / 2;
    const rBottom = (ls.bottomDiameter || 0) / 2;
    if (!(rBottom > 0)) return bail('Enter a valid bottom opening diameter.');
    if (!(ls.transitionHeight > 0)) return bail('Enter a valid transition height.');

    const shape = ['cone', 'arcOut', 'arcIn', 'sphere'].indexOf(ls.shape) >= 0 ? ls.shape : 'cone';
    const rSphere = (ls.sphereDiameter || 0) / 2;
    if (shape === 'sphere') {
      if (!(rSphere > rThroat)) return bail('Sphere diameter must be larger than the throat.');
      if (!(rSphere > rBottom)) return bail('Sphere diameter must be larger than the bottom opening.');
    }
    const prof = Geo.lampProfile({
      rThroat: rThroat,
      rBottom: rBottom,
      throatLen: Math.max(0, ls.throatLength || 0),
      transitionH: ls.transitionHeight,
      fillet: Math.max(0, ls.fillet || 0),
      shape: shape,
      maxAngle: ((ls.maxAngle || 0) * Math.PI) / 180,
      sphereRadius: rSphere,
    });
    prof.warnings.forEach((w) => warnings.push(w));

    let ppts = prof.pts;
    if (ls.orientation === 'wide') ppts = Geo.flipLampProfile(ppts);
    const sampler = Geo.makeLampSampler(ppts);
    const H = sampler.height;
    if (!(H > lh)) return bail('Shade is shorter than one layer — increase throat length or transition height.');

    const coneDeg = (Math.abs(prof.angle) * 180) / Math.PI;
    if (coneDeg > 50) {
      warnings.push(
        'Wall reaches ' + coneDeg.toFixed(1) + ' deg from vertical — past roughly 50 deg a vase-mode wall ' +
          'usually needs a wider bead, slower moves and strong cooling to not droop.'
      );
    }

    // ---- Overhang compensation ----
    // A wall leaning `a` from vertical steps sideways by lh*tan(a) per turn,
    // and consecutive bead centres end up lh/cos(a) apart measured ALONG the
    // wall — so cos(a) is the whole story, applied either to the bead width
    // (a wider bead spans the step) or to the physical Z rise (squeeze the
    // same material into a shorter gap so it spreads sideways). Strength
    // blends linearly between no compensation and the full geometric factor.
    const compMode = ls.compMode === 'layerHeight' || ls.compMode === 'width' ? ls.compMode : 'off';
    const compK = Math.max(0, Math.min(1, (ls.compStrength != null ? ls.compStrength : 100) / 100));
    const compMax = ls.compMaxMult > 0 ? ls.compMaxMult : 2.5;
    function compAt(a) {
      const c = Math.max(0.05, Math.cos(Math.abs(a)));
      if (compMode === 'width') {
        const mult = Math.min(compMax, 1 + compK * (1 / c - 1));
        return { w: lwBase * mult, dz: lh, hExtrude: null };
      }
      if (compMode === 'layerHeight') {
        // Physical rise shrinks, but the extrusion below still uses the FULL
        // layer height — that deliberate over-fill IS the squeeze that
        // widens the bead into the overhang. Extruding for the reduced
        // height instead would just print a thinner wall and do nothing.
        return { w: lwBase, dz: lh * (1 - compK * (1 - c)), hExtrude: lh };
      }
      return { w: lwBase, dz: lh, hExtrude: null };
    }
    const areaFor = (t) => beadArea(t.w, t.hExtrude != null ? t.hExtrude : t.dz);

    // ---- Volumetric flow feed mode ----
    // Same idea as the bend stool's own toggle: hold a target mm^3/s and
    // derive the feed from each revolution's OWN bead area instead of a fixed
    // print feed. It matters more here than anywhere else in the app, because
    // width compensation deliberately grows the bead on the overhangs — at a
    // constant feed that is a straight flow increase exactly where the
    // material is least supported. Deriving the feed backs the head off in
    // proportion instead. Off by default (byte-identical to a fixed feed).
    const flowCfg = ls.flowFeed || {};
    const flowOn = !!flowCfg.enabled && flowCfg.rate > 0;
    const flowThroat = flowCfg.rate;
    const flowShade = flowCfg.shadeRate > 0 ? flowCfg.shadeRate : flowThroat;
    // The shade can usually run faster than the throat: its revolutions are
    // longer, so each layer gets more cooling time before the nozzle comes
    // back round to it. Stepping straight from one flow to the other would
    // leave a visible band, so it ramps across the FILLET — the stretch where
    // the throat literally becomes the shade, and the one place where a
    // gradual change is already geometrically justified. A shape that leaves
    // the throat tangentially (the bell) never gets a fillet, so a manual
    // transition height gives the ramp somewhere to happen there too.
    const rampZ0 = prof.filletZ0;
    const rampSpan =
      flowCfg.transitionHeight > 0 ? flowCfg.transitionHeight : prof.filletZ1 - prof.filletZ0;
    const flipped = ls.orientation === 'wide';
    function flowAtZ(zPrint) {
      // Resolved in the PROFILE's own coordinates (throat at 0), so the ramp
      // sits in the same place on the part whichever way up it is printed.
      const zp = flipped ? H - zPrint : zPrint;
      const t =
        rampSpan > 1e-9 ? Math.max(0, Math.min(1, (zp - rampZ0) / rampSpan)) : zp >= rampZ0 ? 1 : 0;
      return flowThroat + t * (flowShade - flowThroat);
    }
    const feedForArea = (a, zPrint) =>
      flowOn ? (flowAtZ(zPrint) * 60) / Math.max(a, 1e-6) : cfg.printFeed;

    // Walk the spiral turn by turn, reading the local wall angle at the start
    // of each turn — the angle changes slowly next to a whole revolution, and
    // per-turn is the finest granularity compensation can act at anyway.
    const turns = [];
    let zc = 0;
    let guard = 0;
    while (zc < H - 1e-6 && guard++ < 200000) {
      // Sample the angle at the turn's MIDPOINT, not its start. On the arc
      // and sphere shapes the wall angle swings a long way within a single
      // revolution, and reading it at the start alone would leave the
      // compensation a full turn behind wherever the curve bends hardest.
      // One refinement pass is enough: guess the rise from the start angle,
      // then re-read halfway up that guess.
      const c = compAt(sampler.at(Math.min(H, zc + compAt(sampler.at(zc).a).dz / 2)).a);
      let dz = c.dz;
      if (zc + dz > H) dz = H - zc;
      // A hair-thin final turn would badly over-extrude in layer-height mode
      // (its E is computed for a full layer height) and gains nothing — stop
      // and let the closing turn finish the rim instead.
      if (dz < c.dz * 0.25) break;
      turns.push({ z: zc, dz: dz, w: c.w, a: sampler.at(Math.min(H, zc + dz / 2)).a, hExtrude: c.hExtrude });
      zc += dz;
    }
    if (!turns.length) return bail('Shade is too short to print — increase throat length or transition height.');

    let wMin = Infinity;
    let wMax = 0;
    let dzMin = Infinity;
    let dzMax = 0;
    turns.forEach((t) => {
      if (t.w < wMin) wMin = t.w;
      if (t.w > wMax) wMax = t.w;
      if (t.dz < dzMin) dzMin = t.dz;
      if (t.dz > dzMax) dzMax = t.dz;
    });
    // Support ratio: the fraction of each bead that lands on the one below.
    // This is the number that actually predicts drooping, so it is worth
    // surfacing rather than leaving the compensation as a black box.
    const worst = turns.reduce((m, t) => (Math.abs(t.a) > Math.abs(m.a) ? t : m), turns[0]);
    const support = Math.max(0, 1 - (worst.dz * Math.tan(Math.abs(worst.a))) / worst.w);

    // ---- Printer / extrusion mode ----
    const printer = cfg.printer || {};
    const mode = printer.mode === 'filament' ? 'filament' : 'pellet';
    const mult = printer.multiplier > 0 ? printer.multiplier : 1;
    const fil = printer.filament || {};
    const pel = printer.pellet || {};
    const filDia = fil.diameter > 0 ? fil.diameter : 1.75;
    const eFactor = mult / (mode === 'filament' ? Math.PI * (filDia / 2) * (filDia / 2) : 1);
    const includeStartEnd = !!printer.includeStartEnd;
    // The start G-code parks the fan off for the ramp-up revolution, so the
    // generator owns turning it back on afterwards — without this the fan
    // never runs at all. Gated on includeStartEnd for the same reason the
    // other projects gate it: with no start block there is no M106 S0 to
    // undo, and the fan is the caller's business.
    const fanPct = mode === 'filament' ? fil.fan || 0 : pel.fan || 0;
    const fanPWM = Math.round(Math.max(0, Math.min(100, fanPct)) * 2.55);
    const tol = cfg.tolerance > 0 ? cfg.tolerance : 0.05;

    lines.push('; EasyGCode — lampshade (threaded throat + conical shade) generator');
    lines.push('; ' + new Date().toISOString());
    lines.push(
      '; socket=' + sock.label + ' threadDia=' + sock.diameter + ' pitch=' + sock.pitch +
        ' fit=' + (ls.fitTolerance || 0) + 'mm -> throat inner dia=' + innerD.toFixed(2)
    );
    lines.push(
      '; shape=' + shape + ' throat=' + (ls.throatLength || 0) +
        (shape === 'sphere' ? ' sphereDia=' + (ls.sphereDiameter || 0) : ' transition=' + ls.transitionHeight) +
        ' fillet=' + prof.fillet.toFixed(1) + ' bottomDia=' + (ls.bottomDiameter || 0) +
        ' totalHeight=' + H.toFixed(2)
    );
    lines.push(
      '; layerHeight=' + lh + ' (= thread pitch) lineWidth=' + lwBase +
        ' orientation=' + (ls.orientation === 'wide' ? 'wide edge down' : 'throat down')
    );
    lines.push(
      '; wall angle: max=' + coneDeg.toFixed(1) + ' deg at the throat join=' +
        ((Math.abs(prof.joinAngle) * 180) / Math.PI).toFixed(1) + ' deg, compensation=' + compMode +
        (compMode === 'off' ? '' : ' @' + Math.round(compK * 100) + '%') +
        ' -> lineWidth ' + wMin.toFixed(2) + '..' + wMax.toFixed(2) +
        ' layerRise ' + dzMin.toFixed(2) + '..' + dzMax.toFixed(2) +
        ', support ' + Math.round(support * 100) + '% at the steepest point'
    );
    {
      // Actual feeds over the revolutions that will be printed, rather than a
      // theoretical range — compensation and the flow ramp both vary along
      // the wall, so only the real per-turn numbers describe the print.
      let feedLo = Infinity;
      let feedHi = 0;
      turns.forEach((t) => {
        const f = feedForArea(areaFor(t), t.z + t.dz / 2);
        if (f < feedLo) feedLo = f;
        if (f > feedHi) feedHi = f;
      });
      const aLo = beadArea(wMin, compMode === 'layerHeight' ? lh : dzMax);
      const aHi = beadArea(wMax, compMode === 'layerHeight' ? lh : dzMax);
      lines.push(
        flowOn
          ? '; volumetric flow mode: throat ' + flowThroat + ' -> shade ' + flowShade +
            ' mm3/s' +
            (flowShade !== flowThroat
              ? ', ramped over z ' + rampZ0.toFixed(2) + '..' + (rampZ0 + rampSpan).toFixed(2) +
                (rampSpan > 1e-9 ? '' : ' (no fillet — steps; set a transition height)')
              : '') +
            ' -> feed ' + feedLo.toFixed(0) + '..' + feedHi.toFixed(0) + ' mm/min'
          : '; constant feed ' + cfg.printFeed + ' mm/min -> volumetric flow ' +
            ((cfg.printFeed * aLo) / 60).toFixed(2) + '..' + ((cfg.printFeed * aHi) / 60).toFixed(2) +
            ' mm3/s (bead area ' + aLo.toFixed(2) + '..' + aHi.toFixed(2) + ' mm2)'
      );
    }
    lines.push(
      '; printer=' + mode + ' multiplier=' + mult +
        (mode === 'filament' ? ' filamentDiameter=' + filDia + ' (E in mm of filament)' : ' (E in mm^3, volumetric)')
    );
    if (includeStartEnd) {
      (mode === 'filament' ? marlinStart(fil) : klipperStart(pel)).forEach((l) => lines.push(l));
    }
    lines.push('G90 ; absolute positioning');
    lines.push('M83 ; relative extrusion');

    let prev = null;
    let lastFeed = null;
    let firstExtrude = true;
    let maxZEver = 0;
    function noteZ(z) {
      if (z > maxZEver) maxZEver = z;
    }
    function travelAbs(cur) {
      lines.push('G0 X' + f3(cur.x) + ' Y' + f3(cur.y) + ' Z' + f3(cur.z) + ' F' + Math.round(cfg.travelFeed));
      lastFeed = cfg.travelFeed;
      path.push({ x: cur.x, y: cur.y, z: cur.z, travel: true, feed: cfg.travelFeed });
      prev = cur;
      moveCount++;
    }
    function hopTravel(dest, clearMargin) {
      const clearZ = Math.max(prev.z, dest.z, clearMargin);
      if (clearZ > prev.z + 1e-6) travelAbs({ x: prev.x, y: prev.y, z: clearZ });
      travelAbs({ x: dest.x, y: dest.y, z: clearZ });
      if (dest.z < clearZ - 1e-6) travelAbs(dest);
    }
    function emitSeg(cur, feed, ramp, area) {
      const segLen = dist3(prev, cur);
      if (segLen < 1e-7) {
        prev = cur;
        return;
      }
      const dVol = area * segLen * ramp;
      totalVolume += dVol;
      pathLength += segLen;
      let line = 'G1 X' + f3(cur.x) + ' Y' + f3(cur.y) + ' Z' + f3(cur.z) + ' E' + f5(dVol * eFactor);
      if (feed !== lastFeed || firstExtrude) {
        line += ' F' + Math.round(feed);
        lastFeed = feed;
      }
      lines.push(line);
      path.push({ x: cur.x, y: cur.y, z: cur.z, travel: false, feed: feed });
      firstExtrude = false;
      moveCount++;
      prev = cur;
      noteZ(cur.z);
    }
    // Seam at the back (+Y). The helix always runs counter-clockwise as it
    // rises: that is a RIGHT-hand thread, which is what Edison sockets use.
    // (Handedness survives flipping the part end-over-end, so this is correct
    // for both print orientations.)
    const SEAM = Math.PI / 2;
    const stepsFor = (r) => {
      let dth = 2 * Math.acos(Math.max(-1, 1 - tol / Math.max(r, 1e-6)));
      if (!isFinite(dth) || dth <= 0) dth = 0.2;
      return Math.max(24, Math.ceil((2 * Math.PI) / dth));
    };
    const ptAt = (r, th, z) => ({ x: cx + r * Math.cos(th), y: cy + r * Math.sin(th), z: z });

    // ---- Brim (outer rings) ----
    // The opening revolution ramps extrusion up from nothing, so it has to be
    // a true circle rather than a spiral arc: the brim outside it is
    // perfectly circular, and a radius that drifted across the revolution
    // would make that gap wobble around the circumference. It holds the
    // radius the SECOND revolution begins at, so that one lands exactly on
    // top of it — the mirror of the closing revolution at the other end.
    // With the throat on the bed this changes nothing (the throat is a
    // cylinder, so the radius is already constant there); it matters when the
    // wide rim goes down first and the wall is already sloping at z=0.
    const rFirst = sampler.at(Math.min(H, turns[0].z + turns[0].dz)).r;

    const brim = cfg.brim || {};
    const brimOn = !!brim.enabled && brim.linesOuter > 0 && brim.lineWidth > 0 && brim.layerHeight > 0;
    let brimPrinted = false;
    if (brimOn) {
      // A brim line printed flat on the bed spreads differently from a wall
      // bead, so it gets its own extrusion multiplier (0 = same as the wall).
      // eFactor already carries the wall's multiplier, so scaling the bead
      // area by the ratio nets out to the brim's own.
      const bArea =
        beadArea(brim.lineWidth, brim.layerHeight) * (brim.multiplier > 0 ? brim.multiplier / mult : 1);
      const brimFeed = brim.feed > 0 ? brim.feed : cfg.printFeed;
      const r0 = rFirst;
      lines.push('; --- brim: ' + brim.linesOuter + ' outer ring(s) ---');
      // Outermost ring first, working inward toward the wall and leaving
      // exactly one line width of gap for the wall itself — same convention
      // as every other project's brim.
      for (let k = brim.linesOuter; k >= 1; k--) {
        const rr = r0 + brim.lineWidth / 2 + lwBase / 2 + (k - 1) * brim.lineWidth;
        const steps = stepsFor(rr);
        const p0 = ptAt(rr, SEAM, brim.layerHeight);
        if (prev === null) travelAbs(p0);
        else hopTravel(p0, 2 * brim.layerHeight);
        for (let s = 1; s <= steps; s++) {
          emitSeg(ptAt(rr, SEAM + (2 * Math.PI * s) / steps, brim.layerHeight), brimFeed, 1, bArea);
        }
      }
      brimPrinted = true;
    }

    // ---- The spiral ----
    const start = ptAt(rFirst, SEAM, 0);
    if (prev === null) travelAbs(start);
    else hopTravel(start, brimPrinted ? 2 * brim.layerHeight : lh);

    lines.push('; --- shade: ' + turns.length + ' revolutions to z=' + H.toFixed(2) + ' ---');
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      const area = areaFor(t);
      const feed = feedForArea(area, t.z + t.dz / 2);
      const first = i === 0;
      const steps = stepsFor(first ? rFirst : Math.max(sampler.at(t.z).r, sampler.at(t.z + t.dz).r));
      for (let s = 1; s <= steps; s++) {
        const u = s / steps;
        const zp = t.z + t.dz * u;
        // First revolution ramps extrusion 0 -> 100% (midpoint-averaged over
        // each segment), arriving at exactly one layer height, so the spiral
        // starts flush with the bed instead of with a step — and holds a
        // constant radius while it does (see rFirst above).
        const ramp = first ? (u + (s - 1) / steps) / 2 : 1;
        emitSeg(ptAt(first ? rFirst : sampler.at(zp).r, SEAM + 2 * Math.PI * u, zp), feed, ramp, area);
      }
      if (first && includeStartEnd && fanPWM > 0) {
        lines.push('M106 S' + fanPWM + ' ; part cooling fan on after ramp loop');
      }
    }

    // Closing revolution: no rise AND no radius gain, so it lands exactly on
    // top of the turn below (a spiral that kept flaring here would leave the
    // ramp-down hanging in mid-air), with extrusion ramping back to zero to
    // finish the rim cleanly.
    const last = turns[turns.length - 1];
    const zTop = last.z + last.dz;
    const rTop = sampler.at(zTop).r;
    const capArea = areaFor(last);
    const capFeed = feedForArea(capArea, zTop);
    const capSteps = stepsFor(rTop);
    lines.push('; --- closing revolution: flat, extrusion ramped to zero ---');
    for (let s = 1; s <= capSteps; s++) {
      const u = s / capSteps;
      const ramp = Math.max(0, 1 - (u + (s - 1) / capSteps) / 2);
      emitSeg(ptAt(rTop, SEAM + 2 * Math.PI * u, zTop), capFeed, ramp, capArea);
    }

    if (includeStartEnd) {
      const endLift = Math.max(5 * maxZEver, mode === 'filament' ? 5 : 10);
      (mode === 'filament' ? marlinEnd(endLift) : klipperEnd(endLift)).forEach((l) => lines.push(l));
    }

    let timeMin = 0;
    for (let i = 1; i < path.length; i++) {
      const d = dist3(path[i - 1], path[i]);
      if (path[i].feed > 0) timeMin += d / path[i].feed;
    }
    const stats = {
      volume: totalVolume,
      pathLength: pathLength,
      moves: moveCount,
      loops: turns.length + 1,
      timeMin: timeMin,
      materialVolume: totalVolume,
      actualTimeMin: timeMin,
      lampHeight: H,
      lampAngle: coneDeg,
      lampJoinAngle: (Math.abs(prof.joinAngle) * 180) / Math.PI,
      lampSupport: support,
      lampWidthRange: [wMin, wMax],
      lampRiseRange: [dzMin, dzMax],
    };
    return { gcode: lines.join('\n') + '\n', warnings, stats, path };
  }

  function generate(cfg) {
    if (cfg.project === 'spoon') return generateSpoon(cfg);
    if (cfg.project === 'lamp') return generateLamp(cfg);

    const warnings = [];
    const lines = [];
    const path = [];
    let totalVolume = 0;
    let pathLength = 0;
    let moveCount = 0;
    // Raw material actually consumed, accounting for the bend stool's foam
    // mode: totalVolume/timeMin (below) reflect the NOMINAL G-code numbers —
    // full bead area and the commanded F feedrate — since that's what the
    // firmware's own M221/M220 overrides act on at print time, not something
    // the generator itself scales. For accurate cost/weight and an accurate
    // print-time estimate, materialVolume and actualTimeMin separately track
    // the REAL, foam-reduced numbers using the same M221 percentage the
    // firmware would apply — equal to totalVolume/timeMin whenever foam
    // never activates (every project but the bend stool, and the bend stool
    // itself with foam off).
    let materialVolume = 0;
    let foamZoneActive = false;

    const cx = cfg.centerX;
    const cy = cfg.centerY;
    const lh = cfg.layerHeight;

    if (cfg.lineWidth < lh) {
      warnings.push('Line width is less than layer height — bead width clamped to layer height.');
    }

    const isBS = cfg.project === 'bendstool';
    const isVessel = cfg.project === 'vessel';
    // +1 = counter-clockwise (the only direction that ever existed before
    // this setting; bend stool doesn't offer the choice, so it's always +1
    // there). -1 reverses the base outline's traversal order below (same
    // shape, opposite sweep) — every inward/outward offset derived from the
    // LOCAL forward direction of travel (brim rings, hanger pocket, weave
    // lateral, spike push-out) needs this sign to still point the same
    // physical way it always did, since reversing flips what "forward"
    // means at every point on the curve.
    const dirSign = !isBS && cfg.printDirection === 'cw' ? -1 : 1;

    let base = null;
    let sampler = null;
    let perim = 0;
    if (!isBS) {
      base = Geo.adaptiveShape(cfg.shape, cfg.shapeParams, cfg.tolerance);
      if (dirSign < 0) base = Geo.reverseWinding(base);
      base = Geo.rotateToSeam(base, cfg.seamSide || 'back');
      sampler = Geo.makeSampler(base);
      perim = sampler.perimeter;
      if (!(perim > 1e-6) || !Number.isFinite(perim)) {
        return {
          gcode: '; ERROR: shape has zero size',
          warnings: ['Shape has zero size — check your dimensions.'],
          stats: { volume: 0, pathLength: 0, moves: 0, loops: 0, timeMin: 0 },
          path: [],
        };
      }
    }

    // ---- Vessel setup: radius profile + scaled base (wall centerline) ----
    let vProfile = null;
    let vBase = base;
    let vAlt = false;
    let vBottomStyle = 'staircase';
    let vBottomLayers = 0;
    let vWallN = 1;
    let vFlatTop = true;
    if (isVessel) {
      const ve = cfg.vessel || {};
      const cps = [{ h: 0, s: ve.bottom > 0 ? ve.bottom : 1 }];
      if (Number.isFinite(ve.midH) && ve.midH > 0.001 && ve.midH < 0.999) {
        cps.push({ h: ve.midH, s: ve.mid > 0 ? ve.mid : 1 });
      }
      cps.push({ h: 1, s: ve.top > 0 ? ve.top : 1 });
      cps.sort((a, b) => a.h - b.h);
      vProfile = makeProfile(cps);
      const s0 = vProfile(0);
      vBase = base.map((p) => ({ x: p.x * s0, y: p.y * s0 }));
      vBottomStyle = ve.seamStyle === 'alternating' || ve.seamStyle === 'spiral' ? ve.seamStyle : 'staircase';
      vAlt = vBottomStyle === 'alternating';
      vFlatTop = ve.topStyle !== 'spiral';
      vBottomLayers = Math.max(0, Math.round(ve.bottomLayers || 0));
      vWallN = Math.max(1, Math.round((ve.height || lh) / lh));
    }

    const area = beadArea(cfg.lineWidth, lh);
    // Vase: loops = height/layerHeight (may be fractional). Disc/vessel: whole
    // stacked layers / revolutions.
    const T = isBS
      ? Math.max(1, Math.round((cfg.disc && cfg.disc.layers) || 1))
      : isVessel
      ? vWallN
      : cfg.totalHeight / lh;
    const Lmax = Math.ceil(T - 1e-9);

    // ---- Disc setup (bend stool) ----
    // Ring centerlines: lw/2 + i*lw from the center, so beads meet half-half in
    // the middle. Perfect-fill diameters are therefore multiples of 2*lw; the
    // requested diameter snaps to the nearest (ties round UP = one line more).
    let ringN = 0;
    let snappedD = 0;
    let ringRadii = [];
    let legs = null;
    let legLoops = null; // per-ring polylines when legs are on
    let attrGrad = false; // bottom->top spread gradient active
    let discSpecMemo = null;
    let discOuterLoop = null;
    // Bend-stool bed-fit transform: a fixed rotation (the 3-leg layout is
    // roughly triangular, so tilting it fits a rectangular bed better than
    // printing it axis-aligned) plus a recenter so the ROTATED bounding box —
    // not the raw, unrotated disc — sits on the bed-center input. Applied as a
    // post-hoc rigid transform on the already-fully-built geometry (legs,
    // fillets, bend-spread, everything), so nothing about how the shape is
    // constructed has to change — only where its points finally land. Hoisted
    // to this scope (rather than local to the isBS block) so the per-layer
    // loopsAt() recompute inside the body-emission section can reuse it too.
    // A legless disc is a circle, rotationally symmetric, so bsShiftX/Y stay
    // exactly 0 there — only the seam position visibly rotates.
    let bsCosR = 1;
    let bsSinR = 0;
    let bsShiftX = 0;
    let bsShiftY = 0;
    function bsFit(p) {
      return { x: p.x * bsCosR - p.y * bsSinR + bsShiftX, y: p.x * bsSinR + p.y * bsCosR + bsShiftY, w: p.w };
    }
    if (isBS) {
      const spec = discSpec(cfg);
      spec.warnings.forEach((w) => warnings.push(w));
      ringN = spec.ringN;
      snappedD = spec.snappedD;
      ringRadii = spec.radii;
      legs = spec.legs;
      const lw = cfg.lineWidth;
      const tolBS = cfg.tolerance > 0 ? cfg.tolerance : 0.05;
      const altSeam = cfg.disc.seamStyle === 'alternating';
      const rotRad = (BS_ROTATION_DEG * Math.PI) / 180;
      bsCosR = Math.cos(rotRad);
      bsSinR = Math.sin(rotRad);

      let dlRaw = null;
      if (legs || altSeam) {
        // Precompute each ring's polyline once (identical every layer).
        dlRaw = discLoops(cfg, spec);
        if (legs && !altSeam) {
          // Staircase drift within the legged rings (seam is anchored at the
          // outermost ring; inner plain rings absorb the rest).
          let bandDrift = 0;
          for (let i = ringN - legs.m; i < ringN - 1; i++) bandDrift += lw / ringRadii[i];
          if (bandDrift > Math.PI / 6) {
            warnings.push('Seam staircase drifts close to a leg junction within the legged rings.');
          }
        }
      }
      // Vertical spread gradient: with more than one layer, the bottom layer
      // prints with the lines collected (scale 0) and the spread grows
      // linearly to the maximum at the top layer.
      attrGrad = !!(dlRaw && dlRaw.attrOn && T > 1);
      discSpecMemo = spec;

      let rawOuterLoop;
      if (legs) {
        // Brim base: the outermost combined outline of the BOTTOM layer (the
        // brim hugs what actually prints first — unspread when gradient is on).
        rawOuterLoop = attrGrad ? discLoops(cfg, spec, 0).outline : dlRaw.outline;
      } else {
        // Outermost bead centerline circle doubles as the brim's base loop.
        const rOut = ringRadii[ringN - 1];
        const dth0 = 2 * Math.acos(Math.max(-1, 1 - tolBS / rOut));
        const steps0 = Math.max(24, Math.ceil((2 * Math.PI) / (isFinite(dth0) && dth0 > 0 ? dth0 : 0.2)));
        rawOuterLoop = [];
        for (let s = 0; s < steps0; s++) {
          const ang = (2 * Math.PI * s) / steps0;
          rawOuterLoop.push({ x: rOut * Math.cos(ang), y: rOut * Math.sin(ang) });
        }
      }

      // Shared with the 2D preview, so both agree on the exact same numbers.
      const fit = discBedFit(rawOuterLoop, cfg.centerX, cfg.centerY);
      bsShiftX = fit.shiftX;
      bsShiftY = fit.shiftY;

      legLoops = dlRaw ? dlRaw.loops.map((lp) => lp.map(bsFit)) : null;
      discOuterLoop = rawOuterLoop.map(bsFit);

      lines.push(
        '; bend stool bed-fit: rotated ' + BS_ROTATION_DEG + ' deg, bounding box ' + fit.width.toFixed(1) +
          ' x ' + fit.height.toFixed(1) + ' mm, centered at bed (' + cfg.centerX + ', ' + cfg.centerY + ')' +
          ' — pure coordinates, no line-width margin'
      );
    }

    // ---- Printer / extrusion mode ----
    // pellet: E is pure volume (mm^3), converted downstream by the Klipper
    // rotation-distance setup. filament: E is linear mm of filament, so the
    // segment volume is divided by the filament cross-section area.
    const printer = cfg.printer || {};
    const mode = printer.mode === 'filament' ? 'filament' : 'pellet';
    const mult = printer.multiplier > 0 ? printer.multiplier : 1;
    const fil = printer.filament || {};
    const pel = printer.pellet || {};
    const filDia = fil.diameter > 0 ? fil.diameter : 1.75;
    const eFactor = mult / (mode === 'filament' ? Math.PI * (filDia / 2) * (filDia / 2) : 1);
    const includeStartEnd = !!printer.includeStartEnd;
    const fanPct = mode === 'filament' ? fil.fan || 0 : pel.fan || 0;
    const fanPWM = Math.round(Math.max(0, Math.min(100, fanPct)) * 2.55);

    // ---- Pattern setup ----
    const pat = cfg.pattern || {};
    const type = pat.type || 'weave';
    const patternOn =
      !isBS &&
      !!pat.enabled &&
      pat.amplitude !== 0 &&
      ((type === 'weave' && pat.bumps >= 1) || (type === 'spikes' && pat.spikeDensity > 0));
    const cov = patternOn ? Math.max(0, Math.min(100, pat.coverage)) / 100 : 0;
    const zAng = ((pat.zAngle || 0) * Math.PI) / 180;
    const cosA = Math.cos(zAng);
    const sinA = Math.sin(zAng);
    const bumpFeed = pat.bumpFeed > 0 ? pat.bumpFeed : cfg.printFeed;
    // Spikes get their own dedicated out/in feeds instead of sharing bumpFeed
    // with weave — independent, so e.g. slow out + fast back in, or slow
    // both ways (leave the dwell at 0 for a plain back-and-forth), are both
    // just a matter of what's typed in, not a fixed asymmetric rule.
    const spikeFeedOut = pat.spikeFeedOut > 0 ? pat.spikeFeedOut : cfg.printFeed;
    const spikeFeedIn = pat.spikeFeedIn > 0 ? pat.spikeFeedIn : cfg.printFeed;
    // The flat top itself (the pushed-out stretch between the two 90° turns)
    // gets its own feed too, independent of the out/in moves on either side
    // of it — defaults to feedOut if left unset.
    const spikeFeedTip = pat.spikeFeedTip > 0 ? pat.spikeFeedTip : spikeFeedOut;
    // Separate, slower feed for the plain (bumpless) revolutions below where
    // the pattern starts — independent of the main print feed used from the
    // pattern's own bottom layer upward, e.g. for extra first-layers-out
    // adhesion time without slowing the whole print.
    const bottomFeed = pat.bottomFeed > 0 ? pat.bottomFeed : cfg.printFeed;
    const plBottom = patternOn ? pat.plBottom : 0;
    const plTop = patternOn ? pat.plTop : 0;
    // Spikes are placed by density (spikes per cm^2) rather than a fixed
    // count, so the same setting reads as the same visual density on any
    // shape/height/coverage combination instead of a fixed count spreading
    // thinner (or bunching tighter) as the patterned area changes with the
    // part's size. The placement rectangle is arc-length (perim * coverage)
    // by patterned height ((T - plBottom - plTop) layers, in mm) — the exact
    // area spikes get scattered across in the placement step below.
    let spikeCount = 0;
    if (type === 'spikes' && patternOn) {
      const patternedHeightMM = Math.max(0, (T - plBottom - plTop) * lh);
      const areaCm2 = (cov * perim * patternedHeightMM) / 100;
      spikeCount = Math.max(0, Math.round((pat.spikeDensity || 0) * areaCm2));
      if (spikeCount === 0) {
        warnings.push('Spike density is too low for this shape/coverage/height — 0 spikes would be placed.');
      }
    }
    // Spike tip dwell: G4 pauses right at the tip, after the slow move out and
    // before heading back in at normal feed (P is milliseconds — supported by
    // both Marlin and Klipper, unlike Marlin's S-in-seconds extension).
    const spikeDwellMs = type === 'spikes' && pat.spikeDwell > 0 ? Math.round(pat.spikeDwell * 1000) : 0;
    // Spikes can extrude as if printed with a different line width/layer
    // height than the wall — 0 (either field) means "same as wall", the
    // ordinary bead area. This ONLY changes the bead cross-section used to
    // compute E on spike segments (the push-out, flat tip, and push-back-in
    // moves); the spike's actual XYZ geometry is still governed entirely by
    // the wall's own lineWidth/layerHeight, same as before this setting
    // existed — under- or over-extruding the same physical path, not
    // reshaping it.
    const spikeLineWidth = pat.spikeLineWidth > 0 ? pat.spikeLineWidth : cfg.lineWidth;
    const spikeLayerHeightForArea = pat.spikeLayerHeight > 0 ? pat.spikeLayerHeight : lh;
    const spikeArea =
      type === 'spikes' && (pat.spikeLineWidth > 0 || pat.spikeLayerHeight > 0)
        ? beadArea(spikeLineWidth, spikeLayerHeightForArea)
        : null;
    function baseFeedAt(L) {
      return patternOn && L < plBottom ? bottomFeed : cfg.printFeed;
    }

    // ---- Fan mode ----
    // 'always' (default): a single M106 after the first revolution, fan stays
    // on for the whole print (unchanged prior behavior). 'bumps': the fan
    // only runs during cooling-sensitive slow segments — spike tips (both the
    // move out AND back, unlike their now-asymmetric feed rate), the hanger's
    // bridging (new bezier/pocket) sections, its overhang-triggered segments,
    // and weave's own bump zones — tracked with on/off edges rather than one
    // constant command.
    const fanBumpsOnly = !isBS && cfg.fanMode === 'bumps';
    let fanOn = false;
    function syncFan(want) {
      want = !!want; // e.tip is undefined (not false) off-tip — normalize so the
      // fanOn comparison below never sees undefined !== false as a false toggle.
      if (!fanBumpsOnly || !includeStartEnd || fanPWM <= 0 || want === fanOn) return;
      lines.push(want ? 'M106 S' + fanPWM + ' ; bump/bridge fan on' : 'M107 ; bump/bridge fan off');
      fanOn = want;
    }

    function layerPatterned(L) {
      return !(L < plBottom || L >= T - plTop);
    }
    // Patterned region is centered on the seam (u=0), growing both directions.
    function uInBand(u) {
      if (cov >= 1) return true;
      const uu = u >= 1 ? 0 : u;
      const half = cov / 2;
      return uu <= half || uu >= 1 - half;
    }

    // ---- Hanger setup ----
    const hang = cfg.hanger || {};
    const hangDouble = hang.mode === 'double';
    const hangFrac = Math.max(0, Math.min(45, hang.size || 0)) / 100;
    const pocketFrac =
      Math.max(0, Math.min(45, hang.pocket != null && hang.pocket > 0 ? hang.pocket : hang.size || 0)) / 100;
    let hangOn =
      !isBS &&
      !!hang.enabled &&
      hangFrac > 0.005 &&
      (hangDouble ? hang.gapWidthMM > 0 && hang.pocketWidthMM > 0 : pocketFrac > 0.005);
    const hStart = Math.max(1, Math.round(hang.bottom || 1));
    const hTween = Math.max(1, Math.round(hang.transition || 1));
    const hBridgeFeed = hang.bridgeFeed > 0 ? hang.bridgeFeed : cfg.printFeed;
    // Overhang compensation for the tween zone: layers there aren't stacked
    // directly on top of each other — each vertex slides sideways toward the
    // plain profile as the hanger shape washes out — so a steep tween (few
    // transition loops, or a big hanger/base gap) is a real overhang, prone to
    // sagging, with no slowdown of its own (bridgeFeed above only covers the
    // one bridging loop, not what comes after it). Any segment whose sideways
    // shift from the layer below exceeds what the overhang angle allows for
    // this layer height prints at the overhang feedrate instead.
    const hOverhangOn = hangOn && hang.overhangFeed > 0;
    const hOverhangFeed = hang.overhangFeed > 0 ? hang.overhangFeed : cfg.printFeed;
    const hOverhangMaxHoriz = lh * Math.tan(((hang.overhangAngle > 0 ? hang.overhangAngle : 15) * Math.PI) / 180);
    if (hangOn && hStart >= Lmax) {
      warnings.push('Hanger disabled: not enough loops below the top (bottom loops >= total loops).');
      hangOn = false;
    }
    if (hangOn && hStart + hTween >= Lmax) {
      warnings.push('Hanger transition reaches the top of the print — consider more total height.');
    }
    if (hangOn && !hangDouble && pocketFrac >= hangFrac) {
      warnings.push('Insert pocket % is not smaller than the gap % — the beziers get no room. Consider a smaller pocket.');
    }
    const inBand = (L) => hangOn && L >= hStart && L <= hStart + hTween;

    let hangerPts = null;
    let baseRes = null;
    let hangRes = null;
    const TWEEN_N = 400;
    if (hangOn) {
      hangerPts = hangDouble
        ? Geo.buildDoubleHangerLoop(base, hangFrac, hang.gapWidthMM, hang.pocketWidthMM, cfg.lineWidth, dirSign)
        : Geo.buildHangerLoop(base, hangFrac, pocketFrac, cfg.lineWidth, dirSign);
      if (Geo.polylineSelfIntersects(hangerPts)) {
        warnings.push(
          (hangDouble ? 'Double' : 'Wall') +
            ' hanger: the gap/pocket cuts overlap for this shape\'s size — the loop crosses itself. ' +
            'Try a smaller gap/pocket, or a larger gap %.'
        );
      }
      // Resample both the hanger loop and the plain base curve at the SAME
      // u values (not independently by arc length — Geo.resampleClosed
      // would space each one's N points evenly along its OWN total length,
      // which differ since the detour is a different length than the wall
      // it replaces, so index i wouldn't land on the same physical spot on
      // both curves). Away from any detour the hanger loop's points already
      // carry their real u, so hangRes[i] and baseRes[i] are then the exact
      // same point — the tween below leaves that stretch of wall completely
      // untouched at every layer, instead of subtly warping the whole
      // silhouette to compensate for the detour's own length.
      const hSampler = Geo.makeUSampler(hangerPts);
      const bSampler = Geo.makeSampler(base);
      hangRes = [];
      baseRes = [];
      for (let i = 0; i < TWEEN_N; i++) {
        const u = i / TWEEN_N;
        hangRes.push(hSampler.at(u));
        baseRes.push(bSampler.at(u).pos);
      }
    }

    function tweenLoopPts(t) {
      const w = 1 - t / hTween; // 1 = hanger shape, 0 = base shape
      const out = [];
      for (let i = 0; i < TWEEN_N; i++) {
        out.push({
          x: baseRes[i].x + (hangRes[i].x - baseRes[i].x) * w,
          y: baseRes[i].y + (hangRes[i].y - baseRes[i].y) * w,
          isNew: false,
        });
      }
      out.push({ x: out[0].x, y: out[0].y, isNew: false });
      return out;
    }

    // Flags each vertex in `pts` (a tween layer) whose sideways move from the
    // SAME index on `prevPts` (the layer directly below it) is steeper than
    // the overhang angle allows — both arrays share the identical TWEEN_N
    // index parameterization (tweenLoopPts/hangRes/baseRes all resample to
    // the same N points), so index i on one layer is the same wall feature as
    // index i on the layer below it.
    function tagOverhang(pts, prevPts) {
      for (let i = 0; i < pts.length; i++) {
        const p = prevPts[i % prevPts.length];
        pts[i].hot = Math.hypot(pts[i].x - p.x, pts[i].y - p.y) > hOverhangMaxHoriz;
      }
      return pts;
    }

    // ---- Header ----
    lines.push('; EasyGCode — ' + (isBS ? 'bend stool' : 'coat hanger (vase mode)') + ' generator');
    lines.push('; ' + new Date().toISOString());
    if (isBS) {
      lines.push('; disc: requested=' + cfg.disc.diameter + ' snapped=' + snappedD + ' rings=' + ringN + ' layers=' + T);
      if (legs) {
        lines.push(
          '; legs: 3 @ 120deg (one left) width=' + legs.snappedW + ' pairs=' + legs.m +
            ' seatHeight=' + cfg.disc.legs.seatHeight + ' fillet=' + legs.fillet + ' tipCenter=' + legs.tipCenter.toFixed(2)
        );
        const at2 = cfg.disc.attractor;
        if (at2 && at2.enabled) {
          lines.push(
            '; bend spread: pos=' + at2.pos + 'mm from rim, R1=' + at2.r1 + ' R2=' + at2.r2 +
              ' gap=' + at2.gap + 'x lw' +
              (T > 1 ? ', gradient 0 (bottom) -> 1 (top) over ' + T + ' layers' : '')
          );
          if (T > 1) {
            const dMaxH = ((2 * (legs.m - 1) + 1) * (at2.gap || 1) * cfg.lineWidth) / 2;
            const stepLat = dMaxH / (T - 1);
            const dropH = Math.max(0, Math.min(1, at2.drop || 0));
            lines.push(
              '; overhang: max lateral step ' + stepLat.toFixed(2) + 'mm/layer, angle ' +
                ((Math.atan2(stepLat, lh) * 180) / Math.PI).toFixed(1) + ' deg from vertical, drop=' +
                dropH + ' -> layers packed along the slope to ' + Math.round((1 - dropH) * 100) +
                '% spacing at steepest (angle preserved, extrusion stays full height)'
            );
          }
        }
      }
      lines.push('; layerHeight=' + lh + ' lineWidth=' + cfg.lineWidth + ' tolerance=' + cfg.tolerance + 'mm');
    } else if (isVessel) {
      const ve = cfg.vessel || {};
      lines.push(
        '; vessel shape=' + cfg.shape + ' wallHeight=' + (vWallN * lh) + ' (snapped) bottomLayers=' +
          vBottomLayers + ' bottom=' + (vBottomStyle === 'spiral' ? 'true spiral' : vAlt ? 'zipper' : 'staircase') +
          ' top=' + (vFlatTop ? 'flat cap' : 'open spiral')
      );
      lines.push(
        '; profile (radius x): bottom=' + (ve.bottom != null ? ve.bottom : 1) +
          ' mid=' + (ve.mid != null ? ve.mid : 1) + '@h' + (ve.midH != null ? ve.midH : 0.5) +
          ' top=' + (ve.top != null ? ve.top : 1) + ' (Catmull-Rom loft)'
      );
      lines.push('; layerHeight=' + lh + ' lineWidth=' + cfg.lineWidth + ' tolerance=' + cfg.tolerance + 'mm');
    } else {
      lines.push('; shape=' + cfg.shape + ' tolerance=' + cfg.tolerance + 'mm seam=' + (cfg.seamSide || 'back'));
      lines.push(
        '; layerHeight=' + lh + ' lineWidth=' + cfg.lineWidth + ' totalHeight=' + cfg.totalHeight +
          ' direction=' + (cfg.printDirection === 'cw' ? 'CW' : 'CCW')
      );
    }
    if (patternOn) {
      let ln = '; pattern=' + type + ' amplitude=' + pat.amplitude + ' zAngle=' + (pat.zAngle || 0) +
        ' coverage=' + pat.coverage + '% plBottom=' + plBottom + ' plTop=' + plTop;
      ln +=
        type === 'weave'
          ? ' bumps=' + pat.bumps + ' bumpFeed=' + Math.round(bumpFeed)
          : ' density=' + pat.spikeDensity + '/cm2 (' + spikeCount + ' spikes) seed=' + pat.seed +
            (pat.spikeBalance ? ' spacingBalance=on' : '') +
            ' feedOut=' + Math.round(spikeFeedOut) + ' feedTip=' + Math.round(spikeFeedTip) +
            ' feedIn=' + Math.round(spikeFeedIn) +
            (pat.spikeVar > 0 ? ' lengthVar=+/-' + pat.spikeVar + 'mm' : '') +
            (spikeDwellMs > 0 ? ' tipDwell=' + pat.spikeDwell + 's' : '') +
            (spikeArea != null
              ? ' spikeExtrusion=' + spikeLineWidth + 'x' + spikeLayerHeightForArea + 'mm (geometry unaffected)'
              : '');
      lines.push(ln);
    }
    if (hangOn) {
      lines.push(
        (hangDouble
          ? '; hanger: double, gap%=' + hang.size + ' gapWidth=' + hang.gapWidthMM + 'mm pocketWidth=' +
            hang.pocketWidthMM + 'mm'
          : '; hanger: gap=' + hang.size + '% pocket=' + Math.round(pocketFrac * 100) + '%') +
          ' bottomLoops=' + hStart + ' transition=' + hTween + ' bridgeFeed=' + Math.round(hBridgeFeed)
      );
      if (hOverhangOn) {
        lines.push(
          '; hanger overhang: >' + (hang.overhangAngle > 0 ? hang.overhangAngle : 15) +
            'deg from vertical (>' + hOverhangMaxHoriz.toFixed(2) + 'mm sideways/layer) prints at F' +
            Math.round(hOverhangFeed)
        );
      }
    }
    lines.push('; printFeed=' + cfg.printFeed + ' travelFeed=' + cfg.travelFeed + ' (mm/min)');
    lines.push(
      '; printer=' + mode + ' multiplier=' + mult +
        (mode === 'filament'
          ? ' filamentDiameter=' + filDia + ' (E in mm of filament)'
          : ' (E in mm^3, volumetric)')
    );
    if (includeStartEnd) {
      (mode === 'filament' ? marlinStart(fil) : klipperStart(pel)).forEach((l) => lines.push(l));
    }
    lines.push('G90 ; absolute positioning');
    lines.push('M83 ; relative extrusion');

    // ---- Shared emit helpers ----
    let prev = null;
    let prevBump = false;
    let prevU = 0;
    let lastFeed = null;
    let firstExtrude = true;
    // Tallest Z of any EXTRUDED (printed) point so far — tracks emitSeg and
    // extrudeLoop only, deliberately excluding travel moves. A clearance hop
    // based only on prev.z/dest.z can still crash through printed geometry
    // elsewhere on the part that is taller than either of those two points (a
    // domed disc's outer rings vs. an inner dest point, an attractor-drop
    // dip, etc.) — margins meant to clear "the print so far" need this
    // running max. Excluding travel Z matters: a hop's own clearance height
    // must not itself become the new "tallest Z" and double again on the
    // very next hop back down.
    let maxZEver = 0;
    function noteZ(z) {
      if (z > maxZEver) maxZEver = z;
    }

    function travelAbs(cur) {
      lines.push('G0 X' + f3(cur.x) + ' Y' + f3(cur.y) + ' Z' + f3(cur.z) + ' F' + Math.round(cfg.travelFeed));
      lastFeed = cfg.travelFeed;
      path.push({ x: cur.x, y: cur.y, z: cur.z, travel: true, feed: cfg.travelFeed, foamZone: foamZoneActive });
      prev = cur;
      moveCount++;
    }

    // General clearance hop: lift straight up to a safe Z (at least clearMargin,
    // and at least as high as both the current and destination Z), move over to
    // the destination XY at that height, then drop to the destination Z — so
    // the nozzle never drags across whatever was just printed (a brim, a prime
    // line) on its way to resume elsewhere.
    function hopTravel(dest, clearMargin) {
      const clearZ = Math.max(prev.z, dest.z, clearMargin);
      if (clearZ > prev.z + 1e-6) travelAbs({ x: prev.x, y: prev.y, z: clearZ });
      travelAbs({ x: dest.x, y: dest.y, z: clearZ });
      if (dest.z < clearZ - 1e-6) travelAbs(dest);
    }

    // Travel that clears a printed brim. Plain travel when no brim was printed
    // (unchanged output).
    let brimPrinted = false;
    function travelClear(dest) {
      if (brimPrinted && prev) hopTravel(dest, 2 * cfg.brim.layerHeight);
      else travelAbs(dest);
    }

    // Core extruding move at an explicit feedrate. E output is scaled by the
    // printer mode (volume vs filament mm) and the extrusion multiplier.
    function emitSeg(cur, feed, ramp, areaOvr) {
      const segLen = dist3(prev, cur);
      if (segLen < 1e-7) {
        prev = cur;
        return;
      }
      const dVol = (areaOvr || area) * segLen * ramp;
      totalVolume += dVol;
      materialVolume += dVol * (foamZoneActive ? foamCfg.extrusionPct / 100 : 1);
      pathLength += segLen;
      let line = 'G1 X' + f3(cur.x) + ' Y' + f3(cur.y) + ' Z' + f3(cur.z) + ' E' + f5(dVol * eFactor);
      if (feed !== lastFeed || firstExtrude) {
        line += ' F' + Math.round(feed);
        lastFeed = feed;
      }
      lines.push(line);
      path.push({ x: cur.x, y: cur.y, z: cur.z, travel: false, feed: feed, foamZone: foamZoneActive });
      firstExtrude = false;
      moveCount++;
      prev = cur;
      noteZ(cur.z);
    }

    // Pattern-aware move (bump segments use the bump feedrate).
    function emit(cur, curBump, ramp, L) {
      const inBump = curBump || prevBump;
      syncFan(inBump);
      emitSeg(cur, inBump ? bumpFeed : baseFeedAt(L), ramp);
      prevBump = curBump;
    }

    // ---- Bend stool: foaming (Klipper pellet only) ----
    // Low-density foaming PLA: the first and last printed layers stay at the
    // normal (pellet zone) temperature; every layer between them prints hotter
    // so the material foams and expands, which needs LESS extruded volume at
    // HIGHER speed to keep the actual material flow rate constant. Only one
    // number is exposed for that (foam extrusion %) — the matching speed % is
    // DERIVED (100*100/extrusionPct) rather than a second independent input,
    // so the two can never drift out of the flow-matched relationship.
    //
    // Both the entering and exiting prime lines always print at 100%/100%:
    // entering, the M220/M221 foam overrides are applied AFTER the prime line;
    // exiting, they are reverted to 100/100 BEFORE the prime line. That fixed
    // rule is what makes "prime before overriding" (entering) and "prime after
    // reverting" (exiting) simultaneously true without special-casing either
    // primer's own flow.
    const foamCfg = cfg.disc && cfg.disc.foam;
    let foamOn = isBS && !!(foamCfg && foamCfg.enabled);
    if (foamOn && mode !== 'pellet') {
      warnings.push('Foaming requires Pellet (Klipper) mode — ignored.');
      foamOn = false;
    }
    if (foamOn && T < 3) {
      warnings.push('Foaming needs at least 3 layers (first + a foam layer + last) — ignored.');
      foamOn = false;
    }
    let foamSpeedPct = 100;
    let primer1Area = 0;
    let primer2Area = 0;
    if (foamOn) {
      foamSpeedPct = Math.round(10000 / Math.max(1, foamCfg.extrusionPct));
      primer1Area = beadArea(foamCfg.primer1.lineWidth, foamCfg.primer1.layerHeight);
      primer2Area = beadArea(foamCfg.primer2.lineWidth, foamCfg.primer2.layerHeight);
    }
    // A prime line at machine X0/Y0 (independent of the part's bed position),
    // its own layer height/line width/feed, always at the current 100%/100%
    // override. dir: 'enter' (heat up, prime, THEN apply the foam overrides) |
    // 'exit' (revert overrides FIRST, cool down, THEN prime). dest is the next
    // point on the part (absolute machine coords) to resume printing at.
    function emitFoamTransition(dir, dest) {
      const entering = dir === 'enter';
      const primer = entering ? foamCfg.primer1 : foamCfg.primer2;
      const primerArea = entering ? primer1Area : primer2Area;
      const primerStart = { x: 0, y: 0, z: primer.layerHeight };
      const primerEnd = { x: primer.length, y: 0, z: primer.layerHeight };
      lines.push(
        '; --- foam ' + (entering ? 'ENTER' : 'EXIT') + ': ' +
          (entering
            ? 'heat to ' + foamCfg.tempUp + '/' + foamCfg.tempMid + '/' + foamCfg.tempDown + 'C'
            : 'cool to normal temps') + ' + prime ---'
      );
      if (!entering) {
        lines.push('M220 S100 ; foam exit: restore speed factor before priming');
        lines.push('M221 S100 ; foam exit: restore extrude factor before priming');
        // Mirrors reality exactly here, not just after the transition
        // finishes: the firmware is back to 100%/100% from this line on, so
        // the exit primer (and the travel to the next print point below)
        // must NOT be foam-scaled, same as reality.
        foamZoneActive = false;
      }
      const tUp = entering ? foamCfg.tempUp : pel.up;
      const tMid = entering ? foamCfg.tempMid : pel.mid;
      const tDown = entering ? foamCfg.tempDown : pel.down;
      lines.push('_GINGER_EXTRUDER_SET_UP S=' + tUp);
      lines.push('_GINGER_EXTRUDER_SET_MID S=' + tMid);
      lines.push('_GINGER_EXTRUDER_SET_DOWN S=' + tDown);
      // Clear by double the tallest Z printed anywhere so far, not just a
      // couple of layer heights — the transition travels clear across the
      // bed to X0/Y0, and a margin based only on the current point can still
      // clip taller geometry elsewhere on the part (dome edges, un-dropped
      // rings) that this specific point never reached.
      hopTravel(primerStart, 2 * maxZEver);
      // TEMPERATURE_WAIT with an exact-match wait (the _GINGER_EXTRUDER_WAIT_*
      // macros) can hang forever on this printer's PID zones, which settle
      // near but never exactly on the setpoint. Use a tolerant threshold
      // instead: entering foam (heating up), only the LAST zone (down =
      // extruder2, closest to the nozzle) needs to actually be hot, so wait
      // for it to reach at least target-2; exiting foam (cooling down), wait
      // for ALL THREE zones to have dropped to at most their target+2.
      if (entering) {
        lines.push('TEMPERATURE_WAIT SENSOR=extruder2 MINIMUM=' + (tDown - 2));
      } else {
        lines.push('TEMPERATURE_WAIT SENSOR=extruder MAXIMUM=' + (tUp + 2));
        lines.push('TEMPERATURE_WAIT SENSOR=extruder1 MAXIMUM=' + (tMid + 2));
        lines.push('TEMPERATURE_WAIT SENSOR=extruder2 MAXIMUM=' + (tDown + 2));
      }
      emitSeg(primerEnd, primer.feed, 1, primerArea);
      if (entering) {
        lines.push('M221 S' + foamCfg.extrusionPct + ' ; foam: reduced extrusion');
        lines.push('M220 S' + foamSpeedPct + ' ; foam: increased speed (flow-matched)');
        // Same idea as the exit case above, mirrored: the enter primer just
        // printed at 100%/100% (before this line), and the firmware is only
        // switched to the foam overrides from here on — so the travel to
        // the next print point below IS at the foam-sped-up rate.
        foamZoneActive = true;
      }
      hopTravel(dest, 2 * maxZEver);
    }
    if (foamOn) {
      lines.push(
        '; foam mode: temps up=' + foamCfg.tempUp + ' mid=' + foamCfg.tempMid + ' down=' + foamCfg.tempDown +
          'C on layers 2..' + (T - 1) + ' of ' + T +
          ', extrusion ' + foamCfg.extrusionPct + '% / speed ' + foamSpeedPct + '% (flow-matched)'
      );
      lines.push(
        '; foam primers: enter ' + foamCfg.primer1.length + 'mm @ ' + foamCfg.primer1.lineWidth + 'x' +
          foamCfg.primer1.layerHeight + 'mm F' + Math.round(foamCfg.primer1.feed) + ' | exit ' +
          foamCfg.primer2.length + 'mm @ ' + foamCfg.primer2.lineWidth + 'x' + foamCfg.primer2.layerHeight +
          'mm F' + Math.round(foamCfg.primer2.feed)
      );
    }

    // Wall point (no displacement) at loop L, fraction u.
    function wallPoint(L, u) {
      const sp = sampler.at(u);
      const baseZ = Math.min(lh * (L + u), cfg.totalHeight);
      return { x: sp.pos.x + cx, y: sp.pos.y + cy, z: baseZ };
    }

    // Brim: one closed loop at a fixed Z.
    function extrudeLoop(pts, z, a, feed) {
      for (let i = 0; i < pts.length; i++) {
        const A = pts[i];
        const B = pts[(i + 1) % pts.length];
        const segLen = Geo.dist(A, B);
        const dVol = a * segLen;
        totalVolume += dVol;
        pathLength += segLen;
        let line = 'G1 X' + f3(B.x + cx) + ' Y' + f3(B.y + cy) + ' Z' + f3(z) + ' E' + f5(dVol * eFactor);
        if (feed !== lastFeed) {
          line += ' F' + Math.round(feed);
          lastFeed = feed;
        }
        lines.push(line);
        path.push({ x: B.x + cx, y: B.y + cy, z: z, travel: false, feed: feed });
        moveCount++;
        noteZ(z);
      }
    }

    // Brim: an OPEN chained path (mouse-ear rings) — unlike extrudeLoop, does
    // not connect the last point back to the first.
    function extrudeOpenPath(pts, z, a, feed) {
      for (let i = 1; i < pts.length; i++) {
        const A = pts[i - 1];
        const B = pts[i];
        const segLen = Geo.dist(A, B);
        const dVol = a * segLen;
        totalVolume += dVol;
        pathLength += segLen;
        let line = 'G1 X' + f3(B.x + cx) + ' Y' + f3(B.y + cy) + ' Z' + f3(z) + ' E' + f5(dVol * eFactor);
        if (feed !== lastFeed) {
          line += ' F' + Math.round(feed);
          lastFeed = feed;
        }
        lines.push(line);
        path.push({ x: B.x + cx, y: B.y + cy, z: z, travel: false, feed: feed });
        moveCount++;
        noteZ(z);
      }
    }

    // ---- Brim ----
    // Outer and inner can both be enabled together. Each always starts at its
    // own far end (outer at the outermost line, inner at the innermost) and
    // prints TOWARD the wall — order is fixed, not a user choice, since that's
    // always the right direction: the far end is unsupported and benefits
    // from being laid down first, adjacent lines then anchor progressively
    // closer to the (already-adhered) wall.
    const brim = cfg.brim;
    const brimBase = isBS ? discOuterLoop : isVessel ? vBase : base;

    // Mouse-ear brim (outer only): the plain offset loops' corner arcs,
    // completed into full circles at each fillet's own center, clipped to
    // stay outside the wall (offset out by one full line width so the ear
    // material never touches it) and chained outer-ring-to-inner-ring into
    // one continuous spiral per corner instead of N separate travel-linked
    // loops. Only meaningful for a rounded-rectangle base — sharp/no fillet
    // (fillet=0) degenerates gracefully to circles centered on the point
    // corner, matching how real slicers target sharp corners specifically.
    // Coat hanger only: the vessel's wall is scaled by its own bottom-radius
    // profile (vBase = base * s0), so the fillet centers/radius derived
    // directly from cfg.shapeParams below would no longer match the actual
    // (scaled) wall there.
    let mouseEarOn = !!(brim && brim.enabled && brim.outerStyle === 'mouseEar' && brim.linesOuter > 0);
    if (mouseEarOn && (isBS || isVessel || cfg.shape !== 'roundedRect')) {
      warnings.push('Mouse-ear brim needs the coat hanger project with the rounded-rectangle shape — using a normal outer brim instead.');
      mouseEarOn = false;
    }
    if (isBS && brim && brim.enabled && brim.linesInner > 0) {
      warnings.push('Inner brim skipped — the disc is solid there; use an outer brim.');
    }
    if (brim && brim.enabled && brimBase) {
      // A brim line printed flat on the bed spreads differently from a wall
      // bead, so it gets its own extrusion multiplier (0 = same as the wall).
      // eFactor already carries the wall's multiplier, so scaling the bead
      // area by the ratio nets out to the brim's own.
      const bArea =
        beadArea(brim.lineWidth, brim.layerHeight) * (brim.multiplier > 0 ? brim.multiplier / mult : 1);
      const brimFeed = brim.feed > 0 ? brim.feed : cfg.printFeed;
      const centroid = brimBase.reduce((s, p) => ({ x: s.x + p.x, y: s.y + p.y }), { x: 0, y: 0 });
      centroid.x /= brimBase.length;
      centroid.y /= brimBase.length;
      const inradius = brimBase.reduce((m, p) => Math.min(m, Geo.dist(p, centroid)), Infinity);

      if (mouseEarOn) {
        // Exactly the normal offset brim below, with one difference: the
        // straight sections are dropped, leaving only the corner (fillet)
        // arcs — each printed as its own separate open path instead of one
        // closed loop.
        //
        // roundedRect() never actually generates a plain "straight" point —
        // every sample point lies on one of the 4 corner arcs; the straight
        // side is purely the IMPLICIT connecting segment between the last
        // point of one arc and the first point of the next. So a point
        // can't be classified as "arc vs straight" on its own — instead each
        // point is labeled with WHICH corner it belongs to (nearest corner
        // whose radius matches, within tolerance), and a straight section is
        // wherever that label changes between consecutive points (or is
        // unrecognized) — a run of points sharing one label is one corner's
        // arc. offsetClosed preserves point order, so the same per-point
        // labels (found once on the un-offset wall) apply to every ring.
        lines.push('; --- brim (outer, mouse ears, far->near) ---');
        const sp = cfg.shapeParams;
        const fl = Geo.roundedRectFillets(sp.width, sp.length, sp.fillet);
        const eps = Math.max(0.05, cfg.lineWidth * 0.25);
        function cornerOf(p) {
          for (let ci = 0; ci < fl.corners.length; ci++) {
            if (Math.abs(Geo.dist(p, fl.corners[ci]) - fl.rf) < eps) return ci;
          }
          return -1;
        }
        const labels = brimBase.map(cornerOf);
        const n = labels.length;
        const runs = [];
        let boundary = -1;
        for (let i = 0; i < n; i++) {
          if (labels[i] >= 0 && labels[i] !== labels[(i - 1 + n) % n]) {
            boundary = i;
            break;
          }
        }
        if (boundary < 0) {
          if (labels[0] >= 0) runs.push({ start: 0, len: n });
        } else {
          for (let i = 0; i < n; ) {
            const idx = (boundary + i) % n;
            if (labels[idx] < 0) {
              i++;
              continue;
            }
            let len = 1;
            while (len < n && labels[(idx + len) % n] === labels[idx]) len++;
            runs.push({ start: idx, len });
            i += len;
          }
        }
        // Grouped by mouse ear (not by ring): one corner's whole stack of
        // rings prints as a single boustrophedon chain — outermost ring
        // forward, then every following ring in from it printed in the
        // OPPOSITE direction, so each new ring starts right next to (one
        // line width from) where the previous one just ended, instead of
        // retracting and traveling back to a shared start point every time.
        // Same total path per ring, same far->near order, just chained
        // corner-by-corner instead of ring-by-ring — far less travel.
        const realRuns = runs.filter((run) => run.len >= 2);
        const ringLoops = [];
        for (let k = brim.linesOuter; k >= 1; k--) {
          const d = brim.lineWidth / 2 + cfg.lineWidth / 2 + (k - 1) * brim.lineWidth;
          ringLoops.push(Geo.offsetClosed(brimBase, d, dirSign));
        }
        realRuns.forEach((run) => {
          ringLoops.forEach((loop, ri) => {
            let arcPts = [];
            for (let i = 0; i < run.len; i++) arcPts.push(loop[(run.start + i) % n]);
            if (ri % 2 === 1) arcPts = arcPts.slice().reverse();
            travelAbs({ x: arcPts[0].x + cx, y: arcPts[0].y + cy, z: brim.layerHeight });
            extrudeOpenPath(arcPts, brim.layerHeight, bArea, brimFeed);
            brimPrinted = true;
          });
        });
        if (!realRuns.length) {
          warnings.push('Mouse-ear brim found no fillet arcs (fillet may be 0) — no outer brim printed.');
        }
      } else if (brim.linesOuter > 0) {
        lines.push('; --- brim (outer, far->near) ---');
        for (let k = brim.linesOuter; k >= 1; k--) {
          const d = brim.lineWidth / 2 + cfg.lineWidth / 2 + (k - 1) * brim.lineWidth;
          const loop = Geo.offsetClosed(brimBase, d, dirSign);
          travelAbs({ x: loop[0].x + cx, y: loop[0].y + cy, z: brim.layerHeight });
          extrudeLoop(loop, brim.layerHeight, bArea, brimFeed);
          brimPrinted = true;
        }
      }

      const innerCount = isBS ? 0 : brim.linesInner;
      if (innerCount > 0) {
        lines.push('; --- brim (inner, far->near) ---');
        // Offsetting inward is only safe up to a point — past it, the naive
        // per-vertex-normal offset can fold back on itself locally (e.g. a
        // thin shape's rounded ends, where the safe inward distance is much
        // smaller than the overall inradius) even where the coarse area/
        // inradius checks don't catch it, which lets an inner line cross the
        // shape's centerline and interfere with lines from the opposite edge
        // — or even the outer wall. Checking every offset point is still
        // inside the true wall catches that.
        //
        // Lines print far-to-near (largest offset first), so the largest
        // requested offset is checked FIRST, before any smaller (safer) one
        // has run — there's no "last offset that worked" yet at that point.
        // Find the safe maximum in a pre-pass instead, so it's already known
        // when an oversized line needs to fall back to it: every line past
        // the safe range reuses that same maximum (extra reinforcement at
        // the safe boundary) rather than either overshooting into the
        // opposite side or silently vanishing.
        function isSafeInnerLoop(d) {
          if (d >= inradius) return null;
          const loop = Geo.offsetClosed(brimBase, -d, dirSign);
          // dirSign flips the SIGN of a valid (non-degenerate, non-inverted)
          // loop's area too, since it flips brimBase's own winding sense —
          // compare in the "same orientation as brimBase" sense rather than
          // assuming positive/CCW.
          if (dirSign * Geo.signedArea(loop) <= 1e-3) return null;
          return loop.every((p) => Geo.pointInPolygon(p, brimBase)) ? loop : null;
        }
        const ds = [];
        for (let k = innerCount; k >= 1; k--) ds.push(brim.lineWidth / 2 + cfg.lineWidth / 2 + (k - 1) * brim.lineWidth);
        let maxSafeD = -1, maxSafeLoop = null;
        const safeLoops = ds.map((d) => {
          const loop = isSafeInnerLoop(d);
          if (loop && d > maxSafeD) {
            maxSafeD = d;
            maxSafeLoop = loop;
          }
          return loop;
        });
        for (let i = 0; i < ds.length; i++) {
          const k = innerCount - i;
          let d = ds[i];
          let loop = safeLoops[i];
          if (!loop) {
            if (!maxSafeLoop) {
              warnings.push('Inner brim line ' + k + ' skipped (no room for any inner brim line).');
              continue;
            }
            d = maxSafeD;
            loop = maxSafeLoop;
            warnings.push(
              'Inner brim line ' + k + ' would cross the shape — reusing the last safe offset (' +
                d.toFixed(2) + 'mm) instead.'
            );
          }
          travelAbs({ x: loop[0].x + cx, y: loop[0].y + cy, z: brim.layerHeight });
          extrudeLoop(loop, brim.layerHeight, bArea, brimFeed);
          brimPrinted = true;
        }
      }
    }

    // ---- Base u-samples (vase only) ----
    let uSet = [];
    if (!isBS) {
      for (let i = 0; i < base.length; i++) uSet.push(sampler.uOf(i));
      if (patternOn && type === 'weave') for (let j = 0; j < pat.bumps; j++) uSet.push(j / pat.bumps);
      uSet = Array.from(new Set(uSet.map((u) => +u.toFixed(9)))).sort((a, b) => a - b);
      if (uSet.length === 0 || uSet[0] > 1e-9) uSet.unshift(0);
    }

    // ---- Spike placement (blue-noise, seam-centered) ----
    const spikesMode = patternOn && type === 'spikes';
    const hwU = cfg.lineWidth / 2 / perim;
    let byLoop = {};
    if (spikesMode) {
      const zMin = plBottom * lh;
      const zMax = (T - plTop) * lh;
      const oMax = (cov / 2) * perim;
      let placed = 0;
      if (zMax > zMin && oMax > hwU * perim) {
        const spikes = bestCandidate(spikeCount, -oMax, oMax, zMin, zMax, (pat.seed | 0) || 1);
        if (pat.spikeBalance) relaxSpacing(spikes, -oMax, oMax, zMin, zMax);
        // Per-spike length variation: each tip's amplitude is amplitude +/- var,
        // drawn from a separate seeded stream so it is deterministic per seed and
        // independent of the (also seeded) placement. var=0 -> every spike is the
        // base amplitude (byte-identical to before).
        const spikeVar = Math.max(0, pat.spikeVar || 0);
        const arng = mulberry32((((pat.seed | 0) || 1) ^ 0x9e3779b9) >>> 0);
        spikes.forEach((sp) => {
          const u = (sp.s / perim + 1) % 1;
          let L = Math.round(sp.z / lh);
          if (L < plBottom) L = plBottom;
          if (L > Lmax - 1) L = Lmax - 1;
          const amp = Math.max(0, pat.amplitude + (arng() * 2 - 1) * spikeVar);
          (byLoop[L] = byLoop[L] || []).push({ u: u, amp: amp });
          placed++;
        });
      }
      if (placed < spikeCount) {
        warnings.push('Some spikes could not be placed (pattern area too small for the density).');
      }
      if ((pat.spikeVar || 0) > pat.amplitude) {
        warnings.push('Spike length variation exceeds the amplitude — some spikes will have zero length.');
      }
    }

    // ---- Per-loop emitters ----
    function weaveMag(L, u) {
      if (!patternOn || type !== 'weave') return 0;
      if (!layerPatterned(L) || !uInBand(u)) return 0;
      return pat.amplitude * Math.cos(Math.PI * (L + u) * pat.bumps);
    }
    function wpoint(L, u) {
      const sp = sampler.at(u);
      const nx = dirSign * sp.tan.y;
      const ny = dirSign * -sp.tan.x;
      const m = weaveMag(L, u);
      const lat = m * cosA;
      const baseZ = Math.min(lh * (L + u), cfg.totalHeight);
      return { p: { x: sp.pos.x + nx * lat + cx, y: sp.pos.y + ny * lat + cy, z: baseZ + m * sinA }, bump: m !== 0 };
    }

    function weaveLoop(L, uEnd) {
      const step = (u) => {
        const w = wpoint(L, u);
        const ramp = L === 0 ? Math.max(0, Math.min(1, (prevU + u) / 2)) : 1;
        emit(w.p, w.bump, ramp, L);
        prevU = u;
      };
      for (let i = 0; i < uSet.length; i++) {
        const u = uSet[i];
        if (L > 0 && u <= 1e-9) continue;
        if (u >= uEnd - 1e-9) continue;
        step(u);
      }
      step(uEnd);
    }

    function spikesLoop(L, uEnd) {
      let events = [];
      for (let i = 0; i < uSet.length; i++) {
        const u = uSet[i];
        if (L > 0 && u <= 1e-9) continue;
        if (u >= uEnd - 1e-9) continue;
        events.push({ u, tip: false });
      }
      const spk = (byLoop[L] || []).filter((s) => s.u > hwU * 1.2 && s.u < uEnd - hwU * 1.2);
      // Drop base-curve vertices inside a spike window — each spike replaces
      // that stretch of wall entirely, not just narrows it.
      if (spk.length) {
        events = events.filter((e) => !spk.some((s) => e.u > s.u - hwU + 1e-9 && e.u < s.u + hwU - 1e-9));
      }
      // Not a spike anymore: a "staple" — take the exact stretch of wall the
      // window cut away, push it straight out (90° turn away from the wall),
      // then straight back in (90° turn) to rejoin. Both arms push out along
      // the SAME direction — the wall's tangent at the spike's own center,
      // not each corner's own local tangent — so the two arms come out
      // truly parallel and the tip-to-tip move is a straight line the same
      // distance out as the arms themselves, even where the underlying
      // curve bends sharply over that narrow a span (e.g. inside a hanger
      // detour); using each corner's own tangent there let the two arms
      // point in different directions, twisting the staple. The two ends of
      // that pushed-out stretch (both at u=s.u-hwU and u=s.u+hwU, same
      // amplitude, so it's flat, not tapered to a point) share their own u
      // with the on-wall anchor at that boundary, so an explicit tiebreak
      // orders them: on-wall -> pushed-out at the START boundary, pushed-out
      // -> on-wall at the END boundary.
      spk.forEach((s) => {
        const tan = sampler.at(s.u).tan;
        events.push({ u: s.u - hwU, tip: false, order: 0 });
        events.push({ u: s.u - hwU, tip: true, amp: s.amp, tan: tan, order: 1 });
        events.push({ u: s.u + hwU, tip: true, amp: s.amp, tan: tan, order: 0, dwellAfter: true });
        events.push({ u: s.u + hwU, tip: false, order: 1 });
      });
      events.sort((a, b) => a.u - b.u || (a.order || 0) - (b.order || 0));
      events.push({ u: uEnd, tip: false });
      let prevTipFan = false;
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        let cur;
        if (e.tip) {
          const sp = sampler.at(e.u);
          const amp = e.amp != null ? e.amp : pat.amplitude;
          const lat = amp * cosA;
          const baseZ = Math.min(lh * (L + e.u), cfg.totalHeight);
          cur = {
            x: sp.pos.x + dirSign * e.tan.y * lat + cx,
            y: sp.pos.y - dirSign * e.tan.x * lat + cy,
            z: baseZ + amp * sinA,
          };
        } else {
          cur = wallPoint(L, e.u);
        }
        const ramp = L === 0 ? Math.max(0, Math.min(1, (prevU + e.u) / 2)) : 1;
        // The initial 90° push OUT, the flat pushed-out stretch itself, and
        // the move back IN each get their own dedicated feed — no hysteresis
        // carrying one into further segments, unlike the shared emit()
        // helper's symmetric bump zone for weave. Which of the three a tip
        // segment is comes down to whether the PREVIOUS event was also a tip
        // (arriving at the second tip corner, i.e. the flat stretch) or not
        // (arriving at the first, i.e. the initial push out). Fan stays on
        // through the whole excursion (out, along, dwell, AND back in) — it
        // only turns off once fully back at the wall — so it needs its own,
        // separately-tracked hysteresis.
        syncFan(e.tip || prevTipFan);
        const feed = e.tip ? (prevTipFan ? spikeFeedTip : spikeFeedOut) : prevTipFan ? spikeFeedIn : baseFeedAt(L);
        emitSeg(cur, feed, ramp, e.tip || prevTipFan ? spikeArea : null);
        if (e.dwellAfter && spikeDwellMs > 0) lines.push('G4 P' + spikeDwellMs + ' ; spike tip dwell');
        prevTipFan = !!e.tip;
        prevU = e.u;
      }
    }

    // Hanger / tween loops: emit a polyline (fractions by arc length of THIS
    // loop, so Z stays continuous). The pattern stays active, parameterized by
    // the loop fraction (which matches base-u away from the morph region):
    // spikes are inserted as events, weave displaces along the local normal.
    // bridge=true applies the bridge feedrate to the new (bezier + pocket)
    // sections of the hanger loop.
    function polyLoop(L, pts, bridge, uEnd) {
      const n1 = pts.length;
      const cum = [0];
      let total = 0;
      for (let i = 1; i < n1; i++) {
        total += Geo.dist(pts[i - 1], pts[i]);
        cum.push(total);
      }
      if (total < 1e-9) return;

      let events = [];
      for (let i = 1; i < n1; i++) events.push({ f: cum[i] / total });
      if (spikesMode) {
        const hwF = cfg.lineWidth / 2 / total;
        const spk = (byLoop[L] || []).filter((s) => s.u > hwF * 1.2 && s.u < uEnd - hwF * 1.2);
        // Drop this loop's own (often very dense — 400 pts on a tween) vertices
        // that fall inside a spike window — each spike replaces that stretch
        // of wall entirely, not just narrows it.
        if (spk.length) {
          events = events.filter((e) => !spk.some((s) => e.f > s.u - hwF + 1e-9 && e.f < s.u + hwF - 1e-9));
        }
        // Not a spike anymore: a "staple" — see spikesLoop for the full
        // explanation of why both arms push out along ONE shared direction
        // (the underlying curve's tangent at the spike's own center, looked
        // up independently of the rolling cursor below) instead of each
        // corner's own local tangent — critical here, since this loop walks
        // the hanger/tween polyline, whose tangent can swing hard over a
        // span as narrow as one line width (inside a taper or cap). Same
        // on-wall/pushed-out tiebreak at each boundary.
        spk.forEach((s) => {
          let seg0 = 1;
          const target0 = Math.max(0, Math.min(1, s.u)) * total;
          while (seg0 < n1 - 1 && cum[seg0] < target0) seg0++;
          const a0 = pts[seg0 - 1], b0 = pts[seg0];
          const dx0 = b0.x - a0.x, dy0 = b0.y - a0.y;
          const len0 = Math.hypot(dx0, dy0) || 1e-9;
          const tan = { tx: dx0 / len0, ty: dy0 / len0 };
          events.push({ f: s.u - hwF, order: 0 });
          events.push({ f: s.u - hwF, tip: true, amp: s.amp, tan: tan, order: 1 });
          events.push({ f: s.u + hwF, tip: true, amp: s.amp, tan: tan, order: 0, dwellAfter: true });
          events.push({ f: s.u + hwF, order: 1 });
        });
        events.sort((a, b) => a.f - b.f || (a.order || 0) - (b.order || 0));
      }

      // Rolling-cursor point lookup (events are sorted by f, so this is O(n)).
      let seg = 1;
      function atF(f) {
        const target = Math.max(0, Math.min(1, f)) * total;
        while (seg < n1 - 1 && cum[seg] < target) seg++;
        const a = pts[seg - 1];
        const b = pts[seg];
        const sl = cum[seg] - cum[seg - 1] || 1e-9;
        const t = Math.max(0, Math.min(1, (target - cum[seg - 1]) / sl));
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1e-9;
        return {
          x: a.x + dx * t,
          y: a.y + dy * t,
          tx: dx / len,
          ty: dy / len,
          isNew: !!(a.isNew || b.isNew),
          hot: !!(a.hot || b.hot),
        };
      }

      prevBump = false;
      let prevWeaveSpecial = false;
      let prevNew = false;
      let prevHot = false;
      let prevTipFan = false;
      for (let i = 0; i <= events.length; i++) {
        const endCut = i === events.length || events[i].f >= uEnd - 1e-12;
        const e = endCut ? { f: uEnd } : events[i];
        const q = atF(e.f);
        let m = 0;
        if (!e.tip && patternOn && type === 'weave' && layerPatterned(L) && uInBand(e.f)) {
          m = pat.amplitude * Math.cos(Math.PI * (L + e.f) * pat.bumps);
        }
        const amp = e.tip ? (e.amp != null ? e.amp : pat.amplitude) : m;
        const lat = amp * cosA;
        const z = Math.min(lh * (L + e.f), cfg.totalHeight) + amp * sinA;
        const weaveSpecial = m !== 0;
        const bridgeNow = bridge && (q.isNew || prevNew);
        const overhangNow = hOverhangOn && (q.hot || prevHot);
        let feed = baseFeedAt(L);
        if (bridgeNow) feed = hBridgeFeed;
        else if (overhangNow) feed = hOverhangFeed;
        // Spike out/tip/in each get their own dedicated feed — no hysteresis
        // carrying one into further segments, unlike weave's smooth
        // (both-directions) bump zone below. Which of the three a tip
        // segment is comes down to whether the previous event was also a tip
        // (the flat stretch) or not (the initial push out) — see spikesLoop.
        else if (e.tip) feed = prevTipFan ? spikeFeedTip : spikeFeedOut;
        else if (prevTipFan) feed = spikeFeedIn;
        else if (weaveSpecial || prevWeaveSpecial) feed = bumpFeed;
        // Fan (bumps-only mode) covers every slow/unsupported zone here —
        // bridge, overhang, weave bumps — plus the spike tip, but the tip's
        // OWN hysteresis stays symmetric (on through the move back in too)
        // unlike its feed, which is deliberately asymmetric above.
        syncFan(bridgeNow || overhangNow || weaveSpecial || prevWeaveSpecial || e.tip || prevTipFan);
        const nrm = e.tip ? e.tan : q;
        emitSeg(
          { x: q.x + dirSign * nrm.ty * lat + cx, y: q.y - dirSign * nrm.tx * lat + cy, z: z },
          feed,
          1,
          e.tip || prevTipFan ? spikeArea : null
        );
        if (e.dwellAfter && spikeDwellMs > 0) lines.push('G4 P' + spikeDwellMs + ' ; spike tip dwell');
        prevWeaveSpecial = weaveSpecial;
        prevNew = q.isNew;
        prevHot = q.hot;
        prevTipFan = !!e.tip;
        if (endCut) break;
      }
    }

    // ---- Body ----
    if (isVessel) {
      // Closed bottom (concentric fill, one line width inside the wall so the
      // wall butts its outer edge), then the wall spiral from z=0 up and out
      // along the radius profile. Top finish: an extra flat extrusion-ramp-down
      // loop (default), or none — the spiral just ends at full flow.
      const tolV = cfg.tolerance > 0 ? cfg.tolerance : 0.05;
      const wallH = vWallN * lh;
      lines.push(
        '; --- vessel: ' + vBottomLayers + '-layer bottom (' +
          (vBottomStyle === 'spiral' ? 'true spiral, continuous into wall' : vAlt ? 'zipper' : 'staircase') +
          ') + spiral wall to z=' + wallH.toFixed(2) + ' ---'
      );

      const innerBase = Geo.offsetClosed(vBase, -cfg.lineWidth, dirSign);
      const vSpiralB = vBottomStyle === 'spiral';
      const fill = Geo.ringFill(
        innerBase, cfg.lineWidth, tolV, vBottomStyle, cfg.seamSide || 'back', vSpiralB ? vBase : null
      );
      if (!fill.loops.length) {
        warnings.push('Bottom is too small to fill at this line width — the vessel has no closed bottom.');
      }
      // Spiral bottom: one unbroken line through ALL bottom layers and into
      // the wall — zero travels. The layers alternate direction (out, in,
      // out, …), each starting where the previous ended; the first layer's
      // direction is chosen by parity so the LAST always runs outward onto
      // the wall curve, whose stacked transition revolutions ARE the wall's
      // lowest layers. The helix then picks up from there (no travel, no bed
      // ramp). The z step between layers rides on each layer's first segment,
      // like any spiral layer change.
      const vContinuous = vSpiralB && vBottomLayers > 0 && fill.loops.length > 0;
      let wallStartL = 0;
      if (vContinuous) {
        wallStartL = Math.min(vBottomLayers, vWallN - 1);
        if (vBottomLayers >= vWallN) {
          warnings.push('Wall height gives fewer revolutions than bottom layers — increase wall height for a clean spiral-bottom handoff.');
        }
      }
      if (vContinuous) {
        const poly = fill.loops[0];
        const startFwd = vBottomLayers % 2 === 1;
        const first = startFwd ? poly[0] : poly[poly.length - 1];
        travelClear({ x: first.x + cx, y: first.y + cy, z: lh });
        for (let k = 0; k < vBottomLayers; k++) {
          const z = (k + 1) * lh;
          const fwd = startFwd ? k % 2 === 0 : k % 2 === 1;
          if (k === 1 && includeStartEnd && fanPWM > 0) {
            lines.push('M106 S' + fanPWM + ' ; part cooling fan on');
          }
          for (let q = 1; q < poly.length; q++) {
            // Points carry their own extrusion factor (taper where the spiral
            // peels off the center ring) — unchanged under reversal, since
            // the local line spacing is the same in both directions.
            const p = fwd ? poly[q] : poly[poly.length - 1 - q];
            emitSeg({ x: p.x + cx, y: p.y + cy, z: z }, cfg.printFeed, p.e != null ? p.e : 1);
          }
        }
      } else {
        for (let k = 0; k < vBottomLayers && fill.loops.length; k++) {
          const z = (k + 1) * lh;
          if (k === 1 && includeStartEnd && fanPWM > 0) {
            lines.push('M106 S' + fanPWM + ' ; part cooling fan on');
          }
          (k === 0 ? travelClear : travelAbs)({ x: fill.loops[0][0].x + cx, y: fill.loops[0][0].y + cy, z: z });
          for (let i = 0; i < fill.loops.length; i++) {
            const lp = fill.loops[i];
            for (let q = i === 0 ? 1 : 0; q < lp.length; q++) {
              emitSeg({ x: lp[q].x + cx, y: lp[q].y + cy, z: z }, cfg.printFeed, 1);
            }
          }
        }
      }

      // Wall point at revolution L, fraction u — base scaled by the profile.
      function vW(L, u) {
        const sp = sampler.at(u);
        const z = Math.min(lh * (L + u), wallH);
        const s = vProfile(z / wallH);
        return { x: sp.pos.x * s + cx, y: sp.pos.y * s + cy, z: z };
      }
      if (!vContinuous) {
        const startW = vW(0, 0);
        travelClear({ x: startW.x, y: startW.y, z: 0 });
      }
      let pu = 0;
      for (let L = wallStartL; L < vWallN; L++) {
        if (L === 1 && includeStartEnd && fanPWM > 0 && vBottomLayers < 2) {
          lines.push('M106 S' + fanPWM + ' ; part cooling fan on after ramp loop');
        }
        for (let i = 0; i < uSet.length; i++) {
          const u = uSet[i];
          if (u <= 1e-9) continue;
          const w = vW(L, u);
          const ramp = L === 0 ? Math.max(0, Math.min(1, (pu + u) / 2)) : 1;
          emitSeg(w, cfg.printFeed, ramp);
          pu = u;
        }
        const wEnd = vW(L, 1);
        const rampEnd = L === 0 ? Math.max(0, Math.min(1, (pu + 1) / 2)) : 1;
        emitSeg(wEnd, cfg.printFeed, rampEnd);
        pu = 0;
      }

      // Top finish. Flat cap: one extra revolution at z=wallH with the
      // extrusion ramping 1 -> 0 and no height gain, so the top closes off
      // cleanly on top of the last loop and tapers to nothing at the seam.
      // Open spiral: no extra loop — the wall's last revolution already ends
      // at full height and full flow, leaving a one-layer helical step at the
      // seam (an even bead all the way, good for open rims).
      if (vFlatTop) {
        lines.push('; flat top: no z gain, extrusion ramps to zero for a clean finish');
        const sTop = vProfile(1);
        pu = 0;
        for (let i = 0; i < uSet.length; i++) {
          const u = uSet[i];
          if (u <= 1e-9) continue;
          const sp = sampler.at(u);
          const ramp = Math.max(0, Math.min(1, 1 - (pu + u) / 2));
          emitSeg({ x: sp.pos.x * sTop + cx, y: sp.pos.y * sTop + cy, z: wallH }, cfg.printFeed, ramp);
          pu = u;
        }
        const spTop = sampler.at(0);
        emitSeg(
          { x: spTop.pos.x * sTop + cx, y: spTop.pos.y * sTop + cy, z: wallH },
          cfg.printFeed,
          Math.max(0, Math.min(1, 1 - (pu + 1) / 2))
        );
      } else {
        lines.push('; open spiral top: wall ends at full flow, no cap loop');
      }
    } else if (!isBS) {
      lines.push(
        '; --- vase spiral' + (patternOn ? ' + ' + type : '') + (hangOn ? ' + hanger' : '') + ' ---'
      );

      const start = spikesMode ? wallPoint(0, 0) : wpoint(0, 0).p;
      travelClear({ x: start.x, y: start.y, z: 0 });
      prevBump = false;
      prevU = 0;

      for (let L = 0; L < Lmax; L++) {
        const uEnd = Math.min(1, T - L);
        if (L === 1 && includeStartEnd && fanPWM > 0 && !fanBumpsOnly) {
          lines.push('M106 S' + fanPWM + ' ; part cooling fan on after ramp loop');
        }
        if (inBand(L)) {
          if (L === hStart) {
            lines.push('; hanger loop (bridging sections at F' + Math.round(hBridgeFeed) + ')');
            polyLoop(L, hangerPts, true, uEnd);
          } else {
            const t = L - hStart;
            const curPts = tweenLoopPts(t);
            if (hOverhangOn) tagOverhang(curPts, tweenLoopPts(t - 1));
            polyLoop(L, curPts, false, uEnd);
          }
        } else if (spikesMode) {
          spikesLoop(L, uEnd);
        } else {
          weaveLoop(L, uEnd);
        }
      }

      // Flat ramp-down top (matching the vessel): one final revolution at the
      // top height with no z gain and the extrusion tapering to zero, so the
      // rim finishes level and clean instead of on a spiral ramp. Plain wall —
      // no pattern — for a tidy edge.
      syncFan(false);
      const topZ = cfg.totalHeight;
      const f0 = Math.min(1, T - (Lmax - 1)) % 1; // fraction where the spiral ended
      lines.push('; flat top: no z gain, extrusion ramps to zero for a clean rim');
      const seqU = [];
      for (let i = 0; i < uSet.length; i++) if (uSet[i] > f0 + 1e-9) seqU.push(uSet[i]);
      for (let i = 0; i < uSet.length; i++) if (uSet[i] <= f0 + 1e-9) seqU.push(uSet[i]);
      seqU.push(f0); // close the revolution back to the start fraction
      let pf = f0;
      let trav = 0;
      for (let k = 0; k < seqU.length; k++) {
        const u = seqU[k];
        let d = u - pf;
        if (d <= 1e-9) d += 1; // forward-wrap the fraction
        trav = Math.min(1, trav + d);
        const sp = sampler.at(u);
        emitSeg({ x: sp.pos.x + cx, y: sp.pos.y + cy, z: topZ }, cfg.printFeed, Math.max(0, 1 - trav));
        pf = u;
      }
    } else {
      // ---- Bend stool: concentric rings, inner to outer, staircase seam ----
      // Each ring is traced CCW and stops one line width of arc before its own
      // start; a radial connector steps out to the next ring there, so the seam
      // shifts backward by lw/r radians per ring (a staircase drifting CW).
      lines.push(
        '; --- bend stool disc: ' + ringN + ' rings, ' + T + ' layer(s), D=' + snappedD +
          (legs ? ', 3 legs' : '') +
          ', seam=' + (cfg.disc.seamStyle === 'alternating' ? 'alternating (fixed)' : 'staircase') + ' ---'
      );
      const lw = cfg.lineWidth;
      const tol = cfg.tolerance > 0 ? cfg.tolerance : 0.05;

      // Dome: per-loop layer-height multiplier, bezier-eased from the center
      // value (input) to 1.0 at the outermost loop. Slow start, fast middle,
      // tiny falloff at the end: f(t) = 2.7(1-t)t^2 + t^3 (f'(0)=0, f'(1)=0.3).
      // The first printed layer stays uniform at the nominal layer height.
      const dm = Math.max(0.05, Math.min(1, cfg.disc.dome != null ? cfg.disc.dome : 1));
      const domed = ringN > 1 && dm < 1 - 1e-9;
      const easeD = (t) => 2.7 * (1 - t) * t * t + t * t * t;
      const loopH = [];
      const loopArea = [];
      for (let i = 0; i < ringN; i++) {
        const h = domed ? lh * (dm + (1 - dm) * easeD(i / (ringN - 1))) : lh;
        loopH.push(h);
        loopArea.push(domed ? beadArea(lw, h) : area);
      }
      if (domed) {
        // The top layer always adds a full lh everywhere (see zAt/zRingAt),
        // so "top z at center" is one full lh higher than a naive continuation
        // of the eased eash-layer step would give.
        const topZCenter = T > 1 ? 2 * lh + Math.max(0, T - 2) * dm * lh : lh;
        lines.push(
          '; dome: center x' + dm + ' (' + (dm * lh).toFixed(2) + 'mm/layer) -> edge ' + lh +
            'mm/layer, full height on the top layer everywhere; top z ' + topZCenter.toFixed(2) +
            ' center vs ' + (T * lh).toFixed(2) + ' edge'
        );
      }

      // ---- Volumetric flow feed mode ----
      // Constant printFeed makes the actual material flow (area x speed) vary
      // wherever the dome shrinks the bead height. This mode inverts that: hold
      // a target volumetric flow (mm^3/s) and derive the feed per segment from
      // its OWN bead area, so thinner (domed) beads print faster and full-height
      // beads print slower, at a constant flow throughout. Off by default
      // (byte-identical to a fixed printFeed).
      const flowCfg = cfg.disc.flowFeed || {};
      const flowOn = !!flowCfg.enabled && flowCfg.rate > 0;
      const areaMin = domed ? beadArea(lw, dm * lh) : area;
      const areaMax = area; // every edge ring, plus the always-full-height first/top layers
      function feedForArea(a) {
        if (!flowOn) return cfg.printFeed;
        return (flowCfg.rate * 60) / Math.max(a, 1e-6); // mm^3/s -> mm/min
      }
      if (flowOn) {
        const feedAtMin = feedForArea(areaMin); // smallest area -> fastest feed
        const feedAtMax = feedForArea(areaMax); // largest area -> slowest feed
        lines.push(
          '; volumetric flow mode: target ' + flowCfg.rate + ' mm3/s -> feed ' + feedAtMax.toFixed(0) +
            '..' + feedAtMin.toFixed(0) + ' mm/min (bead area ' + areaMin.toFixed(2) + '..' +
            areaMax.toFixed(2) + ' mm2, slowest..fastest)'
        );
      } else {
        const flowAtMin = (cfg.printFeed * areaMin) / 60;
        const flowAtMax = (cfg.printFeed * areaMax) / 60;
        lines.push(
          '; constant feed ' + cfg.printFeed + ' mm/min -> volumetric flow ' + flowAtMin.toFixed(2) +
            '..' + flowAtMax.toFixed(2) + ' mm3/s (bead area ' + areaMin.toFixed(2) + '..' +
            areaMax.toFixed(2) + ' mm2)'
        );
      }

      // Layer-to-layer travel safety margin. A domed disc's inner rings sit
      // LOWER than the current layer's (taller) outer rings — and, more
      // generally, the overhang drop can locally sink points below their
      // nominal height too — so a direct travel from where one layer ends to
      // where the next starts can dip through material already printed at a
      // different radius (verified: 0.3-0.6mm descents on a domed disc without
      // this). A full lift-in-place-then-move (like the brim/foam clearance
      // hop) would leave a small blob of oozed material sitting on the print —
      // worse, especially with foaming active. Instead: one diagonal move
      // aimed at a point 2 layer heights ABOVE the real target (still a single
      // straight line, just higher), then one straight vertical drop to the
      // actual start — two moves, wiping clear without idling in place.
      function travelWipe(dest) {
        travelAbs({ x: dest.x, y: dest.y, z: dest.z + 2 * lh });
        travelAbs(dest);
      }

      if (legLoops) {
        // Chained precomputed loops: each loop starts at the previous loop's
        // end angle, so the first point of loop i+1 IS the radial connector.
        // With the spread gradient, each layer gets its own loop set scaled
        // k/(T-1): collected at the bottom, fully spread at the top.
        //
        // Overhang drop (nonplanar, accumulating): the TRAVEL height sinks in
        // the overhang zone while EXTRUSION stays at the full local layer
        // height — the squish deliberately overfills the reduced gap, since
        // slanted layers have more volume to cover. Per-pair spacing at a
        // point becomes hs*(1 - drop*ratio) with ratio = overhang steepness
        // (D_loop*kfac / Dmax), so the nonplanarity accumulates: layer k sinks
        // k x as much as layer 1. With w tagged at its own layer scale the
        // accumulated drop collapses to z = zb - drop*hs*(T-1)*w/Dmax, where
        // hs is the loop's own (dome-adjusted) layer height.
        const at3 = cfg.disc.attractor || {};
        const dropMult = attrGrad ? Math.max(0, Math.min(1, at3.drop || 0)) : 0;
        const DmaxA = legs ? ((2 * (legs.m - 1) + 1) * (at3.gap || 1) * lw) / 2 : 0;
        const dropOn = dropMult > 0 && DmaxA > 0;
        function loopsAt(kk) {
          if (!attrGrad || kk === T - 1) return legLoops;
          // Fresh per-layer recompute (bend-spread gradient): legLoops is
          // already bsFit'd once above, but this fresh build isn't yet.
          return discLoops(cfg, discSpecMemo, kk / (T - 1)).loops.map((lp) => lp.map(bsFit));
        }
        // Standard domed z at ring i, layer kk: the eased loopH[i] accumulates
        // every layer from the (uniform, full-height) base up. The TOP layer
        // is a special case (see zAt): it always adds a full lh on top of
        // whatever's underneath, so the print finishes with a full-strength
        // top skin even though the surface it sits on is still domed.
        function zBase(kk, i) {
          return domed && kk > 0 ? lh + kk * loopH[i] : (kk + 1) * lh;
        }
        function zAt(kk, i, pt) {
          const zb = domed && kk === T - 1 && kk > 0 ? zBase(kk - 1, i) + lh : zBase(kk, i);
          if (!dropOn) return zb;
          const dc = (dropMult * loopH[i] * (T - 1)) / DmaxA;
          return Math.max(lh, zb - dc * (pt.w || 0));
        }
        let afterFoam = false;
        for (let k = 0; k < T; k++) {
          if (k === 1 && includeStartEnd && fanPWM > 0) {
            lines.push('M106 S' + fanPWM + ' ; part cooling fan on after first layer');
          }
          const loopsK = loopsAt(k);
          if (k === 0) {
            // First layer prints OUTSIDE-IN (outermost ring/legs inward to the
            // seat center) so an ENTRANCE PRIMER can lead cleanly into it: a
            // straight radial line ending exactly at the outermost ring's own
            // seam point, so the corner from primer to ring is a real 90 deg
            // turn (radial into tangential) rather than an arbitrary jump.
            // Reusing each ring's own array reversed (instead of building new
            // geometry) works because the forward chaining already guarantees
            // ring i's original START equals ring i-1's original END — so
            // ring i's REVERSED end (= original start) lines up exactly with
            // ring i-1's REVERSED start (= original end), the same short
            // radial connector, just walked from the outside in.
            const outerRing = loopsK[ringN - 1];
            const seamPt = outerRing[outerRing.length - 1];
            // With a brim, the entrance primer is both redundant (the brim
            // already primes the nozzle) and physically in the way (its
            // outward radial lead-in sits right where the brim's own rings
            // are) - skip it and travel (brim-aware) straight to the seam.
            if (brimPrinted) {
              travelClear({ x: cx + seamPt.x, y: cy + seamPt.y, z: lh });
            } else {
              const dx = seamPt.x - bsShiftX;
              const dy = seamPt.y - bsShiftY;
              const rOuter = Math.hypot(dx, dy) || 1;
              const primerLen = 0.25 * snappedD;
              const primerStart = {
                x: cx + seamPt.x + (dx / rOuter) * primerLen,
                y: cy + seamPt.y + (dy / rOuter) * primerLen,
                z: lh,
              };
              lines.push(
                '; entrance primer: ' + primerLen.toFixed(1) + 'mm radial lead-in (25% of seat diameter) ' +
                  'to the outer seam, then layer 1 outside-in'
              );
              travelClear(primerStart);
              emitSeg({ x: cx + seamPt.x, y: cy + seamPt.y, z: lh }, feedForArea(area), 1, null);
            }
            for (let i = ringN - 1; i >= 0; i--) {
              const lp = loopsK[i].slice().reverse();
              for (let q = i === ringN - 1 ? 1 : 0; q < lp.length; q++) {
                emitSeg({ x: cx + lp[q].x, y: cy + lp[q].y, z: zAt(0, i, lp[q]) }, feedForArea(area), 1, null);
              }
            }
          } else {
            if (!afterFoam) {
              travelWipe({ x: cx + loopsK[0][0].x, y: cy + loopsK[0][0].y, z: zAt(k, 0, loopsK[0][0]) });
            }
            afterFoam = false;
            for (let i = 0; i < ringN; i++) {
              const lp = loopsK[i];
              const aOvr = domed && k > 0 && k !== T - 1 ? loopArea[i] : null;
              const ringFeed = feedForArea(aOvr || area);
              for (let q = i === 0 ? 1 : 0; q < lp.length; q++) {
                emitSeg({ x: cx + lp[q].x, y: cy + lp[q].y, z: zAt(k, i, lp[q]) }, ringFeed, 1, aOvr);
              }
            }
          }
          if (foamOn && (k === 0 || k === T - 2)) {
            const loopsNext = loopsAt(k + 1);
            const dest = {
              x: cx + loopsNext[0][0].x, y: cy + loopsNext[0][0].y, z: zAt(k + 1, 0, loopsNext[0][0]),
            };
            emitFoamTransition(k === 0 ? 'enter' : 'exit', dest);
            afterFoam = true;
          }
        }
      } else {
        const a0 = Math.PI / 2;
        function zRingBase(kk, i) {
          return domed && kk > 0 ? lh + kk * loopH[i] : (kk + 1) * lh;
        }
        // Top layer: always a full lh on top of whatever's underneath (still
        // domed), rather than the eased loopH[i] — see zAt in the legLoops
        // branch for the full reasoning.
        function zRingAt(kk, i) {
          return domed && kk === T - 1 && kk > 0 ? zRingBase(kk - 1, i) + lh : zRingBase(kk, i);
        }
        function ringPt(i, ang) {
          return bsFit({ x: ringRadii[i] * Math.cos(ang), y: ringRadii[i] * Math.sin(ang) });
        }
        // Build ring i's own swept points (bsFit'd), starting at angle aStart;
        // optionally prefixed with a connector point (ring i's own radius, at
        // the angle the previous ring left off) — mirrors the legLoops
        // convention where ring i>0's first array point IS that connector, so
        // the same reversal trick (see the k===0 branch below) applies here too.
        function buildRing(i, aStart, withConnector) {
          const r = ringRadii[i];
          const sweep = 2 * Math.PI - lw / r;
          let dth = 2 * Math.acos(Math.max(-1, 1 - tol / r));
          if (!isFinite(dth) || dth <= 0) dth = 0.2;
          const steps = Math.max(12, Math.ceil(sweep / dth));
          const pts = [];
          if (withConnector) pts.push(ringPt(i, aStart));
          for (let s = 1; s <= steps; s++) pts.push(ringPt(i, aStart + (sweep * s) / steps));
          return { pts: pts, aEnd: (aStart + sweep) % (2 * Math.PI) };
        }
        let afterFoam = false;
        for (let k = 0; k < T; k++) {
          if (k === 1 && includeStartEnd && fanPWM > 0) {
            lines.push('M106 S' + fanPWM + ' ; part cooling fan on after first layer');
          }
          if (k === 0) {
            // Same outside-in + entrance-primer treatment as the legLoops
            // branch (see there for the full reasoning): materialize each
            // ring's own points (forward order) first, then reverse and walk
            // outermost -> innermost, led in by a radial primer to the
            // outermost ring's own seam point.
            const rings0 = [];
            let aCur = a0;
            for (let i = 0; i < ringN; i++) {
              const built = buildRing(i, aCur, i > 0);
              rings0.push(built.pts);
              aCur = built.aEnd;
            }
            const outerRing = rings0[ringN - 1];
            const seamPt = outerRing[outerRing.length - 1];
            // With a brim, the entrance primer is both redundant (the brim
            // already primes the nozzle) and physically in the way (its
            // outward radial lead-in sits right where the brim's own rings
            // are) - skip it and travel (brim-aware) straight to the seam.
            if (brimPrinted) {
              travelClear({ x: cx + seamPt.x, y: cy + seamPt.y, z: lh });
            } else {
              const dx = seamPt.x - bsShiftX;
              const dy = seamPt.y - bsShiftY;
              const rOuter = Math.hypot(dx, dy) || 1;
              const primerLen = 0.25 * snappedD;
              const primerStart = {
                x: cx + seamPt.x + (dx / rOuter) * primerLen,
                y: cy + seamPt.y + (dy / rOuter) * primerLen,
                z: lh,
              };
              lines.push(
                '; entrance primer: ' + primerLen.toFixed(1) + 'mm radial lead-in (25% of seat diameter) ' +
                  'to the outer seam, then layer 1 outside-in'
              );
              travelClear(primerStart);
              emitSeg({ x: cx + seamPt.x, y: cy + seamPt.y, z: lh }, feedForArea(area), 1, null);
            }
            for (let i = ringN - 1; i >= 0; i--) {
              const lp = rings0[i].slice().reverse();
              for (let q = i === ringN - 1 ? 1 : 0; q < lp.length; q++) {
                emitSeg({ x: cx + lp[q].x, y: cy + lp[q].y, z: zRingAt(0, i) }, feedForArea(area), 1, null);
              }
            }
          } else {
            let a = a0;
            if (!afterFoam) {
              const p0 = ringPt(0, a);
              travelWipe({ x: cx + p0.x, y: cy + p0.y, z: zRingAt(k, 0) });
            }
            afterFoam = false;
            for (let i = 0; i < ringN; i++) {
              const r = ringRadii[i];
              const zi = zRingAt(k, i);
              const aOvr = domed && k > 0 && k !== T - 1 ? loopArea[i] : null;
              const ringFeed = feedForArea(aOvr || area);
              const sweep = 2 * Math.PI - lw / r; // stop one line width short of the start
              let dth = 2 * Math.acos(Math.max(-1, 1 - tol / r));
              if (!isFinite(dth) || dth <= 0) dth = 0.2;
              const steps = Math.max(12, Math.ceil(sweep / dth));
              for (let s = 1; s <= steps; s++) {
                const p = ringPt(i, a + (sweep * s) / steps);
                emitSeg({ x: cx + p.x, y: cy + p.y, z: zi }, ringFeed, 1, aOvr);
              }
              const aEnd = (a + sweep) % (2 * Math.PI);
              if (i < ringN - 1) {
                // radial connector out to the next ring (extruded, length = lw);
                // uses the NEXT ring's own area/feed, since that's the height it travels at.
                const connArea = domed && k > 0 && k !== T - 1 ? loopArea[i + 1] : null;
                const pNext = ringPt(i + 1, aEnd);
                emitSeg(
                  { x: cx + pNext.x, y: cy + pNext.y, z: zRingAt(k, i + 1) },
                  feedForArea(connArea || area),
                  1,
                  connArea
                );
              }
              a = aEnd;
            }
          }
          if (foamOn && (k === 0 || k === T - 2)) {
            const p0 = ringPt(0, a0);
            const dest = { x: cx + p0.x, y: cy + p0.y, z: zRingAt(k + 1, 0) };
            emitFoamTransition(k === 0 ? 'enter' : 'exit', dest);
            afterFoam = true;
          }
        }
      }
    }

    if (includeStartEnd) {
      // Final clearance lift: 5x the tallest point actually printed, so
      // there's real room to finish the part by hand (trim drooping
      // filament/oozing, etc.) rather than the old fixed 5-10mm bump, which
      // wasn't enough headroom above a print of any real height. Floored at
      // the old fixed value so a trivial/near-zero-height job still lifts.
      const endLift = Math.max(5 * maxZEver, mode === 'filament' ? 5 : 10);
      (mode === 'filament' ? marlinEnd(endLift) : klipperEnd(endLift)).forEach((l) => lines.push(l));
    }

    // Estimated print time from the actual path and feeds — the NOMINAL
    // time the F values in the file imply, same as before this existed.
    // actualTimeMin below is the REAL time, correcting for the M220 speed-up
    // during foam-active moves (equal to timeMin whenever foam never
    // activates), same idea as materialVolume vs totalVolume above.
    let timeMin = 0;
    let actualTimeMin = 0;
    for (let i = 1; i < path.length; i++) {
      const d = dist3(path[i - 1], path[i]);
      if (path[i].feed > 0) {
        const dt = d / path[i].feed;
        timeMin += dt;
        actualTimeMin += dt * (path[i].foamZone ? foamCfg.extrusionPct / 100 : 1);
      }
    }

    const stats = {
      volume: totalVolume,
      pathLength: pathLength,
      moves: moveCount,
      loops: T,
      timeMin: timeMin,
      materialVolume: materialVolume,
      actualTimeMin: actualTimeMin,
    };
    return { gcode: lines.join('\n') + '\n', warnings, stats, path };
  }

  window.GcodeGen = {
    generate,
    beadArea,
    discSpec,
    discLoops,
    LEG_ANGLES,
    makeProfile,
    BS_ROTATION_DEG,
    SPOON_ROTATION_DEG,
    LAMP_SOCKETS,
    discBedFit,
    domeHeightRange,
  };
})();
