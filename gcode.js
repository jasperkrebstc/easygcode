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

  // cfg fields:
  //   shape, shapeParams
  //   layerHeight, lineWidth, totalHeight
  //   printFeed, travelFeed (mm/min)
  //   points, centerX, centerY
  //   brim: { enabled, outer, lines, lineWidth, layerHeight }
  function generate(cfg) {
    const warnings = [];
    const lines = [];
    let totalVolume = 0; // mm^3
    let pathLength = 0; // mm of extruding moves
    let moveCount = 0;

    const cx = cfg.centerX;
    const cy = cfg.centerY;

    if (cfg.lineWidth < cfg.layerHeight) {
      warnings.push(
        'Line width is less than layer height — bead width clamped to layer height.'
      );
    }

    // Base outline, resampled evenly by arc length.
    const dense = Geo.makeShape(cfg.shape, cfg.shapeParams);
    const base = Geo.resampleClosed(dense, cfg.points);
    const perim = Geo.perimeter(base);

    // Centroid + inradius (nearest wall distance) — used to detect inner brim
    // offsets that would collapse through the middle of the shape.
    const centroid = base.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
    centroid.x /= base.length;
    centroid.y /= base.length;
    const inradius = base.reduce((m, p) => Math.min(m, Geo.dist(p, centroid)), Infinity);

    if (perim < 1e-6) {
      return {
        gcode: '; ERROR: shape has zero size',
        warnings: ['Shape has zero size — check your dimensions.'],
        stats: { volume: 0, pathLength: 0, moves: 0, loops: 0 },
      };
    }

    // ---- Header ----
    lines.push('; EasyGCode — vase-mode generator');
    lines.push('; ' + new Date().toISOString());
    lines.push('; shape=' + cfg.shape);
    lines.push(
      '; layerHeight=' +
        cfg.layerHeight +
        ' lineWidth=' +
        cfg.lineWidth +
        ' totalHeight=' +
        cfg.totalHeight
    );
    lines.push(
      '; printFeed=' + cfg.printFeed + ' travelFeed=' + cfg.travelFeed + ' (mm/min)'
    );
    lines.push('; extrusion = relative, volumetric (E in mm^3)');
    lines.push('G90 ; absolute positioning');
    lines.push('M83 ; relative extrusion');

    function travelTo(p, z, feedTag) {
      lines.push(
        'G0 X' +
          f3(p.x + cx) +
          ' Y' +
          f3(p.y + cy) +
          ' Z' +
          f3(z) +
          (feedTag ? ' F' + Math.round(cfg.travelFeed) : '')
      );
      moveCount++;
    }

    // Extrude one closed loop at a fixed Z (used for the brim).
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
          'G1 X' +
            f3(b.x + cx) +
            ' Y' +
            f3(b.y + cy) +
            ' Z' +
            f3(z) +
            ' E' +
            f5(dE) +
            (firstMove ? ' F' + Math.round(cfg.printFeed) : '')
        );
        firstMove = false;
        moveCount++;
      }
    }

    // ---- Brim ----
    const brim = cfg.brim;
    if (brim && brim.enabled && brim.lines > 0) {
      const bArea = beadArea(brim.lineWidth, brim.layerHeight);
      const dir = brim.outer ? 1 : -1;
      lines.push('; --- brim (' + (brim.outer ? 'outer' : 'inner') + ') ---');
      for (let k = 1; k <= brim.lines; k++) {
        const d = brim.lineWidth / 2 + cfg.lineWidth / 2 + (k - 1) * brim.lineWidth;
        // Guard against inner offsets that collapse through the center.
        if (!brim.outer && d >= inradius) {
          warnings.push(
            'Inner brim line ' + k + ' skipped (offset exceeds shape size).'
          );
          continue;
        }
        const loop = Geo.offsetClosed(base, dir * d);
        if (!brim.outer && Geo.signedArea(loop) <= 1e-3) {
          warnings.push('Inner brim line ' + k + ' skipped (collapsed).');
          continue;
        }
        travelTo(loop[0], brim.layerHeight, true);
        extrudeLoop(loop, brim.layerHeight, bArea);
      }
    }

    // ---- Base spiral with ramp-up first turn ----
    lines.push('; --- vase spiral ---');
    const area = beadArea(cfg.lineWidth, cfg.layerHeight);
    travelTo(base[0], 0, true);

    const n = base.length;
    let i = 0;
    let z = 0;
    let s = 0; // cumulative arc length traveled in the spiral
    let cur = base[0];
    let firstExtrude = true;
    const maxSegments = Math.ceil(cfg.totalHeight / cfg.layerHeight) * n + n + 10;
    let guard = 0;

    while (z < cfg.totalHeight - 1e-9 && guard < maxSegments) {
      const next = base[(i + 1) % n];
      const segLen = Geo.dist(cur, next);
      // Z climbs continuously; layerHeight per full perimeter.
      let dz = cfg.layerHeight * (segLen / perim);
      let zEnd = z + dz;
      if (zEnd > cfg.totalHeight) zEnd = cfg.totalHeight;

      // Ramp extrusion 0 -> 100% across the first full loop (by arc length).
      const midS = s + segLen / 2;
      let ramp = midS / perim;
      if (ramp > 1) ramp = 1;
      if (ramp < 0) ramp = 0;

      const dE = area * segLen * ramp;
      totalVolume += dE;
      pathLength += segLen;

      lines.push(
        'G1 X' +
          f3(next.x + cx) +
          ' Y' +
          f3(next.y + cy) +
          ' Z' +
          f3(zEnd) +
          ' E' +
          f5(dE) +
          (firstExtrude ? ' F' + Math.round(cfg.printFeed) : '')
      );
      firstExtrude = false;
      moveCount++;

      s += segLen;
      z = zEnd;
      cur = next;
      i = (i + 1) % n;
      guard++;
    }

    const stats = {
      volume: totalVolume,
      pathLength: pathLength,
      moves: moveCount,
      loops: cfg.totalHeight / cfg.layerHeight,
    };

    return { gcode: lines.join('\n') + '\n', warnings, stats };
  }

  window.GcodeGen = { generate, beadArea };
})();
