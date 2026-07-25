/*
 * geometry.js — shape generation, arc-length resampling, and polyline offsetting.
 * All shapes are produced as dense, closed, counter-clockwise (CCW) point lists
 * centered on the origin. Points are {x, y} in millimeters.
 *
 * Exposed on window.Geo so the files work from file:// and GitHub Pages without
 * a module bundler.
 */
(function () {
  'use strict';

  function signedArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
  }

  // Force CCW winding (positive signed area).
  function ensureCCW(pts) {
    return signedArea(pts) < 0 ? pts.slice().reverse() : pts;
  }

  function circle(r, steps) {
    const pts = [];
    for (let i = 0; i < steps; i++) {
      const a = (2 * Math.PI * i) / steps;
      pts.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
    }
    return pts;
  }

  function ellipse(rx, ry, steps) {
    const pts = [];
    for (let i = 0; i < steps; i++) {
      const a = (2 * Math.PI * i) / steps;
      pts.push({ x: rx * Math.cos(a), y: ry * Math.sin(a) });
    }
    return pts;
  }

  // The 4 fillet-arc centers of a rounded rectangle (shared with the mouse-ear
  // brim, which needs each corner's own center + radius independently of the
  // tessellated outline).
  function roundedRectFillets(width, length, fillet) {
    const hw = width / 2;
    const hl = length / 2;
    const rf = Math.max(0, Math.min(fillet, Math.min(hw, hl)));
    return {
      rf: rf,
      corners: [
        { x: hw - rf, y: -hl + rf, a0: -Math.PI / 2, a1: 0 }, // bottom-right
        { x: hw - rf, y: hl - rf, a0: 0, a1: Math.PI / 2 }, // top-right
        { x: -hw + rf, y: hl - rf, a0: Math.PI / 2, a1: Math.PI }, // top-left
        { x: -hw + rf, y: -hl + rf, a0: Math.PI, a1: 1.5 * Math.PI }, // bottom-left
      ],
    };
  }

  // width = X extent, length = Y extent, fillet = corner radius.
  function roundedRect(width, length, fillet) {
    const fl = roundedRectFillets(width, length, fillet);
    const pts = [];
    const arcSteps = 24;
    fl.corners.forEach((c) => {
      for (let s = 0; s <= arcSteps; s++) {
        const a = c.a0 + ((c.a1 - c.a0) * s) / arcSteps;
        pts.push({ x: c.x + fl.rf * Math.cos(a), y: c.y + fl.rf * Math.sin(a) });
      }
    });
    return pts;
  }

  function polygon(r, sides) {
    const n = Math.max(3, Math.round(sides));
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n + Math.PI / 2; // point-up
      pts.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
    }
    return pts;
  }

  function star(outerR, innerR, points) {
    const p = Math.max(2, Math.round(points));
    const pts = [];
    for (let i = 0; i < p * 2; i++) {
      const r = i % 2 === 0 ? outerR : innerR;
      const a = (Math.PI * i) / p + Math.PI / 2;
      pts.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
    }
    return pts;
  }

  // Superellipse / squircle: |x/a|^n + |y/a|^n = 1.
  function squircle(size, n, steps) {
    const a = size;
    const exp = Math.max(0.2, n);
    const pts = [];
    const sgn = (v) => (v < 0 ? -1 : 1);
    for (let i = 0; i < steps; i++) {
      const t = (2 * Math.PI * i) / steps;
      const c = Math.cos(t);
      const s = Math.sin(t);
      pts.push({
        x: a * sgn(c) * Math.pow(Math.abs(c), 2 / exp),
        y: a * sgn(s) * Math.pow(Math.abs(s), 2 / exp),
      });
    }
    return pts;
  }

  // Build a dense outline for the named shape from its numeric params.
  function makeShape(shape, p) {
    let pts;
    switch (shape) {
      case 'circle':
        pts = circle(p.radius, 720);
        break;
      case 'ellipse':
        pts = ellipse(p.rx, p.ry, 720);
        break;
      case 'roundedRect':
        pts = roundedRect(p.width, p.length, p.fillet);
        break;
      case 'polygon':
        pts = polygon(p.radius, p.sides);
        break;
      case 'star':
        pts = star(p.outerR, p.innerR, p.points);
        break;
      case 'squircle':
        pts = squircle(p.size, p.n, 720);
        break;
      default:
        pts = circle(30, 720);
    }
    return ensureCCW(pts);
  }

  function dist(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  // Total length around a closed loop (includes the closing segment).
  function perimeter(pts) {
    let total = 0;
    for (let i = 0; i < pts.length; i++) {
      total += dist(pts[i], pts[(i + 1) % pts.length]);
    }
    return total;
  }

  // Resample a closed polyline into exactly N points spaced evenly by arc length.
  function resampleClosed(pts, n) {
    const cum = [0];
    for (let i = 0; i < pts.length; i++) {
      cum.push(cum[i] + dist(pts[i], pts[(i + 1) % pts.length]));
    }
    const total = cum[cum.length - 1];
    const out = [];
    let seg = 0;
    for (let k = 0; k < n; k++) {
      const target = (k * total) / n;
      while (seg < pts.length - 1 && cum[seg + 1] < target) seg++;
      const a = pts[seg];
      const b = pts[(seg + 1) % pts.length];
      const segLen = cum[seg + 1] - cum[seg] || 1e-9;
      const t = (target - cum[seg]) / segLen;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    return out;
  }

  // Offset a closed CCW polyline by `d` along per-vertex outward normals.
  // Positive d = outward, negative d = inward.
  function offsetClosed(pts, d) {
    const n = pts.length;
    const out = [];
    for (let i = 0; i < n; i++) {
      const prev = pts[(i - 1 + n) % n];
      const cur = pts[i];
      const next = pts[(i + 1) % n];
      const rn = (a, b) => {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1e-9;
        return { x: dy / len, y: -dx / len }; // right-hand normal (outward for CCW)
      };
      const n1 = rn(prev, cur);
      const n2 = rn(cur, next);
      let nx = n1.x + n2.x;
      let ny = n1.y + n2.y;
      const len = Math.hypot(nx, ny) || 1e-9;
      nx /= len;
      ny /= len;
      out.push({ x: cur.x + d * nx, y: cur.y + d * ny });
    }
    return out;
  }

  // Even-odd (crossing number) point-in-polygon test for a closed CCW/CW
  // polyline (no duplicated closing point).
  function pointInPolygon(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i];
      const b = poly[j];
      const crosses = a.y > pt.y !== b.y > pt.y;
      if (crosses && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) {
        inside = !inside;
      }
    }
    return inside;
  }

  // Does a closed polyline cross itself anywhere? O(n^2) — fine for a
  // one-time check on a few hundred points (e.g. validating a hanger loop
  // right after building it), not for anything per-layer.
  function polylineSelfIntersects(pts) {
    const n = pts.length;
    function segInt(p1, p2, p3, p4) {
      const d1x = p2.x - p1.x, d1y = p2.y - p1.y, d2x = p4.x - p3.x, d2y = p4.y - p3.y;
      const denom = d1x * d2y - d1y * d2x;
      if (Math.abs(denom) < 1e-12) return false;
      const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
      const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
      return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6;
    }
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
        if (segInt(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return true;
      }
    }
    return false;
  }

  // Distance from point p to the segment a-b.
  function segDist(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  // Ramer–Douglas–Peucker simplification of an OPEN polyline (keeps endpoints).
  function rdp(points, eps) {
    if (points.length < 3) return points.slice();
    const a = points[0];
    const b = points[points.length - 1];
    let idx = -1;
    let maxd = 0;
    for (let i = 1; i < points.length - 1; i++) {
      const d = segDist(points[i], a, b);
      if (d > maxd) {
        maxd = d;
        idx = i;
      }
    }
    if (maxd > eps) {
      const left = rdp(points.slice(0, idx + 1), eps);
      const right = rdp(points.slice(idx), eps);
      return left.slice(0, -1).concat(right);
    }
    return [a, b];
  }

  // Simplify a CLOSED polyline to within `eps` (chord tolerance). Returns a
  // closed CCW point list (no duplicated closing point).
  function rdpClosed(closed, eps) {
    if (closed.length < 4) return closed.slice();
    const start = closed[0];
    let idx = 0;
    let maxd = -1;
    for (let i = 1; i < closed.length; i++) {
      const d = dist(closed[i], start);
      if (d > maxd) {
        maxd = d;
        idx = i;
      }
    }
    const arc1 = closed.slice(0, idx + 1);
    const arc2 = closed.slice(idx).concat([start]);
    const r1 = rdp(arc1, eps);
    const r2 = rdp(arc2, eps);
    return r1.slice(0, -1).concat(r2.slice(0, -1));
  }

  // Build a shape and simplify it to the given chord tolerance (mm).
  function adaptiveShape(shape, params, tol) {
    return rdpClosed(makeShape(shape, params), Math.max(1e-4, tol));
  }

  // Rotate a closed CCW polyline so it starts exactly where a chosen axis
  // crosses it. side: 'back' (+Y), 'front' (-Y), 'right' (+X), 'left' (-X).
  // The exact crossing point is inserted (so the seam lands mid-edge, not at a
  // vertex), making the seam world-fixed regardless of the shape's points.
  function rotateToSeam(base, side) {
    const horiz = side === 'right' || side === 'left'; // cross the X axis (y = 0)
    const wantPos = side === 'back' || side === 'right';
    const n = base.length;
    let bestPt = null;
    let bestIdx = -1;
    let bestSide = wantPos ? -Infinity : Infinity;
    for (let i = 0; i < n; i++) {
      const a = base[i];
      const b = base[(i + 1) % n];
      const ca = horiz ? a.y : a.x; // coordinate that must reach 0 at the crossing
      const cb = horiz ? b.y : b.x;
      if ((ca <= 0 && cb > 0) || (ca >= 0 && cb < 0)) {
        const t = ca / (ca - cb);
        const pt = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        const sideVal = horiz ? pt.x : pt.y; // which side of the axis this crossing is on
        const onWanted = wantPos ? sideVal > 0 : sideVal < 0;
        if (onWanted && (wantPos ? sideVal > bestSide : sideVal < bestSide)) {
          bestSide = sideVal;
          bestPt = pt;
          bestIdx = i;
        }
      }
    }
    if (!bestPt) {
      // Fallback: most extreme vertex in the wanted direction.
      let best = 0;
      let bestMain = wantPos ? -Infinity : Infinity;
      for (let i = 0; i < n; i++) {
        const main = horiz ? base[i].x : base[i].y;
        if (wantPos ? main > bestMain : main < bestMain) {
          bestMain = main;
          best = i;
        }
      }
      return base.slice(best).concat(base.slice(0, best));
    }
    const rotated = [bestPt];
    for (let k = 1; k <= n; k++) rotated.push(base[(bestIdx + k) % n]);
    return rotated;
  }

  // Cumulative arc-length sampler for a closed polyline. Returns a function
  // u -> { pos, tan } where u in [0,1) is the fraction of total perimeter, and
  // tan is the unit tangent direction at that point.
  function makeSampler(base) {
    const n = base.length;
    const cum = [0];
    for (let i = 0; i < n; i++) cum.push(cum[i] + dist(base[i], base[(i + 1) % n]));
    const total = cum[n];
    return {
      perimeter: total,
      uOf: (i) => cum[i] / total, // u of base vertex i
      at: (u) => {
        let uu = u - Math.floor(u);
        const target = uu * total;
        let seg = 0;
        while (seg < n - 1 && cum[seg + 1] <= target) seg++;
        const a = base[seg];
        const b = base[(seg + 1) % n];
        const segLen = cum[seg + 1] - cum[seg] || 1e-9;
        const t = (target - cum[seg]) / segLen;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const L = Math.hypot(dx, dy) || 1e-9;
        return { pos: { x: a.x + dx * t, y: a.y + dy * t }, tan: { x: dx / L, y: dy / L } };
      },
    };
  }

  // Tessellate a cubic bezier defined Hermite-style: endpoints + unit tangents.
  // Control length = 1/3 of the endpoint distance. Returns `steps` points
  // excluding p0, including p3.
  function bezierPts(p0, t0, p3, t3, steps) {
    const d = Math.hypot(p3.x - p0.x, p3.y - p0.y);
    const k = d / 3;
    const c1 = { x: p0.x + t0.x * k, y: p0.y + t0.y * k };
    const c2 = { x: p3.x - t3.x * k, y: p3.y - t3.y * k };
    const out = [];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const m = 1 - t;
      out.push({
        x: m * m * m * p0.x + 3 * m * m * t * c1.x + 3 * m * t * t * c2.x + t * t * t * p3.x,
        y: m * m * m * p0.y + 3 * m * m * t * c1.y + 3 * m * t * t * c2.y + t * t * t * p3.y,
      });
    }
    return out;
  }

  // One keyhole "funnel" detour: a gap (removed material, centered at
  // gapCenter, half-width gapHalf) bridged through the interior — via two
  // tangent-matched beziers and an inward-offset (by lineWidth) pocket arc —
  // to a pocket (centered at pocketCenter, half-width pocketHalf) somewhere
  // else on the curve. gStart/gEnd are the gap's own two edges (in perimeter-
  // fraction u, NOT wrapped to [0,1) — the caller wraps as needed); the
  // returned pts run from gStart's bezier through to gEnd itself (NOT
  // including gStart — the caller supplies that, already walking the plain
  // wall up to it), all tagged isNew=true except the final point (gEnd,
  // back on the true wall). Factored out of the single-hanger construction
  // so the same funnel shape can be repositioned/resized for the
  // double-hanger mode.
  // Sign of the SHORTEST path direction from u-fraction `from` to `to`
  // (wraparound-aware — going the "other way" around is shorter whenever
  // the raw difference exceeds half the perimeter).
  function shortDir(from, to) {
    let d = to - from;
    d -= Math.round(d);
    return d >= 0 ? 1 : -1;
  }

  // Does an OPEN polyline (no wraparound between last and first point) cross
  // itself? Same O(n^2) segment test as polylineSelfIntersects, just without
  // the closing edge — used to compare candidate keyhole detours, which are
  // open paths (wall -> bezier -> pocket -> bezier -> wall), not closed loops.
  function openPolylineSelfIntersects(pts) {
    const n = pts.length;
    function segInt(p1, p2, p3, p4) {
      const d1x = p2.x - p1.x, d1y = p2.y - p1.y, d2x = p4.x - p3.x, d2y = p4.y - p3.y;
      const denom = d1x * d2y - d1y * d2x;
      if (Math.abs(denom) < 1e-12) return false;
      const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
      const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
      return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6;
    }
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 2; j < n - 1; j++) {
        if (segInt(pts[i], pts[i + 1], pts[j], pts[j + 1])) return true;
      }
    }
    return false;
  }

  function buildKeyholeDetour(s, gapCenter, gapHalf, pocketCenter, pocketHalf) {
    return function (lineWidth) {
      const gStart = gapCenter - gapHalf;
      const gEnd = gapCenter + gapHalf;
      const A = s.at(gStart);
      const B = s.at(gEnd);
      // Inward normal for a CCW curve is (-tan.y, +tan.x).
      const inw = (q) => ({ x: q.pos.x - lineWidth * q.tan.y, y: q.pos.y + lineWidth * q.tan.x });
      const pocketFrac = 2 * pocketHalf;
      const steps = Math.max(8, Math.ceil((pocketFrac * s.perimeter) / 1.0));

      // Build the detour for one assignment of the two pocket edges to the
      // two gap edges (gStart<->e1, gEnd<->e2). Which assignment avoids a
      // self-crossing depends on how far apart the gap and pocket sit: when
      // they're roughly opposite (single-hanger mode, pocket straddling the
      // seam wraparound), the "near edge to near edge" pairing is the smooth
      // one; when they're close together and to one side (the double-
      // hanger's compact keyholes), the beziers' own wall-tangents can make
      // that same pairing bow into each other, and the other assignment is
      // the smooth one instead. Rather than guess from position alone, build
      // both and keep whichever doesn't cross itself.
      function build(e1, e2) {
        const sgn = shortDir(e1, e2); // sweep direction along the short pocket arc
        const E1 = s.at(e1);
        const E2 = s.at(e2);
        const E1o = inw(E1);
        const E2o = inw(E2);
        const dir1 = shortDir(gStart, e1);
        const dir2 = shortDir(e2, gEnd);
        const pts = [];
        bezierPts(A.pos, A.tan, E1o, { x: dir1 * E1.tan.x, y: dir1 * E1.tan.y }, 32).forEach((p) =>
          pts.push({ x: p.x, y: p.y, isNew: true })
        );
        for (let i = 1; i < steps; i++) {
          const q = s.at(e1 + sgn * (i / steps) * pocketFrac);
          const o = inw(q);
          pts.push({ x: o.x, y: o.y, isNew: true });
        }
        pts.push({ x: E2o.x, y: E2o.y, isNew: true });
        const bz2 = bezierPts(E2o, { x: dir2 * E2.tan.x, y: dir2 * E2.tan.y }, B.pos, B.tan, 32);
        bz2.forEach((p, i) => pts.push({ x: p.x, y: p.y, isNew: i !== bz2.length - 1 }));
        return pts;
      }

      const P = pocketCenter - pocketHalf;
      const Q = pocketCenter + pocketHalf;
      const candidatePQ = build(P, Q);
      const openPQ = [A.pos].concat(candidatePQ);
      const pts = openPolylineSelfIntersects(openPQ) ? build(Q, P) : candidatePQ;
      return { gStart, gEnd, A, pts };
    };
  }

  // Build the wall-hanger loop from a seam-rotated CCW base curve.
  // gapFrac = fraction of the perimeter removed at the back (opposite the
  // seam); pocketFrac = fraction of the perimeter grabbed at the seam and
  // offset inward by lineWidth (usually smaller than gapFrac so the beziers
  // have room). Returns a closed point list starting and ending at the seam;
  // points on the beziers/pocket carry isNew=true (the sections that bridge
  // on the first hanger loop).
  function buildHangerLoop(base, gapFrac, pocketFrac, lineWidth) {
    const s = makeSampler(base);
    const n = base.length;
    const detour = buildKeyholeDetour(s, 0.5, gapFrac / 2, 0, pocketFrac / 2)(lineWidth);
    const uA = detour.gStart;
    const uB = detour.gEnd;

    const pts = [{ x: base[0].x, y: base[0].y, isNew: false }];

    // Outer wall: seam -> A.
    for (let i = 1; i < n; i++) {
      const u = s.uOf(i);
      if (u >= uA) break;
      pts.push({ x: base[i].x, y: base[i].y, isNew: false });
    }
    pts.push({ x: detour.A.pos.x, y: detour.A.pos.y, isNew: false });
    pts.push(...detour.pts);

    // Outer wall: B -> back to the seam.
    for (let i = 0; i < n; i++) {
      const u = s.uOf(i);
      if (u > uB) pts.push({ x: base[i].x, y: base[i].y, isNew: false });
    }
    pts.push({ x: base[0].x, y: base[0].y, isNew: false });
    return pts;
  }

  // Double-hanger variant: two independent, smaller keyhole funnels instead
  // of one large one. gapFrac (the same "gap %" input as the single-hanger)
  // now picks two GAP ANCHOR points at gapFrac/2 either side of the seam
  // (u=0) — not a single gap of that width centered opposite the seam. Each
  // anchor gets its own gap of width gapWidthMM (absolute, split evenly
  // either side of the anchor), bridged to a pocket of width pocketWidthMM
  // centered at the mirrored point on the OPPOSITE side (u=0.5, offset by
  // that same gapFrac/2) — gap1 (near u=gapFrac/2) pockets at u=0.5-gapFrac/2,
  // gap2 (near u=1-gapFrac/2) pockets at u=0.5+gapFrac/2 — each its own
  // self-contained funnel spanning roughly a quarter of the perimeter.
  function buildDoubleHangerLoop(base, gapFrac, gapWidthMM, pocketWidthMM, lineWidth) {
    const s = makeSampler(base);
    const n = base.length;
    const half = gapFrac / 2;
    const gHalf = gapWidthMM / 2 / s.perimeter;
    const pHalf = pocketWidthMM / 2 / s.perimeter;
    const d1 = buildKeyholeDetour(s, half, gHalf, 0.5 - half, pHalf)(lineWidth);
    const d2 = buildKeyholeDetour(s, 1 - half, gHalf, 0.5 + half, pHalf)(lineWidth);
    // Normalize to [0,1) and order by position along the curve so the wall
    // segments between/around them are walked correctly regardless of which
    // one the caller happened to build first.
    const wrap = (u) => ((u % 1) + 1) % 1;
    const dets = [
      { gStart: wrap(d1.gStart), gEnd: wrap(d1.gEnd), A: d1.A, pts: d1.pts },
      { gStart: wrap(d2.gStart), gEnd: wrap(d2.gEnd), A: d2.A, pts: d2.pts },
    ].sort((a, b) => a.gStart - b.gStart);

    const pts = [{ x: base[0].x, y: base[0].y, isNew: false }];
    let uCursor = 0;
    dets.forEach((det) => {
      for (let i = 1; i < n; i++) {
        const u = s.uOf(i);
        if (u <= uCursor || u >= det.gStart) continue;
        pts.push({ x: base[i].x, y: base[i].y, isNew: false });
      }
      pts.push({ x: det.A.pos.x, y: det.A.pos.y, isNew: false });
      pts.push(...det.pts);
      uCursor = det.gEnd;
    });
    for (let i = 1; i < n; i++) {
      const u = s.uOf(i);
      if (u > uCursor) pts.push({ x: base[i].x, y: base[i].y, isNew: false });
    }
    pts.push({ x: base[0].x, y: base[0].y, isNew: false });
    return pts;
  }

  // Build one bend-stool loop as a polyline: a circle of radius r traced CCW
  // from aStart, detouring out along each leg (hairpin side lines + tip cap)
  // with tangent fillet arcs at the junctions. gapAng > 0 leaves the staircase
  // gap before the start. leg = null gives a plain (gapped) circle.
  // leg = { d: half-width of this hairpin, f: fillet radius, tipCenter:
  // distance of the concentric cap center from the origin, angles: [rad...] }.
  //
  // attr = null | { points: [{x,y}..], r1, r2, D } spreads the loop for the
  // bend zone: within r1 of the nearest attractor every point is offset by D
  // along the loop's outward normal, easing to zero (smoothstep) at r2.
  // Applied per primitive so it can never self-intersect: ring arcs grow
  // radially, leg sides shift sideways, tip caps grow, and concave fillets
  // SHRINK toward their center, clamped there — a collapsed fillet becomes a
  // sharp corner.
  function stoolLoop(o) {
    const pts = [];
    const tol = o.tol > 0 ? o.tol : 0.05;
    const attr = o.attr && o.attr.D > 0 && o.attr.points && o.attr.points.length ? o.attr : null;
    const FINE = 1.2; // mm resampling inside attractor windows

    function push(x, y, w) {
      const n = pts.length;
      if (n && Math.abs(pts[n - 1].x - x) < 1e-9 && Math.abs(pts[n - 1].y - y) < 1e-9) return;
      pts.push({ x: x, y: y, w: w || 0 });
    }
    function distA(x, y) {
      let dm = Infinity;
      for (let i = 0; i < attr.points.length; i++) {
        const q = attr.points[i];
        const dd = Math.hypot(x - q.x, y - q.y);
        if (dd < dm) dm = dd;
      }
      return dm;
    }
    function kAt(x, y) {
      const dd = distA(x, y);
      if (dd <= attr.r1) return 1;
      if (dd >= attr.r2) return 0;
      const tt = (dd - attr.r1) / (attr.r2 - attr.r1);
      return 1 - tt * tt * (3 - 2 * tt); // smoothstep ease-out
    }
    function near(x, y) {
      return distA(x, y) < attr.r2 + FINE * 2;
    }
    // Applied lateral displacement for falloff factor g. attr.pb pulls the
    // point back down the overhang slope proportionally to how far it moved
    // out (per-loop constant), preserving the wall's slope angle.
    function eff(g) {
      // Along-slope compression: pull the applied displacement back toward the
      // spine by g*slopeK (= drop * overhang ratio), so the point moves toward
      // the less-spread point on the layer below. Paired with the accumulating
      // z-drop this makes the move follow the overhang slope (angle preserved).
      return attr.D * g * (1 - g * (attr.slopeK || 0));
    }

    function arcSteps(radius, sweep) {
      let dth = 2 * Math.acos(Math.max(-1, 1 - tol / Math.max(radius, 1e-6)));
      if (!isFinite(dth) || dth <= 0) dth = 0.2;
      return Math.max(2, Math.ceil(Math.abs(sweep) / dth));
    }

    // Main-circle arc; attractor displaces radially outward from the origin.
    function ringArc(a0, a1) {
      const n = arcSteps(o.r, a1 - a0);
      if (!attr) {
        for (let s = 1; s <= n; s++) {
          const a = a0 + ((a1 - a0) * s) / n;
          push(o.r * Math.cos(a), o.r * Math.sin(a));
        }
        return;
      }
      let prev = a0;
      for (let s = 1; s <= n; s++) {
        const a = a0 + ((a1 - a0) * s) / n;
        const fine =
          near(o.r * Math.cos(prev), o.r * Math.sin(prev)) || near(o.r * Math.cos(a), o.r * Math.sin(a));
        const m = fine ? Math.max(1, Math.ceil((Math.abs(a - prev) * o.r) / FINE)) : 1;
        for (let j = 1; j <= m; j++) {
          const aa = prev + ((a - prev) * j) / m;
          const bx = o.r * Math.cos(aa);
          const by = o.r * Math.sin(aa);
          const kk = kAt(bx, by);
          const rr = o.r + eff(kk);
          push(rr * Math.cos(aa), rr * Math.sin(aa), attr.D * kk);
        }
        prev = a;
      }
    }

    // Arc around an arbitrary center. dSign: +1 = attractor grows the radius
    // (convex caps), -1 = shrinks it toward the center, clamped at 0 (concave
    // fillets -> sharp corner), 0/undefined = never displaced.
    function arcAround(cx0, cy0, radius, a0, a1, dSign) {
      if (radius <= 1e-9 || Math.abs(a1 - a0) < 1e-9) return;
      const n = arcSteps(radius, a1 - a0);
      if (!attr || !dSign) {
        for (let s = 1; s <= n; s++) {
          const a = a0 + ((a1 - a0) * s) / n;
          push(cx0 + radius * Math.cos(a), cy0 + radius * Math.sin(a));
        }
        return;
      }
      let prev = a0;
      for (let s = 1; s <= n; s++) {
        const a = a0 + ((a1 - a0) * s) / n;
        const fine =
          near(cx0 + radius * Math.cos(prev), cy0 + radius * Math.sin(prev)) ||
          near(cx0 + radius * Math.cos(a), cy0 + radius * Math.sin(a));
        const m = fine ? Math.max(1, Math.ceil((Math.abs(a - prev) * radius) / FINE)) : 1;
        for (let j = 1; j <= m; j++) {
          const aa = prev + ((a - prev) * j) / m;
          const bx = cx0 + radius * Math.cos(aa);
          const by = cy0 + radius * Math.sin(aa);
          const kk = kAt(bx, by);
          const rr = Math.max(0, radius + dSign * eff(kk));
          push(cx0 + rr * Math.cos(aa), cy0 + rr * Math.sin(aa), attr.D * kk);
        }
        prev = a;
      }
    }

    const aEndTotal = o.aStart + 2 * Math.PI - (o.gapAng || 0);
    if (attr) {
      const sx = o.r * Math.cos(o.aStart);
      const sy = o.r * Math.sin(o.aStart);
      const k0 = kAt(sx, sy);
      const rr0 = o.r + eff(k0);
      push(rr0 * Math.cos(o.aStart), rr0 * Math.sin(o.aStart), attr.D * k0);
    } else {
      pts.push({ x: o.r * Math.cos(o.aStart), y: o.r * Math.sin(o.aStart) });
    }

    if (!o.leg) {
      ringArc(o.aStart, aEndTotal);
      return pts;
    }

    const R = o.r;
    const d = o.leg.d;
    const f = Math.max(0, o.leg.f);
    const tipCenter = o.leg.tipCenter;
    const t = Math.sqrt(Math.max(0, (R + f) * (R + f) - (d + f) * (d + f)));
    const beta = Math.atan2(d + f, t); // angular half-extent of a junction
    const turn = Math.PI / 2 - beta; // fillet arc sweep (traversed clockwise)

    let cur = o.aStart;
    const angs = o.leg.angles
      .map((p) => {
        let a = p;
        while (a <= o.aStart + 1e-12) a += 2 * Math.PI;
        return a;
      })
      .sort((a, b) => a - b);

    for (const p of angs) {
      if (p - beta <= cur + 1e-9 || p + beta >= aEndTotal - 1e-9) continue; // no room; skip
      const u = { x: Math.cos(p), y: Math.sin(p) };
      const v = { x: -u.y, y: u.x };
      const L = (tu, sv) => ({ x: u.x * tu + v.x * sv, y: u.y * tu + v.y * sv });

      // Straight leg side from L(tFrom, sOff) (already emitted) to L(tTo, sOff);
      // attractor shifts it sideways (away from the spine) with fine sampling
      // only inside the affected windows.
      function legLine(tFrom, tTo, sOff) {
        if (!attr) {
          const e = L(tTo, sOff);
          push(e.x, e.y);
          return;
        }
        const sgn = sOff >= 0 ? 1 : -1;
        const emitT = (tt) => {
          const b = L(tt, sOff);
          const k = kAt(b.x, b.y);
          const e = eff(k);
          push(b.x + sgn * v.x * e, b.y + sgn * v.y * e, attr.D * k);
        };
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = 0; i < attr.points.length; i++) {
          const q = attr.points[i];
          const tq = q.x * u.x + q.y * u.y;
          const sq = q.x * v.x + q.y * v.y;
          const perp = Math.abs(sq - sOff);
          const RR = attr.r2 + FINE;
          if (perp < RR) {
            const half = Math.sqrt(RR * RR - perp * perp);
            if (tq - half < lo) lo = tq - half;
            if (tq + half > hi) hi = tq + half;
          }
        }
        lo = Math.max(lo, Math.min(tFrom, tTo));
        hi = Math.min(hi, Math.max(tFrom, tTo));
        if (lo < hi) {
          const dir = tTo >= tFrom ? 1 : -1;
          const tA = dir > 0 ? lo : hi;
          const tB = dir > 0 ? hi : lo;
          if ((tA - tFrom) * dir > 1e-9) emitT(tA);
          const m = Math.max(1, Math.ceil(Math.abs(tB - tA) / FINE));
          for (let j = 1; j <= m; j++) emitT(tA + ((tB - tA) * j) / m);
          if ((tTo - tB) * dir > 1e-9) emitT(tTo);
        } else {
          emitT(tTo);
        }
      }

      // A fillet "collapses" when the attractor displacement reaches its
      // radius. The pointwise-shrunk arc would then notch back through its own
      // center, so instead we emit the TRUE offset corner: the intersection of
      // the displaced ring circle (r + Dk) and the displaced leg line (d + Dk)
      // — the tight-corner case. Returns null while the fillet survives.
      function filletCorner(F, aA, aB, sSign) {
        if (!attr) return null;
        const pB = L(t, sSign * d); // line-side tangent point (base)
        const kc = kAt(pB.x, pB.y);
        const Dk = eff(kc);
        if (f > 1e-9) {
          const m = Math.max(6, Math.ceil((Math.abs(aB - aA) * f) / FINE));
          let rMin = Infinity;
          for (let s = 0; s <= m; s++) {
            const aa = aA + ((aB - aA) * s) / m;
            const rr = f - eff(kAt(F.x + f * Math.cos(aa), F.y + f * Math.sin(aa)));
            if (rr < rMin) rMin = rr;
          }
          if (rMin > 0.02) return null;
        } else if (Dk <= 1e-9) {
          return null; // sharp and undisplaced: nothing to add
        }
        const RR = o.r + Dk;
        const dd2 = d + Dk;
        const tc = Math.sqrt(Math.max(0, RR * RR - dd2 * dd2));
        const c = L(tc, sSign * dd2);
        // betaC: the displaced junction's angular half-extent — wider than the
        // original beta, so the ring arc must stop/resume there instead.
        return { tc: tc, x: c.x, y: c.y, w: attr.D * kc, betaC: Math.atan2(dd2, tc) };
      }

      // Compute both junction corners first: a collapsed fillet widens the
      // angular footprint of the junction, and the ring arcs must honor that.
      const F1 = L(t, -(d + f));
      const a1 = Math.atan2(-F1.y, -F1.x);
      const c1 = filletCorner(F1, a1, a1 - turn, -1);
      const F2 = L(t, d + f);
      const c2 = filletCorner(F2, p - Math.PI / 2, p - Math.PI / 2 - turn, 1);

      // Ring arc up to the (possibly displaced) entry junction.
      ringArc(cur, p - (c1 ? c1.betaC : beta));
      // Entry fillet: concave — shrinks toward its center, or the tight corner.
      if (c1) {
        push(c1.x, c1.y, c1.w);
        legLine(c1.tc, tipCenter, -d);
      } else {
        arcAround(F1.x, F1.y, f, a1, a1 - turn, -1);
        legLine(t, tipCenter, -d);
      }
      // Tip cap: half-turn around the concentric tip center (convex: grows).
      arcAround(u.x * tipCenter, u.y * tipCenter, d, p - Math.PI / 2, p + Math.PI / 2, 1);
      // Straight side back in, then the exit fillet (mirror).
      if (c2) {
        legLine(tipCenter, c2.tc, d);
        push(c2.x, c2.y, c2.w);
      } else {
        legLine(tipCenter, t, d);
        arcAround(F2.x, F2.y, f, p - Math.PI / 2, p - Math.PI / 2 - turn, -1);
      }
      cur = p + (c2 ? c2.betaC : beta);
    }
    ringArc(cur, aEndTotal);
    return pts;
  }

  // Concentric solid fill of a closed CCW shape. `outer` is the outermost ring
  // (already positioned, e.g. one line width inside a vessel wall so it butts
  // the wall's inner edge). Interior rings are produced by scaling `outer`
  // toward its centroid with a radial step of `lw` at the widest point — this
  // never self-intersects (unlike a naive per-vertex offset on a fine polygon)
  // and is an exact concentric offset for circles. Returns open polylines
  // ordered inner -> outer (each traced from the seam, stopping ~one line width
  // before closing so the generator's connector to the next ring lands cleanly)
  // plus the outer closed outline.
  //   style: 'staircase' (default; every ring same direction) | 'alternating'
  //   (zipper: alternate direction; `true` also accepted) | 'spiral' (one
  //   continuous seamless path, see below). seamSide sets the seam axis.
  //   wallCurve (spiral style only): the wall centerline one line width
  //   outside `outer` — the spiral continues one extra revolution onto it, so
  //   the fill hands off to the wall as the same unbroken line.
  function ringFill(outer, lw, tol, style, seamSide, wallCurve) {
    const alt = style === true || style === 'alternating';
    const spiral = style === 'spiral';
    const n = outer.length;
    if (n < 3) return { loops: [], outline: null };
    // Area centroid (not the vertex average, which skews with point density) —
    // so scaled rings stay truly concentric and connectors land radially.
    let cx = 0;
    let cy = 0;
    let a2 = 0;
    for (let i = 0; i < n; i++) {
      const p = outer[i];
      const q = outer[(i + 1) % n];
      const cross = p.x * q.y - q.x * p.y;
      a2 += cross;
      cx += (p.x + q.x) * cross;
      cy += (p.y + q.y) * cross;
    }
    if (Math.abs(a2) < 1e-9) {
      cx = 0;
      cy = 0;
      for (let i = 0; i < n; i++) {
        cx += outer[i].x;
        cy += outer[i].y;
      }
      cx /= n;
      cy /= n;
    } else {
      cx /= 3 * a2;
      cy /= 3 * a2;
    }
    let Rmax = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(outer[i].x - cx, outer[i].y - cy);
      if (d > Rmax) Rmax = d;
    }
    if (Rmax < lw * 0.5) return { loops: [], outline: outer.slice() };
    const rings = []; // outer -> inner
    for (let k = 0; k * lw <= Rmax - lw * 0.5 && k < 4000; k++) {
      const f = (Rmax - k * lw) / Rmax;
      rings.push(outer.map((p) => ({ x: cx + (p.x - cx) * f, y: cy + (p.y - cy) * f })));
    }
    const outline = rings[0].slice();
    rings.reverse(); // inner -> outer

    // Resample every ring to the SAME N points, each starting at the seam. The
    // rings are radial scaled copies, so sample j is radially aligned across
    // them — connecting two rings at the same index is a clean radial step.
    let outerPer = perimeter(rings[rings.length - 1]);
    const N = Math.max(48, Math.ceil(outerPer / Math.max(tol * 8, 0.5)));
    const S = rings.map((r) => resampleClosed(rotateToSeam(r, seamSide), N));
    const gapN = rings.map((r) => {
      const per = perimeter(r);
      return Math.max(1, Math.min(N - 2, Math.round((lw / per) * N)));
    });

    const loops = [];
    if (spiral) {
      // True spiral: one continuous seamless path that never stops or closes.
      // It opens at the exact center — the first revolution grows from the
      // centroid point out to the innermost ring, a real spiral start with no
      // closed circle to crowd — then each revolution morphs radially from
      // one ring to the next (pitch = exactly one line width; the rings are
      // radially aligned scaled copies, so any footprint works). Instead of
      // ending at the fill's edge — a spiral can't end flush all the way
      // around — it keeps going one more revolution onto `wallCurve`, so the
      // wall is simply the next turn of the same line. The footprint's size
      // fixes the ring ladder from the outside, so the leftover pitch lands
      // on the innermost turn; there (opening revolution + the one after it)
      // extrusion follows the locally covered width, (min(gap,lw)+lw)/2lw,
      // instead of overfilling where the spacing dips under one line width.
      const M = S.length;
      const poly = [];
      const eCov = (gap) => (Math.min(gap, lw) + lw) / (2 * lw);
      for (let j = 0; j <= N; j++) {
        const t = j / N;
        const q = S[0][j % N];
        const x = cx + (q.x - cx) * t;
        const y = cy + (q.y - cy) * t;
        poly.push({ x: x, y: y, e: eCov(Math.hypot(x - cx, y - cy)) });
      }
      for (let k = 0; k < M - 1; k++) {
        for (let j = 1; j <= N; j++) {
          const t = j / N;
          const a = S[k][j % N];
          const b = S[k + 1][j % N];
          const x = a.x + (b.x - a.x) * t;
          const y = a.y + (b.y - a.y) * t;
          let e = 1;
          if (k === 0) {
            // Inner neighbour is the opening revolution at the same angle.
            const px = cx + (a.x - cx) * t;
            const py = cy + (a.y - cy) * t;
            e = eCov(Math.hypot(x - px, y - py));
          }
          poly.push({ x: x, y: y, e: e });
        }
      }
      if (wallCurve && wallCurve.length >= 3) {
        const W = resampleClosed(rotateToSeam(wallCurve, seamSide), N);
        const src = S[M - 1];
        for (let j = 1; j <= N; j++) {
          const t = j / N;
          const a = src[j % N];
          const b = W[j % N];
          poly.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, e: 1 });
        }
      }
      loops.push(poly);
    } else if (!alt) {
      // Staircase: innermost anchored at the seam; each ring traces forward and
      // stops one line width before its start, and the next (outer) ring begins
      // exactly where this one ended (same index -> radial connector). The seam
      // drifts outward, and every ring's gap is bridged by the next connector.
      let startIdx = 0;
      for (let i = 0; i < S.length; i++) {
        const cnt = N - gapN[i]; // segments to trace (leave the gap)
        const poly = [];
        for (let t = 0; t <= cnt; t++) poly.push(S[i][(startIdx + t) % N]);
        loops.push(poly);
        startIdx = (startIdx + cnt) % N;
      }
    } else {
      // Zipper: the seam gap is a straight SLOT. Take the seam line (the world
      // axis through all rings' seam points), offset it both ways by half a
      // line width, and cut every ring where it crosses those two parallel
      // lines — everything between them (on the seam side) is removed, with
      // the exact crossings interpolated in. All turnaround points therefore
      // sit on the two lines, one line width apart, and the U-turn connectors
      // run ALONG them: parallel, evenly spaced, filling the slot edge to edge
      // with no gaps. Every other ring is reversed; the seam never moves.
      const hw = lw / 2;
      // Seam frame from the seam axis: s = signed distance across the seam
      // line, t = distance along it toward the seam side.
      const horiz = seamSide === 'right' || seamSide === 'left';
      const tSign = seamSide === 'front' || seamSide === 'left' ? -1 : 1;
      const sOf = (p) => (horiz ? p.y : p.x);
      const tOf = (p) => (horiz ? p.x : p.y) * tSign;
      const inSlot = (p) => tOf(p) > 0 && Math.abs(sOf(p)) < hw;
      // Crossing of segment a->b with the line |s| = hw it exits through.
      const crossing = (a, b) => {
        const sa = sOf(a);
        const sb = sOf(b);
        const target = (sb >= 0 ? 1 : -1) * hw;
        const den = sb - sa;
        const f = Math.abs(den) < 1e-12 ? 0.5 : Math.max(0, Math.min(1, (target - sa) / den));
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      };
      for (let i = 0; i < S.length; i++) {
        const M = S[i]; // point 0 sits on the seam axis, inside the slot
        let A = 1;
        while (A < N && inSlot(M[A])) A++;
        let B = N - 1;
        while (B > 0 && inSlot(M[B])) B--;
        if (A >= N || B <= 0 || B < A) continue; // ring swallowed by the slot
        const poly = [crossing(M[A - 1], M[A])];
        for (let j = A; j <= B; j++) poly.push(M[j]);
        poly.push(crossing(M[(B + 1) % N], M[B]));
        if (i % 2 === 1) poly.reverse();
        loops.push(poly);
      }
    }
    return { loops: loops, outline: outline };
  }

  window.Geo = {
    bezierPts,
    buildHangerLoop,
    buildDoubleHangerLoop,
    stoolLoop,
    ringFill,
    rdpClosed,
    adaptiveShape,
    rotateToSeam,
    makeSampler,
    makeShape,
    ensureCCW,
    signedArea,
    perimeter,
    resampleClosed,
    offsetClosed,
    dist,
    roundedRectFillets,
    pointInPolygon,
    polylineSelfIntersects,
  };
})();
