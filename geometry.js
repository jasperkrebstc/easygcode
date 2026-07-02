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

  // width = X extent, length = Y extent, fillet = corner radius.
  function roundedRect(width, length, fillet) {
    const hw = width / 2;
    const hl = length / 2;
    const rf = Math.max(0, Math.min(fillet, Math.min(hw, hl)));
    const pts = [];
    const arcSteps = 24;
    function arc(cx, cy, a0, a1) {
      for (let s = 0; s <= arcSteps; s++) {
        const a = a0 + ((a1 - a0) * s) / arcSteps;
        pts.push({ x: cx + rf * Math.cos(a), y: cy + rf * Math.sin(a) });
      }
    }
    arc(hw - rf, -hl + rf, -Math.PI / 2, 0); // bottom-right
    arc(hw - rf, hl - rf, 0, Math.PI / 2); // top-right
    arc(-hw + rf, hl - rf, Math.PI / 2, Math.PI); // top-left
    arc(-hw + rf, -hl + rf, Math.PI, 1.5 * Math.PI); // bottom-left
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
    const frac = pocketFrac; // pocket arc length as a fraction
    const uA = 0.5 - gapFrac / 2; // gap edge reached first (CCW)
    const uB = 0.5 + gapFrac / 2; // gap edge where the outer wall resumes
    const uE1 = pocketFrac / 2; // pocket end on the first-traveled side
    const uE2 = 1 - pocketFrac / 2; // pocket end on the return side
    const A = s.at(uA);
    const B = s.at(uB);
    const E1 = s.at(uE1);
    const E2 = s.at(uE2);
    // Inward normal for a CCW curve is (-tan.y, +tan.x).
    const inw = (q) => ({ x: q.pos.x - lineWidth * q.tan.y, y: q.pos.y + lineWidth * q.tan.x });
    const E1o = inw(E1);
    const E2o = inw(E2);

    const pts = [{ x: base[0].x, y: base[0].y, isNew: false }];

    // Outer wall: seam -> A.
    for (let i = 1; i < n; i++) {
      const u = s.uOf(i);
      if (u >= uA) break;
      pts.push({ x: base[i].x, y: base[i].y, isNew: false });
    }
    pts.push({ x: A.pos.x, y: A.pos.y, isNew: false });

    // Bezier: A -> pocket start (arriving in the pocket's travel direction, -tan).
    bezierPts(A.pos, A.tan, E1o, { x: -E1.tan.x, y: -E1.tan.y }, 32).forEach((p) =>
      pts.push({ x: p.x, y: p.y, isNew: true })
    );

    // Pocket arc traced in reverse (uE1 -> seam -> uE2), offset inward.
    const steps = Math.max(8, Math.ceil((frac * s.perimeter) / 1.0));
    for (let i = 1; i < steps; i++) {
      const q = s.at(uE1 - (i / steps) * frac);
      const o = inw(q);
      pts.push({ x: o.x, y: o.y, isNew: true });
    }
    pts.push({ x: E2o.x, y: E2o.y, isNew: true });

    // Bezier: pocket end -> B (departing along the pocket's travel direction).
    const bz2 = bezierPts(E2o, { x: -E2.tan.x, y: -E2.tan.y }, B.pos, B.tan, 32);
    bz2.forEach((p, i) => pts.push({ x: p.x, y: p.y, isNew: i !== bz2.length - 1 }));

    // Outer wall: B -> back to the seam.
    for (let i = 0; i < n; i++) {
      const u = s.uOf(i);
      if (u > uB) pts.push({ x: base[i].x, y: base[i].y, isNew: false });
    }
    pts.push({ x: base[0].x, y: base[0].y, isNew: false });
    return pts;
  }

  window.Geo = {
    bezierPts,
    buildHangerLoop,
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
  };
})();
