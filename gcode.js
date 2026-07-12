/*
 * gcode.js — vase-mode G-code generation.
 *
 * Conventions (locked with the user):
 *   - Absolute positioning (G90), relative extrusion (M83).
 *   - Volumetric extrusion: every G1 E is the segment volume in mm^3.
 *   - No start/end G-code (heating/homing) — added later.
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

  function marlinEnd() {
    return [
      '; --- end G-code (filament / Marlin) ---',
      'M83',
      'G1 E-0.8 F3000 ; retract',
      'G91 ; relative coordinates',
      'G0 Z5 F8000 ; lift nozzle',
      'G90 ; absolute coordinates',
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

  function klipperEnd() {
    return [
      '; --- end G-code (pellet / Klipper) ---',
      'M83',
      'G91 ; relative coordinates',
      'G0 Z10 F3000 ; lift',
      'G90 ; absolute coordinates',
      'TURN_OFF_HEATERS ; zones + bed off',
      'M106 S0 ; fan off',
      'M84 ; disable steppers',
    ];
  }

  // Angles of the three legs: one pointing left, two right (Mercedes rotated),
  // so the seam at 0 deg (right) sits in the gap between the two right legs.
  const LEG_ANGLES = [Math.PI, Math.PI / 3, -Math.PI / 3];

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
      const Dmax = ((2 * (legs.m - 1) + 1) * at.gap * lw) / 2;
      const T = Math.max(1, Math.round((cfg.disc && cfg.disc.layers) || 1));
      const drop = Math.max(0, Math.min(1, at.drop || 0));
      // Down-slope pull-back: each point slides back along the overhang slope
      // proportionally to how far it moved out, so the slope ANGLE is
      // preserved while the layers pack together (see the z drop in generate).
      const pb = T > 1 ? (drop * Dfull) / (Dmax * (T - 1)) : 0;
      return { points: attrPts, r1: at.r1, r2: at.r2, D: Dfull * scale, pb: pb };
    }

    const loops = [];
    if (alt) {
      let pPrev = 0;
      for (let i = 0; i < n; i++) {
        const del = lw / 2 / spec.radii[i]; // turn around half a line width early
        const pIn = i === 0 ? del : pPrev;
        const cw = i % 2 === 1;
        const pts = Geo.stoolLoop({
          r: spec.radii[i],
          tol: tol,
          aStart: cw ? s0 + del : s0 + pIn,
          gapAng: pIn + del,
          leg: legFor(i),
          attr: attrFor(i),
        });
        if (cw) pts.reverse();
        loops.push(pts);
        pPrev = del;
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

    const area = beadArea(cfg.lineWidth, lh);
    // Vase: loops = height/layerHeight (may be fractional). Disc: stacked layers.
    const T = isBS ? Math.max(1, Math.round((cfg.disc && cfg.disc.layers) || 1)) : cfg.totalHeight / lh;
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
      let dl = null;
      if (legs || altSeam) {
        // Precompute each ring's polyline once (identical every layer).
        dl = discLoops(cfg, spec);
        legLoops = dl.loops;
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
      attrGrad = !!(dl && dl.attrOn && T > 1);
      discSpecMemo = spec;
      if (legs) {
        // Brim base: the outermost combined outline of the BOTTOM layer (the
        // brim hugs what actually prints first — unspread when gradient is on).
        discOuterLoop = attrGrad ? discLoops(cfg, spec, 0).outline : dl.outline;
      } else {
        // Outermost bead centerline circle doubles as the brim's base loop.
        const rOut = ringRadii[ringN - 1];
        const dth0 = 2 * Math.acos(Math.max(-1, 1 - tolBS / rOut));
        const steps0 = Math.max(24, Math.ceil((2 * Math.PI) / (isFinite(dth0) && dth0 > 0 ? dth0 : 0.2)));
        discOuterLoop = [];
        for (let s = 0; s < steps0; s++) {
          const ang = (2 * Math.PI * s) / steps0;
          discOuterLoop.push({ x: rOut * Math.cos(ang), y: rOut * Math.sin(ang) });
        }
      }
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
                ((Math.atan2(stepLat, lh) * 180) / Math.PI).toFixed(1) + ' deg from vertical (preserved), drop=' +
                dropH + ' -> layer spacing squeezed to ' + (lh * (1 - dropH / (T - 1))).toFixed(2) +
                'mm at steepest'
            );
          }
        }
      }
      lines.push('; layerHeight=' + lh + ' lineWidth=' + cfg.lineWidth + ' tolerance=' + cfg.tolerance + 'mm');
    } else {
      lines.push('; shape=' + cfg.shape + ' tolerance=' + cfg.tolerance + 'mm seam=' + (cfg.seamSide || 'back'));
      lines.push('; layerHeight=' + lh + ' lineWidth=' + cfg.lineWidth + ' totalHeight=' + cfg.totalHeight);
    }
    if (patternOn) {
      let ln = '; pattern=' + type + ' amplitude=' + pat.amplitude + ' zAngle=' + (pat.zAngle || 0) +
        ' coverage=' + pat.coverage + '% plBottom=' + plBottom + ' plTop=' + plTop + ' bumpFeed=' + Math.round(bumpFeed);
      ln += type === 'weave' ? ' bumps=' + pat.bumps : ' count=' + pat.count + ' seed=' + pat.seed;
      lines.push(ln);
    }
    if (hangOn) {
      lines.push(
        '; hanger: gap=' + hang.size + '% pocket=' + Math.round(pocketFrac * 100) + '% bottomLoops=' +
          hStart + ' transition=' + hTween + ' bridgeFeed=' + Math.round(hBridgeFeed)
      );
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

    function travelAbs(cur) {
      lines.push('G0 X' + f3(cur.x) + ' Y' + f3(cur.y) + ' Z' + f3(cur.z) + ' F' + Math.round(cfg.travelFeed));
      lastFeed = cfg.travelFeed;
      path.push({ x: cur.x, y: cur.y, z: cur.z, travel: true, feed: cfg.travelFeed });
      prev = cur;
      moveCount++;
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
    }

    // Pattern-aware move (bump segments use the bump feedrate).
    function emit(cur, curBump, ramp) {
      emitSeg(cur, curBump || prevBump ? bumpFeed : cfg.printFeed, ramp);
      prevBump = curBump;
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
      }
    }

    // ---- Brim ----
    const brim = cfg.brim;
    const brimBase = isBS ? discOuterLoop : base;
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
      lines.push('; --- brim (' + (brim.outer ? 'outer' : 'inner') + ') ---');
      for (let k = 1; k <= brim.lines; k++) {
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
        spikes.forEach((sp) => {
          const u = (sp.s / perim + 1) % 1;
          let L = Math.round(sp.z / lh);
          if (L < plBottom) L = plBottom;
          if (L > Lmax - 1) L = Lmax - 1;
          (byLoop[L] = byLoop[L] || []).push(u);
          placed++;
        });
      }
      if (placed < pat.count) {
        warnings.push('Some spikes could not be placed (pattern area too small for the count).');
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
      const events = [];
      for (let i = 0; i < uSet.length; i++) {
        const u = uSet[i];
        if (L > 0 && u <= 1e-9) continue;
        if (u >= uEnd - 1e-9) continue;
        events.push({ u, tip: false });
      }
      const spk = (byLoop[L] || []).filter((u) => u > hwU * 1.2 && u < uEnd - hwU * 1.2);
      spk.forEach((uc) => {
        events.push({ u: uc - hwU, tip: false });
        events.push({ u: uc, tip: true });
        events.push({ u: uc + hwU, tip: false });
      });
      events.sort((a, b) => a.u - b.u);
      events.push({ u: uEnd, tip: false });
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        let cur;
        let bump = false;
        if (e.tip) {
          const sp = sampler.at(e.u);
          const lat = pat.amplitude * cosA;
          const baseZ = Math.min(lh * (L + e.u), cfg.totalHeight);
          cur = {
            x: sp.pos.x + sp.tan.y * lat + cx,
            y: sp.pos.y - sp.tan.x * lat + cy,
            z: baseZ + pat.amplitude * sinA,
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

      const events = [];
      for (let i = 1; i < n1; i++) events.push({ f: cum[i] / total });
      if (spikesMode) {
        const hwF = cfg.lineWidth / 2 / total;
        const spk = (byLoop[L] || []).filter((u) => u > hwF * 1.2 && u < uEnd - hwF * 1.2);
        spk.forEach((uc) => {
          events.push({ f: uc - hwF });
          events.push({ f: uc, tip: true });
          events.push({ f: uc + hwF });
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
        };
      }

      prevBump = false;
      let prevSpecial = false;
      let prevNew = false;
      for (let i = 0; i <= events.length; i++) {
        const endCut = i === events.length || events[i].f >= uEnd - 1e-12;
        const e = endCut ? { f: uEnd } : events[i];
        const q = atF(e.f);
        let m = 0;
        if (!e.tip && patternOn && type === 'weave' && layerPatterned(L) && uInBand(e.f)) {
          m = pat.amplitude * Math.cos(Math.PI * (L + e.f) * pat.bumps);
        }
        const amp = e.tip ? pat.amplitude : m;
        const lat = amp * cosA;
        const z = Math.min(lh * (L + e.f), cfg.totalHeight) + amp * sinA;
        const special = !!e.tip || m !== 0;
        let feed = cfg.printFeed;
        if (bridge && (q.isNew || prevNew)) feed = hBridgeFeed;
        else if (special || prevSpecial) feed = bumpFeed;
        emitSeg({ x: q.x + q.ty * lat + cx, y: q.y - q.tx * lat + cy, z: z }, feed, 1);
        prevSpecial = special;
        prevNew = q.isNew;
        if (endCut) break;
      }
    }

    // ---- Body ----
    if (!isBS) {
      lines.push(
        '; --- vase spiral' + (patternOn ? ' + ' + type : '') + (hangOn ? ' + hanger' : '') + ' ---'
      );

      const start = spikesMode ? wallPoint(0, 0) : wpoint(0, 0).p;
      travelAbs({ x: start.x, y: start.y, z: 0 });
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
            polyLoop(L, tweenLoopPts(L - hStart), false, uEnd);
          }
        } else if (spikesMode) {
          spikesLoop(L, uEnd);
        } else {
          weaveLoop(L, uEnd);
        }
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
        lines.push(
          '; dome: center x' + dm + ' (' + (dm * lh).toFixed(2) + 'mm/layer) -> edge ' + lh +
            'mm/layer; top z ' + (lh + (T - 1) * dm * lh).toFixed(2) + ' center vs ' +
            (T * lh).toFixed(2) + ' edge'
        );
      }
      if (legLoops) {
        // Chained precomputed loops: each loop starts at the previous loop's
        // end angle, so the first point of loop i+1 IS the radial connector.
        // With the spread gradient, each layer gets its own loop set scaled
        // k/(T-1): collected at the bottom, fully spread at the top.
        //
        // Overhang drop (nonplanar, slope-following): each point slides DOWN
        // the overhang slope proportionally to how far it moved out — shift
        // (in layer steps) = drop * w / Dmax, at most one step. The lateral
        // part of the slide is applied during construction (attr.pb); here the
        // vertical part: z = (k+1)*lh - drop*lh*(w/Dmax). At drop=1 the most-
        // displaced point lands exactly on the layer below's original spot;
        // the slope angle is preserved while the layers pack together.
        const at3 = cfg.disc.attractor || {};
        const dropMult = attrGrad ? Math.max(0, Math.min(1, at3.drop || 0)) : 0;
        const DmaxA = legs ? ((2 * (legs.m - 1) + 1) * (at3.gap || 1) * lw) / 2 : 0;
        const dropCoef = dropMult > 0 && DmaxA > 0 ? (dropMult * lh) / DmaxA : 0;
        for (let k = 0; k < T; k++) {
          const z = (k + 1) * lh;
          if (k === 1 && includeStartEnd && fanPWM > 0) {
            lines.push('M106 S' + fanPWM + ' ; part cooling fan on after first layer');
          }
          const loopsK = attrGrad
            ? k === T - 1
              ? legLoops
              : discLoops(cfg, discSpecMemo, k / (T - 1)).loops
            : legLoops;
          const zPt = (i, pt) => {
            const zb = domed && k > 0 ? lh + k * loopH[i] : z;
            if (!dropCoef) return zb;
            const dc = domed ? (dropMult * loopH[i]) / DmaxA : dropCoef;
            return Math.max(lh, zb - dc * (pt.w || 0));
          };
          travelAbs({ x: cx + loopsK[0][0].x, y: cy + loopsK[0][0].y, z: zPt(0, loopsK[0][0]) });
          for (let i = 0; i < ringN; i++) {
            const lp = loopsK[i];
            const aOvr = domed && k > 0 ? loopArea[i] : null;
            for (let q = i === 0 ? 1 : 0; q < lp.length; q++) {
              emitSeg({ x: cx + lp[q].x, y: cy + lp[q].y, z: zPt(i, lp[q]) }, cfg.printFeed, 1, aOvr);
            }
          }
        }
      } else {
        const a0 = Math.PI / 2;
        for (let k = 0; k < T; k++) {
          const z = (k + 1) * lh;
          if (k === 1 && includeStartEnd && fanPWM > 0) {
            lines.push('M106 S' + fanPWM + ' ; part cooling fan on after first layer');
          }
          let a = a0;
          const zRing = (i) => (domed && k > 0 ? lh + k * loopH[i] : z);
          travelAbs({ x: cx + ringRadii[0] * Math.cos(a), y: cy + ringRadii[0] * Math.sin(a), z: zRing(0) });
          for (let i = 0; i < ringN; i++) {
            const r = ringRadii[i];
            const zi = zRing(i);
            const aOvr = domed && k > 0 ? loopArea[i] : null;
            const sweep = 2 * Math.PI - lw / r; // stop one line width short of the start
            let dth = 2 * Math.acos(Math.max(-1, 1 - tol / r));
            if (!isFinite(dth) || dth <= 0) dth = 0.2;
            const steps = Math.max(12, Math.ceil(sweep / dth));
            for (let s = 1; s <= steps; s++) {
              const ang = a + (sweep * s) / steps;
              emitSeg({ x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang), z: zi }, cfg.printFeed, 1, aOvr);
            }
            const aEnd = (a + sweep) % (2 * Math.PI);
            if (i < ringN - 1) {
              // radial connector out to the next ring (extruded, length = lw)
              emitSeg(
                { x: cx + ringRadii[i + 1] * Math.cos(aEnd), y: cy + ringRadii[i + 1] * Math.sin(aEnd), z: zRing(i + 1) },
                cfg.printFeed,
                1,
                domed && k > 0 ? loopArea[i + 1] : null
              );
            }
            a = aEnd;
          }
        }
      }
    }

    if (includeStartEnd) {
      (mode === 'filament' ? marlinEnd() : klipperEnd()).forEach((l) => lines.push(l));
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

  window.GcodeGen = { generate, beadArea, discSpec, discLoops, LEG_ANGLES };
})();
