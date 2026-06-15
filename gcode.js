/*
 * gcode.js — vase-mode G-code generation.
 *
 * Conventions (locked with the user):
 *   - Absolute positioning (G90), relative extrusion (M83).
 *   - Extrusion is VOLUMETRIC: every G1 E value is the volume of that segment in
 *     cubic millimeters (the Klipper config converts volumetric flow downstream).
 *   - No start/end G-code (heating/homing) — added later.
 *
 * Bead cross-section is a "stadium" (rectangle + a half-circle on each end):
 *     beadArea(w, h) = (w - h) * h + PI * (h/2)^2
 *
 * Pipeline:
 *   1. Build the base curve adaptively to a chord tolerance (geometry only).
 *   2. Rotate it so the seam sits at the Y-axis crossing.
 *   3. Trace a continuous spiral. The emitted points per loop are the union of
 *      the base-curve vertices (shape fidelity) and the bump positions
 *      (j / bumps of a revolution). Each point is displaced sideways along
 *      (tangent x Z) by  amplitude * cos(PI * (L + u) * bumps), giving a weave
 *      whose layer phase is controlled by the parity of `bumps`.
 *
 * Exposed on window.GcodeGen.
 */
(function () {
  'use strict';

  const Geo = window.Geo;

  function beadArea(w, h) {
    const ww = Math.max(w, h); // clamp: width can't be narrower than height
    return (ww - h) * h + Math.PI * (h / 2) * (h / 2);
  }

  const f3 = (v) => v.toFixed(3);
  const f5 = (v) => v.toFixed(5);
  const dist3 = (a, b) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

  // cfg fields:
  //   shape, shapeParams, tolerance, seamSide ('back'|'front')
  //   layerHeight, lineWidth, totalHeight, printFeed, travelFeed (mm/min)
  //   centerX, centerY
  //   brim: { enabled, outer, lines, lineWidth, layerHeight }
  //   pattern: { enabled, amplitude, bumps, coverage (%), plBottom, plTop }
  function generate(cfg) {
    const warnings = [];
    const lines = [];
    const path = []; // {x, y, z, travel} for the 3D preview
    let totalVolume = 0;
    let pathLength = 0;
    let moveCount = 0;

    const cx = cfg.centerX;
    const cy = cfg.centerY;

    if (cfg.lineWidth < cfg.layerHeight) {
      warnings.push('Line width is less than layer height — bead width clamped to layer height.');
    }

    // Adaptive base curve, seam at the Y-axis crossing.
    let base = Geo.adaptiveShape(cfg.shape, cfg.shapeParams, cfg.tolerance);
    base = Geo.rotateToSeam(base, cfg.seamSide || 'back');
    const sampler = Geo.makeSampler(base);
    const perim = sampler.perimeter;

    if (!(perim > 1e-6) || !Number.isFinite(perim)) {
      return {
        gcode: '; ERROR: shape has zero size',
        warnings: ['Shape has zero size — check your dimensions.'],
        stats: { volume: 0, pathLength: 0, moves: 0, loops: 0 },
        path: [],
      };
    }

    // ---- Header ----
    lines.push('; EasyGCode — vase-mode generator');
    lines.push('; ' + new Date().toISOString());
    lines.push('; shape=' + cfg.shape + ' tolerance=' + cfg.tolerance + 'mm');
    lines.push(
      '; layerHeight=' + cfg.layerHeight + ' lineWidth=' + cfg.lineWidth +
        ' totalHeight=' + cfg.totalHeight
    );
    if (cfg.pattern && cfg.pattern.enabled) {
      lines.push(
        '; pattern: amplitude=' + cfg.pattern.amplitude + ' bumps=' + cfg.pattern.bumps +
          ' coverage=' + cfg.pattern.coverage + '% plBottom=' + cfg.pattern.plBottom +
          ' plTop=' + cfg.pattern.plTop
      );
    }
    lines.push('; printFeed=' + cfg.printFeed + ' travelFeed=' + cfg.travelFeed + ' (mm/min)');
    lines.push('; extrusion = relative, volumetric (E in mm^3)');
    lines.push('G90 ; absolute positioning');
    lines.push('M83 ; relative extrusion');

    function travelTo(p, z) {
      lines.push('G0 X' + f3(p.x + cx) + ' Y' + f3(p.y + cy) + ' Z' + f3(z) + ' F' + Math.round(cfg.travelFeed));
      path.push({ x: p.x + cx, y: p.y + cy, z: z, travel: true });
      moveCount++;
    }

    // Extrude one closed loop at a fixed Z (brim only — no pattern).
    function extrudeLoop(pts, z, area) {
      let firstMove = true;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        const segLen = Geo.dist(a, b);
        const dE = area * segLen;
        totalVolume += dE;
        pathLength += segLen;
        lines.push(
          'G1 X' + f3(b.x + cx) + ' Y' + f3(b.y + cy) + ' Z' + f3(z) + ' E' + f5(dE) +
            (firstMove ? ' F' + Math.round(cfg.printFeed) : '')
        );
        path.push({ x: b.x + cx, y: b.y + cy, z: z, travel: false });
        firstMove = false;
        moveCount++;
      }
    }

    // ---- Brim ----
    const brim = cfg.brim;
    if (brim && brim.enabled && brim.lines > 0) {
      const bArea = beadArea(brim.lineWidth, brim.layerHeight);
      const dir = brim.outer ? 1 : -1;
      const centroid = base.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
      centroid.x /= base.length;
      centroid.y /= base.length;
      const inradius = base.reduce((m, p) => Math.min(m, Geo.dist(p, centroid)), Infinity);

      lines.push('; --- brim (' + (brim.outer ? 'outer' : 'inner') + ') ---');
      for (let k = 1; k <= brim.lines; k++) {
        const d = brim.lineWidth / 2 + cfg.lineWidth / 2 + (k - 1) * brim.lineWidth;
        if (!brim.outer && d >= inradius) {
          warnings.push('Inner brim line ' + k + ' skipped (offset exceeds shape size).');
          continue;
        }
        const loop = Geo.offsetClosed(base, dir * d);
        if (!brim.outer && Geo.signedArea(loop) <= 1e-3) {
          warnings.push('Inner brim line ' + k + ' skipped (collapsed).');
          continue;
        }
        travelTo(loop[0], brim.layerHeight);
        extrudeLoop(loop, brim.layerHeight, bArea);
      }
    }

    // ---- Pattern setup ----
    const pat = cfg.pattern || {};
    const patternOn = !!pat.enabled && pat.amplitude !== 0 && pat.bumps >= 1;
    const T = cfg.totalHeight / cfg.layerHeight; // total loops (may be fractional)
    const cov = patternOn ? Math.max(0, Math.min(100, pat.coverage)) / 100 : 0;
    const gap = 1 - cov; // plain fraction, centered on the seam (u = 0)
    const bandLo = gap / 2;
    const bandHi = 1 - gap / 2;

    function disp(L, u) {
      if (!patternOn) return 0;
      if (L < pat.plBottom) return 0; // patternless bottom layers
      if (L >= T - pat.plTop) return 0; // patternless top layers
      if (cov < 1) {
        const uu = u >= 1 ? 0 : u; // u=1 maps to the seam
        if (uu < bandLo || uu > bandHi) return 0;
      }
      return pat.amplitude * Math.cos(Math.PI * (L + u) * pat.bumps);
    }

    // Position (with bed offset) of the toolpath at loop L, fraction u.
    function point(L, u) {
      const sp = sampler.at(u);
      const nx = sp.tan.y; // horizontal normal = tangent x Z
      const ny = -sp.tan.x;
      const d = disp(L, u);
      let z = cfg.layerHeight * (L + u);
      if (z > cfg.totalHeight) z = cfg.totalHeight;
      return { x: sp.pos.x + nx * d + cx, y: sp.pos.y + ny * d + cy, z: z };
    }

    // ---- Build the per-loop list of u samples (base vertices + bump positions) ----
    let uSet = [];
    for (let i = 0; i < base.length; i++) uSet.push(sampler.uOf(i));
    if (patternOn) for (let j = 0; j < pat.bumps; j++) uSet.push(j / pat.bumps);
    uSet = Array.from(new Set(uSet.map((u) => +u.toFixed(9)))).sort((a, b) => a - b);
    if (uSet.length === 0 || uSet[0] > 1e-9) uSet.unshift(0);

    // ---- Spiral with ramp-up first turn ----
    lines.push('; --- vase spiral ---');
    const area = beadArea(cfg.lineWidth, cfg.layerHeight);
    const Lmax = Math.ceil(T - 1e-9);

    let prev = point(0, 0);
    travelTo({ x: prev.x - cx, y: prev.y - cy }, prev.z);
    let prevL = 0;
    let prevU = 0;
    let firstExtrude = true;

    function emitMove(L, u) {
      const cur = point(L, u);
      const segLen = dist3(prev, cur);
      if (segLen < 1e-7) {
        prev = cur; prevL = L; prevU = u;
        return;
      }
      // Ramp 0 -> 100% extrusion across the first loop only.
      let ramp = 1;
      if (prevL === 0 && L === 0) {
        ramp = (prevU + u) / 2;
        if (ramp > 1) ramp = 1;
        if (ramp < 0) ramp = 0;
      }
      const dE = area * segLen * ramp;
      totalVolume += dE;
      pathLength += segLen;
      lines.push(
        'G1 X' + f3(cur.x) + ' Y' + f3(cur.y) + ' Z' + f3(cur.z) + ' E' + f5(dE) +
          (firstExtrude ? ' F' + Math.round(cfg.printFeed) : '')
      );
      path.push({ x: cur.x, y: cur.y, z: cur.z, travel: false });
      firstExtrude = false;
      moveCount++;
      prev = cur; prevL = L; prevU = u;
    }

    for (let L = 0; L < Lmax; L++) {
      const uEnd = Math.min(1, T - L);
      for (let k = 0; k < uSet.length; k++) {
        const u = uSet[k];
        if (L > 0 && u <= 1e-9) continue; // skip duplicate loop-start
        if (u >= uEnd - 1e-9) continue; // loop end handled below
        emitMove(L, u);
      }
      emitMove(L, uEnd); // close the loop / hit the exact height
    }

    const stats = { volume: totalVolume, pathLength: pathLength, moves: moveCount, loops: T };
    return { gcode: lines.join('\n') + '\n', warnings, stats, path };
  }

  window.GcodeGen = { generate, beadArea };
})();
