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

  // Reverse a closed outline's traversal order — EXACT same points, same
  // shape, opposite winding (CCW becomes CW). Used for the "print
  // direction" setting: unlike a mirror reflection (which, for any shape
  // symmetric about the reflection axis — every shape this app ships except
  // an odd-sided polygon/star — round-trips back through ensureCCW to the
  // SAME traversal, doing nothing), this actually reverses which way the
  // nozzle sweeps around the SAME outline.
  //
  // The catch: every offset/pattern computation downstream (brim rings,
  // hanger pocket, weave lateral, spike push-out) derives "inward"/"outward"
  // from a fixed 90°-rotate-the-forward-tangent rule that assumes CCW.
  // Reversing the array flips the tangent makeSampler derives at every
  // point (it's now the backward direction), so that same rotate-by-90°
  // rule now yields the OPPOSITE of what it used to at that physical spot —
  // confirmed by direct test, not just derivation: same point, same
  // formula, opposite vector. So a plain reversal alone is NOT enough; it
  // must be paired with negating the offset amount everywhere one of those
  // rotate-by-90° computations happens (the `dirSign` parameter threaded
  // through offsetClosed / buildHangerLoop / buildDoubleHangerLoop, and
  // gcode.js's own weave/spike lateral-offset code) so "inward" and
  // "outward" still mean the same physical directions they always did.
  function reverseWinding(pts) {
    return pts.slice().reverse();
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
  // dirSign: +1 for a CCW-wound `pts` (the default, and the only case this
  // ever ran before the "print direction" setting existed), -1 if `pts` has
  // been through reverseWinding (still the same shape, but the per-vertex
  // normal below — derived from the LOCAL forward direction of travel,
  // which is now backward — comes out pointing the opposite way without
  // this, i.e. offsetting inward when `d` asked for outward or vice versa).
  function offsetClosed(pts, d, dirSign) {
    const sign = dirSign || 1;
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
      out.push({ x: cur.x + sign * d * nx, y: cur.y + sign * d * ny });
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

  // Resample a u-tagged, monotonically increasing (0 -> 1) closed point list
  // at an arbitrary u — for a hanger loop whose points carry a `u` (see
  // buildHangerLoop/buildDoubleHangerLoop): plain-wall points keep their
  // real u, detour points get one proportional to their position along the
  // detour. Lets a hanger loop and the plain base curve be resampled at the
  // SAME u values so a transition tween can blend them point-for-point
  // without the mismatch a generic arc-length resample introduces — away
  // from any detour the two share the same u and are identical points, so
  // the tween leaves that stretch of wall untouched at every layer.
  // Queries are assumed non-decreasing (the tween walks u forward).
  function makeUSampler(taggedPts) {
    const n = taggedPts.length;
    let seg = 0;
    return {
      at: (u) => {
        const uu = u - Math.floor(u);
        while (seg < n - 2 && taggedPts[seg + 1].u <= uu) seg++;
        const a = taggedPts[seg];
        const b = taggedPts[seg + 1];
        const span = b.u - a.u || 1e-9;
        const t = Math.max(0, Math.min(1, (uu - a.u) / span));
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
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
  function buildHangerLoop(base, gapFrac, pocketFrac, lineWidth, dirSign) {
    const n = base.length;
    const d = buildMiniHangerLoop(base, 0.5, gapFrac / 2, 0, pocketFrac / 2, lineWidth, dirSign);
    const s = makeSampler(base);

    const pts = [{ x: base[0].x, y: base[0].y, isNew: false, u: 0 }];

    // Outer wall: seam -> A.
    for (let i = 1; i < n; i++) {
      const u = s.uOf(i);
      if (u >= d.uA) break;
      pts.push({ x: base[i].x, y: base[i].y, isNew: false, u: u });
    }
    pts.push({ x: d.A.pos.x, y: d.A.pos.y, isNew: false, u: d.uA });
    pts.push(...d.pts);

    // Outer wall: B -> back to the seam.
    for (let i = 0; i < n; i++) {
      const u = s.uOf(i);
      if (u > d.uB) pts.push({ x: base[i].x, y: base[i].y, isNew: false, u: u });
    }
    pts.push({ x: base[0].x, y: base[0].y, isNew: false, u: 1 });
    return pts;
  }

  // Do chords (a,b) and (x,y) cross when drawn across the circle (perimeter-
  // fraction space, mod 1)? Rotate so `a` sits at 0 and compare which side
  // of x each of b/y falls on — interleaved (one inside, one outside) means
  // the chords cross; nested or flanking means they don't.
  function chordsCross(a, b, x, y) {
    const rel = (v) => {
      let r = v - a;
      r -= Math.floor(r);
      return r;
    };
    const rb = rel(b), rx = rel(x), ry = rel(y);
    return (rb < rx) !== (ry < rx);
  }

  // Sign of the SHORTEST path direction from u-fraction `from` to `to`
  // (wraparound-aware — going the "other way" around is shorter whenever
  // the raw difference exceeds half the perimeter).
  function shortDir(from, to) {
    let d = to - from;
    d -= Math.round(d);
    return d >= 0 ? 1 : -1;
  }

  // One keyhole "funnel" detour: a gap (removed material, centered at
  // gapCenter, half-width gapHalf) bridged through the interior — via two
  // tangent-matched beziers and an inward-offset (by lineWidth) pocket arc —
  // to a pocket (centered at pocketCenter, half-width pocketHalf) somewhere
  // else on the curve. The single hanger puts that pocket diametrically
  // opposite the gap; the double hanger's two mini-hangers put it off to one
  // side instead. Which pocket edge pairs with which gap edge, and which way
  // the short pocket arc sweeps, is chosen so the two bridging beziers are
  // NESTED rather than interleaved (interleaved chords cross when drawn;
  // nested ones don't) — for the single hanger's opposite-pocket case this
  // reduces to exactly the original, fixed choice.
  //
  // Returns the detour's own points (bezier + pocket + bezier, from A to B —
  // NOT including A itself, and not any of the plain wall on either side of
  // it — the caller supplies that by walking the base curve up to uA and
  // resuming after uB); points carry isNew=true except the final one (B,
  // back on the true wall).
  function buildMiniHangerLoop(base, gapCenter, gapHalf, pocketCenter, pocketHalf, lineWidth, dirSign) {
    const sign = dirSign || 1;
    const s = makeSampler(base);
    const uA = gapCenter - gapHalf; // gap edge reached first (CCW)
    const uB = gapCenter + gapHalf; // gap edge where the outer wall resumes
    const P = pocketCenter - pocketHalf;
    const Q = pocketCenter + pocketHalf;
    const swap = chordsCross(uA, uB, P, Q);
    const uE1 = swap ? Q : P; // pocket edge nearest A's bezier
    const uE2 = swap ? P : Q; // pocket edge nearest B's bezier
    const sgn = shortDir(uE1, uE2); // sweep direction along the short pocket arc
    const frac = 2 * pocketHalf; // pocket arc length as a fraction
    const A = s.at(uA);
    const B = s.at(uB);
    const E1 = s.at(uE1);
    const E2 = s.at(uE2);
    // Inward normal for a CCW curve is (-tan.y, +tan.x); `sign` flips this
    // to (tan.y, -tan.x) when `base` has been through reverseWinding (same
    // shape, traversed backward — the LOCAL forward tangent this formula
    // rotates is now the reverse of what it used to be at every point, so
    // without this the pocket would offset outward instead of inward).
    const inw = (q) => ({ x: q.pos.x - sign * lineWidth * q.tan.y, y: q.pos.y + sign * lineWidth * q.tan.x });
    const E1o = inw(E1);
    const E2o = inw(E2);

    const raw = [{ x: A.pos.x, y: A.pos.y }];

    // Bezier: A -> pocket start (arriving in the pocket's travel direction).
    bezierPts(A.pos, A.tan, E1o, { x: sgn * E1.tan.x, y: sgn * E1.tan.y }, 32).forEach((p) =>
      raw.push({ x: p.x, y: p.y, isNew: true })
    );

    // Pocket arc, swept in the sgn direction from E1 to E2, offset inward.
    const steps = Math.max(8, Math.ceil((frac * s.perimeter) / 1.0));
    for (let i = 1; i < steps; i++) {
      const q = s.at(uE1 + sgn * (i / steps) * frac);
      const o = inw(q);
      raw.push({ x: o.x, y: o.y, isNew: true });
    }
    raw.push({ x: E2o.x, y: E2o.y, isNew: true });

    // Bezier: pocket end -> B (departing along the pocket's travel direction).
    const bz2 = bezierPts(E2o, { x: sgn * E2.tan.x, y: sgn * E2.tan.y }, B.pos, B.tan, 32);
    bz2.forEach((p, i) => raw.push({ x: p.x, y: p.y, isNew: i !== bz2.length - 1 }));

    // Tag each detour point with a u — NOT its position on the original
    // curve (it doesn't have one; it's a new point on a bezier through the
    // interior), but a perimeter-fraction between uA and uB, proportional to
    // how far along the detour's OWN path (by arc length, A to B) the point
    // sits. That gives the transition tween (see gcode.js) something
    // sensible to ease each point toward as the hanger washes back to the
    // plain wall — "where this point would be on the plain, uncut wall" —
    // and, critically, lets it look up plain-wall points by their real u
    // instead of by a generic resampled index, which is what kept the
    // hanger's tween from also perturbing wall the detour never touched.
    let cum = 0;
    const cumArr = [0];
    for (let i = 1; i < raw.length; i++) {
      cum += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y);
      cumArr.push(cum);
    }
    const total = cum || 1e-9;
    const pts = [];
    for (let i = 1; i < raw.length; i++) {
      pts.push({ x: raw[i].x, y: raw[i].y, isNew: raw[i].isNew, u: uA + (cumArr[i] / total) * (uB - uA) });
    }

    return { uA, uB, A, pts };
  }

  // Double-hanger variant: two independent, smaller keyhole funnels instead
  // of one large one. gapFrac (the same "gap %" input as the single-hanger)
  // now picks two GAP ANCHOR points at gapFrac/2 either side of u=0.5 — the
  // seam's OPPOSITE side, same as the single hanger's own gap, and for the
  // same reason: the spike/weave pattern is centered ON the seam, so keeping
  // the gap (the actually-removed material) on the far side is what keeps
  // the two from colliding. Each anchor gets its own gap of width
  // gapWidthMM (absolute, split evenly either side of the anchor), bridged
  // to a pocket of width pocketWidthMM centered at the mirrored point on the
  // seam side instead (gap1 near u=0.5+gapFrac/2 pockets near u=1-gapFrac/2,
  // gap2 near u=0.5-gapFrac/2 pockets near u=gapFrac/2) — same side as its
  // own gap, not diametrically opposite it (that would put the two hangers'
  // bridging beziers on interleaved chords, which always cross, for any
  // anchor spacing) — each its own self-contained funnel spanning roughly a
  // quarter of the perimeter.
  function buildDoubleHangerLoop(base, gapFrac, gapWidthMM, pocketWidthMM, lineWidth, dirSign) {
    const s = makeSampler(base);
    const n = base.length;
    const half = gapFrac / 2;
    const gHalf = gapWidthMM / 2 / s.perimeter;
    const pHalf = pocketWidthMM / 2 / s.perimeter;
    const d1 = buildMiniHangerLoop(base, 0.5 + half, gHalf, 1 - half, pHalf, lineWidth, dirSign);
    const d2 = buildMiniHangerLoop(base, 0.5 - half, gHalf, half, pHalf, lineWidth, dirSign);
    // Normalize to [0,1) and order by position along the curve so the wall
    // segments between/around them are walked correctly regardless of which
    // one the caller happened to build first.
    const wrap = (u) => ((u % 1) + 1) % 1;
    const dets = [
      { gStart: wrap(d1.uA), gEnd: wrap(d1.uB), A: d1.A, pts: d1.pts },
      { gStart: wrap(d2.uA), gEnd: wrap(d2.uB), A: d2.A, pts: d2.pts },
    ].sort((a, b) => a.gStart - b.gStart);

    const pts = [{ x: base[0].x, y: base[0].y, isNew: false, u: 0 }];
    let uCursor = 0;
    dets.forEach((det) => {
      for (let i = 1; i < n; i++) {
        const u = s.uOf(i);
        if (u <= uCursor || u >= det.gStart) continue;
        pts.push({ x: base[i].x, y: base[i].y, isNew: false, u: u });
      }
      pts.push({ x: det.A.pos.x, y: det.A.pos.y, isNew: false, u: det.gStart });
      pts.push(...det.pts);
      uCursor = det.gEnd;
    });
    for (let i = 1; i < n; i++) {
      const u = s.uOf(i);
      if (u > uCursor) pts.push({ x: base[i].x, y: base[i].y, isNew: false, u: u });
    }
    pts.push({ x: base[0].x, y: base[0].y, isNew: false, u: 1 });
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

  // Spoon project: a flat Archimedean spiral (pitch = one line width per
  // full turn, so adjacent arms sit edge to edge like a solid filled disc)
  // starting at startRadius (0 = a point at the center), out to
  // startRadius + turns*lineWidth after `turns` revolutions, then a straight
  // "stick" continuing stickLength mm past the last spiral point in the
  // RADIAL direction (straight away from center) — a ~90 deg turn away from
  // the spiral's own (mostly tangential) direction of travel there, same as
  // a lollipop's stick sticking straight out from the candy. Angular step is
  // sized off the OUTER radius (the sagitta/chord-tolerance formula already
  // used elsewhere for arcs), since that's where a fixed angular step has
  // the coarsest chord error.
  function spoonPath(turns, startRadius, lineWidth, stickLength, tolerance) {
    const pts = [];
    const t = Math.max(0, turns || 0);
    const r0 = Math.max(0, startRadius || 0);
    const lw = lineWidth > 0 ? lineWidth : 1;
    const totalAngle = t * 2 * Math.PI;
    const endRadius = r0 + t * lw;
    if (totalAngle > 1e-9) {
      const tol = tolerance > 0 ? tolerance : 0.05;
      const rStep = Math.max(endRadius, lw);
      const dth = 2 * Math.acos(Math.max(-1, 1 - tol / rStep));
      const steps = Math.max(8, Math.ceil(totalAngle / (isFinite(dth) && dth > 0 ? dth : 0.2)));
      for (let i = 0; i <= steps; i++) {
        const ang = (i / steps) * totalAngle;
        const r = r0 + (ang / (2 * Math.PI)) * lw;
        pts.push({ x: r * Math.cos(ang), y: r * Math.sin(ang) });
      }
    } else {
      pts.push({ x: r0, y: 0 });
    }
    if (stickLength > 0) {
      const last = pts[pts.length - 1];
      const r = Math.hypot(last.x, last.y) || 1e-6;
      const ux = last.x / r;
      const uy = last.y / r;
      pts.push({ x: last.x + ux * stickLength, y: last.y + uy * stickLength });
    }
    return pts;
  }

  // ---- Lampshade profile (the revolve curve, in r/z) ----
  // Built bottom-up in PRINT orientation: a straight throat, a tangent-arc
  // fillet, then a straight cone out to the bottom opening. `throatLen` is
  // the length of the FULL-diameter straight section that grips the socket —
  // the fillet is inserted ABOVE it, so the total height comes out as
  // throatLen + filletTangent + transitionH (the fillet lengthens the shade
  // rather than eating into the part that has to hold onto the lampholder).
  //
  // Returned as a DENSE (r, z, a) polyline — `a` = local wall angle from
  // vertical, in radians, signed (+ = flaring outward going up) — rather than
  // as an analytic description. Everything downstream only ever asks "what is
  // the radius and the local angle at this z", so future profile shapes
  // (bezier flares, spheres) can drop straight in by producing the same
  // polyline, without the generator or the compensation math changing at all.
  function lampProfile(p) {
    const rThroat = p.rThroat;
    const rBottom = p.rBottom;
    const throatLen = Math.max(0, p.throatLen);
    const transitionH = Math.max(1e-6, p.transitionH);
    const dr = rBottom - rThroat;
    const aCone = Math.atan2(Math.abs(dr), transitionH);
    const sgn = dr >= 0 ? 1 : -1;
    const warnings = [];

    const pts = [{ r: rThroat, z: 0, a: 0 }];
    if (throatLen > 1e-9) pts.push({ r: rThroat, z: throatLen, a: 0 });

    // No flare at all — a plain cylinder, nothing to fillet.
    if (aCone < 1e-6) {
      pts.push({ r: rBottom, z: throatLen + transitionH, a: 0 });
      return { pts: pts, angle: 0, fillet: 0, warnings: warnings };
    }

    // Fillet tangent length t = R*tan(a/2), inserted between the throat's top
    // and the cone's (virtual) corner. Clamped so the straight cone section
    // past the fillet can never vanish — t has to stay inside the cone's own
    // slant length.
    let R = Math.max(0, p.fillet || 0);
    const slant = transitionH / Math.cos(aCone);
    const maxR = (0.95 * slant) / Math.tan(aCone / 2);
    if (R > maxR) {
      R = maxR;
      warnings.push(
        'Fillet radius is too large for this transition height — clamped to ' + R.toFixed(1) + 'mm.'
      );
    }
    const t = R * Math.tan(aCone / 2);

    if (R > 1e-9) {
      // Arc centre sits one radius to the side of the throat wall, level with
      // the throat's top (which is the arc's lower tangent point).
      const cr = rThroat + sgn * R;
      const steps = Math.max(6, Math.ceil(aCone / 0.05));
      for (let i = 1; i <= steps; i++) {
        const phi = (aCone * i) / steps;
        pts.push({
          r: cr - sgn * R * Math.cos(phi),
          z: throatLen + R * Math.sin(phi),
          a: sgn * phi,
        });
      }
    } else {
      // Sharp corner: repeat the point with the cone's angle so the angle
      // steps discontinuously here instead of ramping across the cone.
      pts.push({ r: rThroat, z: throatLen, a: sgn * aCone });
    }
    pts.push({ r: rBottom, z: throatLen + t + transitionH, a: sgn * aCone });
    return { pts: pts, angle: sgn * aCone, fillet: R, warnings: warnings };
  }

  // Radius + local wall angle anywhere along a lampshade profile, by linear
  // interpolation between the two bracketing points (binary search, so it
  // stays cheap however dense the profile gets).
  function makeLampSampler(pts) {
    const n = pts.length;
    const top = pts[n - 1].z;
    return {
      height: top,
      at: function (z) {
        if (z <= pts[0].z) return { r: pts[0].r, a: pts[0].a };
        if (z >= top) return { r: pts[n - 1].r, a: pts[n - 1].a };
        let lo = 0;
        let hi = n - 1;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (pts[mid].z <= z) lo = mid;
          else hi = mid;
        }
        const A = pts[lo];
        const B = pts[hi];
        const span = B.z - A.z;
        if (span < 1e-9) return { r: B.r, a: B.a };
        const f = Math.max(0, Math.min(1, (z - A.z) / span));
        return { r: A.r + (B.r - A.r) * f, a: A.a + (B.a - A.a) * f };
      },
    };
  }

  // Mirror a profile top-to-bottom — print the wide rim on the bed instead of
  // the throat. Same wall and same angle magnitudes; it just leans inward
  // going up rather than outward.
  function flipLampProfile(pts) {
    const top = pts[pts.length - 1].z;
    const out = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      out.push({ r: pts[i].r, z: top - pts[i].z, a: -pts[i].a });
    }
    return out;
  }

  window.Geo = {
    bezierPts,
    buildHangerLoop,
    buildDoubleHangerLoop,
    stoolLoop,
    ringFill,
    lampProfile,
    makeLampSampler,
    flipLampProfile,
    rdpClosed,
    adaptiveShape,
    rotateToSeam,
    makeSampler,
    makeUSampler,
    makeShape,
    ensureCCW,
    reverseWinding,
    signedArea,
    perimeter,
    resampleClosed,
    offsetClosed,
    dist,
    roundedRectFillets,
    pointInPolygon,
    polylineSelfIntersects,
    spoonPath,
  };
})();
