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
 * Pipeline: adaptive base curve (chord tolerance) -> seam at Y crossing ->
 * continuous spiral with an optional surface pattern.
 *
 * Patterns share: amplitude, zAngle (deg), coverage %, patternless layers
 * top/bottom, bump feedrate. Each point's displacement vector is rotated by
 * zAngle in the vertical plane: lateral = m*cos(zAngle), vertical = m*sin(zAngle).
 *   - 'weave': continuous m = amplitude*cos(PI*(L+u)*bumps). Even bumps = flutes,
 *     odd = woven (phase flips each layer).
 *   - 'spikes': blue-noise (best-candidate) outward pokes; each spike is a
 *     triangle of base width = lineWidth (entry, tip, exit), tip at full
 *     amplitude. Deterministic via seed.
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

    const area = beadArea(cfg.lineWidth, lh);
    const T = cfg.totalHeight / lh; // total loops (may be fractional)
    const Lmax = Math.ceil(T - 1e-9);

    // ---- Pattern setup ----
    const pat = cfg.pattern || {};
    const type = pat.type || 'weave';
    const patternOn =
      !!pat.enabled &&
      pat.amplitude !== 0 &&
      ((type === 'weave' && pat.bumps >= 1) || (type === 'spikes' && pat.count >= 1));
    const cov = patternOn ? Math.max(0, Math.min(100, pat.coverage)) / 100 : 0;
    const gap = 1 - cov;
    const bandLo = gap / 2;
    const bandHi = 1 - gap / 2;
    const zAng = ((pat.zAngle || 0) * Math.PI) / 180;
    const cosA = Math.cos(zAng);
    const sinA = Math.sin(zAng);
    const bumpFeed = pat.bumpFeed > 0 ? pat.bumpFeed : cfg.printFeed;
    const plBottom = patternOn ? pat.plBottom : 0;
    const plTop = patternOn ? pat.plTop : 0;

    function layerPatterned(L) {
      return !(L < plBottom || L >= T - plTop);
    }
    function uInBand(u) {
      if (cov >= 1) return true;
      const uu = u >= 1 ? 0 : u;
      return uu >= bandLo && uu <= bandHi;
    }

    // ---- Header ----
    lines.push('; EasyGCode — vase-mode generator');
    lines.push('; ' + new Date().toISOString());
    lines.push('; shape=' + cfg.shape + ' tolerance=' + cfg.tolerance + 'mm');
    lines.push('; layerHeight=' + lh + ' lineWidth=' + cfg.lineWidth + ' totalHeight=' + cfg.totalHeight);
    if (patternOn) {
      let ln = '; pattern=' + type + ' amplitude=' + pat.amplitude + ' zAngle=' + (pat.zAngle || 0) +
        ' coverage=' + pat.coverage + '% plBottom=' + plBottom + ' plTop=' + plTop + ' bumpFeed=' + Math.round(bumpFeed);
      ln += type === 'weave' ? ' bumps=' + pat.bumps : ' count=' + pat.count + ' seed=' + pat.seed;
      lines.push(ln);
    }
    lines.push('; printFeed=' + cfg.printFeed + ' travelFeed=' + cfg.travelFeed + ' (mm/min)');
    lines.push('; extrusion = relative, volumetric (E in mm^3)');
    lines.push('G90 ; absolute positioning');
    lines.push('M83 ; relative extrusion');

    // ---- Shared emit helpers ----
    let prev = null;
    let prevBump = false;
    let prevU = 0;
    let lastFeed = null;
    let firstExtrude = true;

    function travelAbs(cur) {
      let line = 'G0 X' + f3(cur.x) + ' Y' + f3(cur.y) + ' Z' + f3(cur.z) + ' F' + Math.round(cfg.travelFeed);
      lines.push(line);
      lastFeed = cfg.travelFeed;
      path.push({ x: cur.x, y: cur.y, z: cur.z, travel: true });
      prev = cur;
      moveCount++;
    }

    function emit(cur, curBump, ramp) {
      const segLen = dist3(prev, cur);
      if (segLen < 1e-7) {
        prev = cur;
        prevBump = curBump;
        return;
      }
      const feed = curBump || prevBump ? bumpFeed : cfg.printFeed;
      const dE = area * segLen * ramp;
      totalVolume += dE;
      pathLength += segLen;
      let line = 'G1 X' + f3(cur.x) + ' Y' + f3(cur.y) + ' Z' + f3(cur.z) + ' E' + f5(dE);
      if (feed !== lastFeed || firstExtrude) {
        line += ' F' + Math.round(feed);
        lastFeed = feed;
      }
      lines.push(line);
      path.push({ x: cur.x, y: cur.y, z: cur.z, travel: false });
      firstExtrude = false;
      moveCount++;
      prev = cur;
      prevBump = curBump;
    }

    // Wall point (no displacement) at loop L, fraction u.
    function wallPoint(L, u) {
      const sp = sampler.at(u);
      const baseZ = Math.min(lh * (L + u), cfg.totalHeight);
      return { x: sp.pos.x + cx, y: sp.pos.y + cy, z: baseZ };
    }

    // Brim helpers reuse the simple per-loop emit.
    function extrudeLoop(pts, z, a) {
      let firstMove = true;
      for (let i = 0; i < pts.length; i++) {
        const A = pts[i];
        const B = pts[(i + 1) % pts.length];
        const segLen = Geo.dist(A, B);
        const dE = a * segLen;
        totalVolume += dE;
        pathLength += segLen;
        let line = 'G1 X' + f3(B.x + cx) + ' Y' + f3(B.y + cy) + ' Z' + f3(z) + ' E' + f5(dE);
        if (firstMove || lastFeed !== cfg.printFeed) {
          line += ' F' + Math.round(cfg.printFeed);
          lastFeed = cfg.printFeed;
        }
        lines.push(line);
        path.push({ x: B.x + cx, y: B.y + cy, z: z, travel: false });
        firstMove = false;
        moveCount++;
      }
    }

    // ---- Brim ----
    const brim = cfg.brim;
    if (brim && brim.enabled && brim.lines > 0) {
      const bArea = beadArea(brim.lineWidth, brim.layerHeight);
      const dir = brim.outer ? 1 : -1;
      const centroid = base.reduce((s, p) => ({ x: s.x + p.x, y: s.y + p.y }), { x: 0, y: 0 });
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
        const startAbs = { x: loop[0].x + cx, y: loop[0].y + cy, z: brim.layerHeight };
        travelAbs(startAbs);
        extrudeLoop(loop, brim.layerHeight, bArea);
      }
    }

    // ---- Base u-samples ----
    let uSet = [];
    for (let i = 0; i < base.length; i++) uSet.push(sampler.uOf(i));
    if (patternOn && type === 'weave') for (let j = 0; j < pat.bumps; j++) uSet.push(j / pat.bumps);
    uSet = Array.from(new Set(uSet.map((u) => +u.toFixed(9)))).sort((a, b) => a - b);
    if (uSet.length === 0 || uSet[0] > 1e-9) uSet.unshift(0);

    lines.push('; --- vase spiral' + (patternOn ? ' + ' + type : '') + ' ---');

    // ===================== WEAVE / PLAIN =====================
    if (!(patternOn && type === 'spikes')) {
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

      const startW = wpoint(0, 0);
      travelAbs({ x: startW.p.x, y: startW.p.y, z: 0 });
      prevBump = startW.bump;
      prevU = 0;

      for (let L = 0; L < Lmax; L++) {
        const uEnd = Math.min(1, T - L);
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
    } else {
      // ===================== RANDOM SPIKES =====================
      const hwU = cfg.lineWidth / 2 / perim; // half spike base width, in u
      const zMin = plBottom * lh;
      const zMax = (T - plTop) * lh;
      // Keep spikes clear of the seam/edges so the entry/exit stay in-loop.
      const sLo = Math.max(bandLo, hwU * 1.5) * perim;
      const sHi = Math.min(bandHi, 1 - hwU * 1.5) * perim;
      const byLoop = {};
      let placed = 0;
      if (zMax > zMin && sHi > sLo) {
        const spikes = bestCandidate(pat.count, sLo, sHi, zMin, zMax, (pat.seed | 0) || 1);
        spikes.forEach((sp) => {
          const u = sp.s / perim;
          let L = Math.round(sp.z / lh - u);
          if (L < plBottom) L = plBottom;
          if (L > Lmax - 1) L = Lmax - 1;
          (byLoop[L] = byLoop[L] || []).push(u);
          placed++;
        });
      }
      if (placed < pat.count) {
        warnings.push('Some spikes could not be placed (pattern area too small for the count).');
      }

      const startP = wallPoint(0, 0);
      travelAbs({ x: startP.x, y: startP.y, z: 0 });
      prevBump = false;
      prevU = 0;

      for (let L = 0; L < Lmax; L++) {
        const uEnd = Math.min(1, T - L);
        const events = [];
        for (let i = 0; i < uSet.length; i++) {
          const u = uSet[i];
          if (L > 0 && u <= 1e-9) continue;
          if (u >= uEnd - 1e-9) continue;
          events.push({ u, tip: false });
        }
        const spk = (byLoop[L] || []).filter((u) => u > 1e-6 && u < uEnd - 1e-6);
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
            const nx = sp.tan.y;
            const ny = -sp.tan.x;
            const lat = pat.amplitude * cosA;
            const baseZ = Math.min(lh * (L + e.u), cfg.totalHeight);
            cur = { x: sp.pos.x + nx * lat + cx, y: sp.pos.y + ny * lat + cy, z: baseZ + pat.amplitude * sinA };
            bump = true;
          } else {
            cur = wallPoint(L, e.u);
          }
          const ramp = L === 0 ? Math.max(0, Math.min(1, (prevU + e.u) / 2)) : 1;
          emit(cur, bump, ramp);
          prevU = e.u;
        }
      }
    }

    const stats = { volume: totalVolume, pathLength: pathLength, moves: moveCount, loops: T };
    return { gcode: lines.join('\n') + '\n', warnings, stats, path };
  }

  window.GcodeGen = { generate, beadArea };
})();
