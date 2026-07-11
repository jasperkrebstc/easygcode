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
      return attr.D * g * (1 - g * (attr.pb || 0));
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

  window.Geo = {
    bezierPts,
    buildHangerLoop,
    stoolLoop,
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
