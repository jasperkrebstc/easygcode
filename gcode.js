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
        stats: { volume: 0, pathLength: 0, moves: 0, loops: 0, timeMin: 0 },
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
    let hangOn = !!hang.enabled && hangFrac > 0.005 && pocketFrac > 0.005;
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
    lines.push('; EasyGCode — vase-mode generator');
    lines.push('; ' + new Date().toISOString());
    lines.push('; shape=' + cfg.shape + ' tolerance=' + cfg.tolerance + 'mm seam=' + (cfg.seamSide || 'back'));
    lines.push('; layerHeight=' + lh + ' lineWidth=' + cfg.lineWidth + ' totalHeight=' + cfg.totalHeight);
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
      lines.push('G0 X' + f3(cur.x) + ' Y' + f3(cur.y) + ' Z' + f3(cur.z) + ' F' + Math.round(cfg.travelFeed));
      lastFeed = cfg.travelFeed;
      path.push({ x: cur.x, y: cur.y, z: cur.z, travel: true, feed: cfg.travelFeed });
      prev = cur;
      moveCount++;
    }

    // Core extruding move at an explicit feedrate.
    function emitSeg(cur, feed, ramp) {
      const segLen = dist3(prev, cur);
      if (segLen < 1e-7) {
        prev = cur;
        return;
      }
      const dE = area * segLen * ramp;
      totalVolume += dE;
      pathLength += segLen;
      let line = 'G1 X' + f3(cur.x) + ' Y' + f3(cur.y) + ' Z' + f3(cur.z) + ' E' + f5(dE);
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
        const dE = a * segLen;
        totalVolume += dE;
        pathLength += segLen;
        let line = 'G1 X' + f3(B.x + cx) + ' Y' + f3(B.y + cy) + ' Z' + f3(z) + ' E' + f5(dE);
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
    if (brim && brim.enabled && brim.lines > 0) {
      const bArea = beadArea(brim.lineWidth, brim.layerHeight);
      const brimFeed = brim.feed > 0 ? brim.feed : cfg.printFeed;
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
        travelAbs({ x: loop[0].x + cx, y: loop[0].y + cy, z: brim.layerHeight });
        extrudeLoop(loop, brim.layerHeight, bArea, brimFeed);
      }
    }

    // ---- Base u-samples ----
    let uSet = [];
    for (let i = 0; i < base.length; i++) uSet.push(sampler.uOf(i));
    if (patternOn && type === 'weave') for (let j = 0; j < pat.bumps; j++) uSet.push(j / pat.bumps);
    uSet = Array.from(new Set(uSet.map((u) => +u.toFixed(9)))).sort((a, b) => a - b);
    if (uSet.length === 0 || uSet[0] > 1e-9) uSet.unshift(0);

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

    // ---- Spiral ----
    lines.push(
      '; --- vase spiral' + (patternOn ? ' + ' + type : '') + (hangOn ? ' + hanger' : '') + ' ---'
    );

    const start = spikesMode ? wallPoint(0, 0) : wpoint(0, 0).p;
    travelAbs({ x: start.x, y: start.y, z: 0 });
    prevBump = false;
    prevU = 0;

    for (let L = 0; L < Lmax; L++) {
      const uEnd = Math.min(1, T - L);
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

    // Estimated print time from the actual path and feeds.
    let timeMin = 0;
    for (let i = 1; i < path.length; i++) {
      const d = dist3(path[i - 1], path[i]);
      if (path[i].feed > 0) timeMin += d / path[i].feed;
    }

    const stats = { volume: totalVolume, pathLength: pathLength, moves: moveCount, loops: T, timeMin: timeMin };
    return { gcode: lines.join('\n') + '\n', warnings, stats, path };
  }

  window.GcodeGen = { generate, beadArea };
})();
