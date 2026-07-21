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

  // Rotated + bed-centered bounding box of a bend-stool outline (disc-centered
  // input points). Shared by generate() and the 2D preview so both agree on
  // exactly the same numbers. Returns the box size and the shift that recenters
  // it on (centerX, centerY) — apply as: rotate(p) + {shiftX, shiftY} + {centerX, centerY}.
  function discBedFit(outline, centerX, centerY) {
    const rotRad = (BS_ROTATION_DEG * Math.PI) / 180;
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

  function generate(cfg) {
    const warnings = [];
    const lines = [];
    const path = [];
    let totalVolume = 0;
    let pathLength = 0;
    let moveCount = 0;

    const cx = cfg.centerX;
    const cy = cfg.centerY;
    const lh = cfg.layerHeight;

    if (cfg.lineWidth < lh) {
      warnings.push('Line width is less than layer height — bead width clamped to layer height.');
    }

    const isBS = cfg.project === 'bendstool';
    const isVessel = cfg.project === 'vessel';

    let base = null;
    let sampler = null;
    let perim = 0;
    if (!isBS) {
      base = Geo.adaptiveShape(cfg.shape, cfg.shapeParams, cfg.tolerance);
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
      ((type === 'weave' && pat.bumps >= 1) || (type === 'spikes' && pat.count >= 1));
    const cov = patternOn ? Math.max(0, Math.min(100, pat.coverage)) / 100 : 0;
    const zAng = ((pat.zAngle || 0) * Math.PI) / 180;
    const cosA = Math.cos(zAng);
    const sinA = Math.sin(zAng);
    const bumpFeed = pat.bumpFeed > 0 ? pat.bumpFeed : cfg.printFeed;
    const plBottom = patternOn ? pat.plBottom : 0;
    const plTop = patternOn ? pat.plTop : 0;

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
    const hangFrac = Math.max(0, Math.min(45, hang.size || 0)) / 100;
    const pocketFrac =
      Math.max(0, Math.min(45, hang.pocket != null && hang.pocket > 0 ? hang.pocket : hang.size || 0)) / 100;
    let hangOn = !isBS && !!hang.enabled && hangFrac > 0.005 && pocketFrac > 0.005;
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
    if (hangOn && pocketFrac >= hangFrac) {
      warnings.push('Insert pocket % is not smaller than the gap % — the beziers get no room. Consider a smaller pocket.');
    }
    const inBand = (L) => hangOn && L >= hStart && L <= hStart + hTween;

    let hangerPts = null;
    let baseRes = null;
    let hangRes = null;
    const TWEEN_N = 400;
    if (hangOn) {
      hangerPts = Geo.buildHangerLoop(base, hangFrac, pocketFrac, cfg.lineWidth);
      hangRes = Geo.resampleClosed(hangerPts.slice(0, -1), TWEEN_N);
      baseRes = Geo.resampleClosed(base, TWEEN_N);
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
      lines.push('; layerHeight=' + lh + ' lineWidth=' + cfg.lineWidth + ' totalHeight=' + cfg.totalHeight);
    }
    if (patternOn) {
      let ln = '; pattern=' + type + ' amplitude=' + pat.amplitude + ' zAngle=' + (pat.zAngle || 0) +
        ' coverage=' + pat.coverage + '% plBottom=' + plBottom + ' plTop=' + plTop + ' bumpFeed=' + Math.round(bumpFeed);
      ln +=
        type === 'weave'
          ? ' bumps=' + pat.bumps
          : ' count=' + pat.count + ' seed=' + pat.seed +
            (pat.spikeVar > 0 ? ' lengthVar=+/-' + pat.spikeVar + 'mm' : '');
      lines.push(ln);
    }
    if (hangOn) {
      lines.push(
        '; hanger: gap=' + hang.size + '% pocket=' + Math.round(pocketFrac * 100) + '% bottomLoops=' +
          hStart + ' transition=' + hTween + ' bridgeFeed=' + Math.round(hBridgeFeed)
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
      path.push({ x: cur.x, y: cur.y, z: cur.z, travel: true, feed: cfg.travelFeed });
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

    // Pattern-aware move (bump segments use the bump feedrate).
    function emit(cur, curBump, ramp) {
      emitSeg(cur, curBump || prevBump ? bumpFeed : cfg.printFeed, ramp);
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

    // ---- Brim ----
    const brim = cfg.brim;
    const brimBase = isBS ? discOuterLoop : isVessel ? vBase : base;
    if (isBS && brim && brim.enabled && !brim.outer) {
      warnings.push('Inner brim skipped — the disc is solid there; use an outer brim.');
    }
    if (brim && brim.enabled && brim.lines > 0 && brimBase && !(isBS && !brim.outer)) {
      const bArea = beadArea(brim.lineWidth, brim.layerHeight);
      const brimFeed = brim.feed > 0 ? brim.feed : cfg.printFeed;
      const dir = brim.outer ? 1 : -1;
      const centroid = brimBase.reduce((s, p) => ({ x: s.x + p.x, y: s.y + p.y }), { x: 0, y: 0 });
      centroid.x /= brimBase.length;
      centroid.y /= brimBase.length;
      const inradius = brimBase.reduce((m, p) => Math.min(m, Geo.dist(p, centroid)), Infinity);
      lines.push(
        '; --- brim (' + (brim.outer ? 'outer' : 'inner') + ', ' + (brim.outIn ? 'out->in' : 'in->out') + ') ---'
      );
      const kOrder = [];
      for (let k = 1; k <= brim.lines; k++) kOrder.push(k);
      if (brim.outIn) kOrder.reverse();
      for (const k of kOrder) {
        const d = brim.lineWidth / 2 + cfg.lineWidth / 2 + (k - 1) * brim.lineWidth;
        if (!brim.outer && d >= inradius) {
          warnings.push('Inner brim line ' + k + ' skipped (offset exceeds shape size).');
          continue;
        }
        const loop = Geo.offsetClosed(brimBase, dir * d);
        if (!brim.outer && Geo.signedArea(loop) <= 1e-3) {
          warnings.push('Inner brim line ' + k + ' skipped (collapsed).');
          continue;
        }
        travelAbs({ x: loop[0].x + cx, y: loop[0].y + cy, z: brim.layerHeight });
        extrudeLoop(loop, brim.layerHeight, bArea, brimFeed);
        brimPrinted = true;
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
        const spikes = bestCandidate(pat.count, -oMax, oMax, zMin, zMax, (pat.seed | 0) || 1);
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
      if (placed < pat.count) {
        warnings.push('Some spikes could not be placed (pattern area too small for the count).');
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
      const nx = sp.tan.y;
      const ny = -sp.tan.x;
      const m = weaveMag(L, u);
      const lat = m * cosA;
      const baseZ = Math.min(lh * (L + u), cfg.totalHeight);
      return { p: { x: sp.pos.x + nx * lat + cx, y: sp.pos.y + ny * lat + cy, z: baseZ + m * sinA }, bump: m !== 0 };
    }

    function weaveLoop(L, uEnd) {
      const step = (u) => {
        const w = wpoint(L, u);
        const ramp = L === 0 ? Math.max(0, Math.min(1, (prevU + u) / 2)) : 1;
        emit(w.p, w.bump, ramp);
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
      // Drop base-curve vertices inside a spike window so each spike is a clean
      // base -> tip -> base triangle exactly one line width wide (no wall vertex
      // wedged between the base and the tip narrowing it).
      if (spk.length) {
        events = events.filter((e) => !spk.some((s) => e.u > s.u - hwU + 1e-9 && e.u < s.u + hwU - 1e-9));
      }
      spk.forEach((s) => {
        events.push({ u: s.u - hwU, tip: false });
        events.push({ u: s.u, tip: true, amp: s.amp });
        events.push({ u: s.u + hwU, tip: false });
      });
      events.sort((a, b) => a.u - b.u);
      events.push({ u: uEnd, tip: false });
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        let cur;
        let bump = false;
        if (e.tip) {
          const sp = sampler.at(e.u);
          const amp = e.amp != null ? e.amp : pat.amplitude;
          const lat = amp * cosA;
          const baseZ = Math.min(lh * (L + e.u), cfg.totalHeight);
          cur = {
            x: sp.pos.x + sp.tan.y * lat + cx,
            y: sp.pos.y - sp.tan.x * lat + cy,
            z: baseZ + amp * sinA,
          };
          bump = true;
        } else {
          cur = wallPoint(L, e.u);
        }
        const ramp = L === 0 ? Math.max(0, Math.min(1, (prevU + e.u) / 2)) : 1;
        emit(cur, bump, ramp);
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
        // that fall inside a spike window, so each spike prints as a clean
        // base -> tip -> base triangle exactly one line width wide instead of a
        // needle wedged between dense wall points.
        if (spk.length) {
          events = events.filter((e) => !spk.some((s) => e.f > s.u - hwF + 1e-9 && e.f < s.u + hwF - 1e-9));
        }
        spk.forEach((s) => {
          events.push({ f: s.u - hwF });
          events.push({ f: s.u, tip: true, amp: s.amp });
          events.push({ f: s.u + hwF });
        });
        events.sort((a, b) => a.f - b.f);
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
      let prevSpecial = false;
      let prevNew = false;
      let prevHot = false;
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
        const special = !!e.tip || m !== 0;
        let feed = cfg.printFeed;
        if (bridge && (q.isNew || prevNew)) feed = hBridgeFeed;
        else if (hOverhangOn && (q.hot || prevHot)) feed = hOverhangFeed;
        else if (special || prevSpecial) feed = bumpFeed;
        emitSeg({ x: q.x + q.ty * lat + cx, y: q.y - q.tx * lat + cy, z: z }, feed, 1);
        prevSpecial = special;
        prevNew = q.isNew;
        prevHot = q.hot;
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

      const innerBase = Geo.offsetClosed(vBase, -cfg.lineWidth);
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
        if (L === 1 && includeStartEnd && fanPWM > 0) {
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

    // Estimated print time from the actual path and feeds.
    let timeMin = 0;
    for (let i = 1; i < path.length; i++) {
      const d = dist3(path[i - 1], path[i]);
      if (path[i].feed > 0) timeMin += d / path[i].feed;
    }

    const stats = { volume: totalVolume, pathLength: pathLength, moves: moveCount, loops: T, timeMin: timeMin };
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
    discBedFit,
    domeHeightRange,
  };
})();
