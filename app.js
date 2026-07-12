/*
 * app.js — UI wiring.
 *
 * Live (cheap): show/hide shape fields + redraw the 2D cross-section preview.
 * On "Regenerate" (or Enter): validate inputs, generate G-code, redraw 3D preview.
 * Generation is NOT live — empty/zero fields can't crash or freeze it.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const num = (id) => parseFloat($(id).value);
  const isPos = (v) => Number.isFinite(v) && v > 0;

  let lastGcode = '';

  function activeProject() {
    return $('activeProject').value === 'bendstool' ? 'bendstool' : 'cordhanger';
  }

  // Shared card readers, parameterized by the project's input-id prefix so
  // each project keeps fully independent settings.
  function readPrinter(pre) {
    return {
      mode: $(pre + 'printerMode').value === 'filament' ? 'filament' : 'pellet',
      multiplier: num(pre + 'extrusionMultiplier'),
      includeStartEnd: $(pre + 'startEndEnabled').checked,
      filament: {
        diameter: num(pre + 'filDiameter'),
        nozzle: num(pre + 'filNozzleTemp'),
        bed: num(pre + 'filBedTemp'),
        fan: Math.max(0, Math.min(100, num(pre + 'filFan'))),
      },
      pellet: {
        up: num(pre + 'pelUpTemp'),
        mid: num(pre + 'pelMidTemp'),
        down: num(pre + 'pelDownTemp'),
        bed: num(pre + 'pelBedTemp'),
        pa: num(pre + 'pelPA'),
        purge: num(pre + 'pelPurge'),
        fan: Math.max(0, Math.min(100, num(pre + 'pelFan'))),
      },
    };
  }

  function readBrim(pre) {
    return {
      enabled: $(pre + 'brimEnabled').checked,
      outer: $(pre + 'brimOuter').value === 'outer',
      lines: Math.max(0, Math.round(num(pre + 'brimLines'))),
      lineWidth: num(pre + 'brimLineWidth'),
      layerHeight: num(pre + 'brimLayerHeight'),
      feed: num(pre + 'brimFeed'),
    };
  }

  function readConfig() {
    if (activeProject() === 'bendstool') {
      return {
        project: 'bendstool',
        printer: readPrinter('bs_'),
        layerHeight: num('bs_layerHeight'),
        lineWidth: num('bs_lineWidth'),
        printFeed: num('bs_printFeed'),
        travelFeed: num('bs_travelFeed'),
        tolerance: num('bs_tolerance'),
        centerX: num('bs_centerX'),
        centerY: num('bs_centerY'),
        disc: {
          diameter: num('bs_diameter'),
          layers: Math.max(1, Math.round(num('bs_layers'))),
          seamStyle: $('bs_seamStyle').value === 'alternating' ? 'alternating' : 'staircase',
          dome: num('bs_domeMult'),
          legs: {
            enabled: $('bs_legsEnabled').checked,
            seatHeight: num('bs_seatHeight'),
            width: num('bs_legWidth'),
            fillet: num('bs_legFillet'),
          },
          attractor: {
            enabled: $('bs_attrEnabled').checked,
            pos: num('bs_attrPos'),
            r1: num('bs_attrR1'),
            r2: num('bs_attrR2'),
            gap: num('bs_attrGap'),
            drop: num('bs_attrDrop'),
          },
        },
        brim: readBrim('bs_'),
      };
    }

    const shape = $('shape').value;
    const shapeParams = {
      circle: { radius: num('circle_radius') },
      roundedRect: {
        width: num('rect_width'),
        length: num('rect_length'),
        fillet: num('rect_fillet'),
      },
      ellipse: { rx: num('ellipse_rx'), ry: num('ellipse_ry') },
      polygon: { radius: num('poly_radius'), sides: num('poly_sides') },
      star: { outerR: num('star_outer'), innerR: num('star_inner'), points: num('star_points') },
      squircle: { size: num('sq_size'), n: num('sq_n') },
    }[shape];

    return {
      project: 'cordhanger',
      shape,
      shapeParams,
      printer: readPrinter(''),
      layerHeight: num('layerHeight'),
      lineWidth: num('lineWidth'),
      totalHeight: num('totalHeight'),
      printFeed: num('printFeed'),
      travelFeed: num('travelFeed'),
      tolerance: num('tolerance'),
      seamSide: $('seamSide').value,
      centerX: num('centerX'),
      centerY: num('centerY'),
      brim: readBrim(''),
      hanger: {
        enabled: $('hangEnabled').checked,
        size: num('hangSize'),
        pocket: num('hangPocket'),
        bottom: Math.max(1, Math.round(num('hangBottom'))),
        transition: Math.max(1, Math.round(num('hangTransition'))),
        bridgeFeed: num('hangBridgeFeed'),
      },
      pattern: {
        enabled: $('patternEnabled').checked,
        type: $('patternType').value,
        amplitude: num('patAmplitude'),
        zAngle: num('patZAngle'),
        coverage: num('patCoverage'),
        bumpFeed: num('patBumpFeed'),
        plBottom: Math.max(0, Math.round(num('patPlBottom'))),
        plTop: Math.max(0, Math.round(num('patPlTop'))),
        bumps: Math.max(1, Math.round(num('patBumps'))),
        count: Math.max(1, Math.round(num('patCount'))),
        seed: Math.max(0, Math.round(num('patSeed'))),
      },
    };
  }

  function validatePrinter(cfg) {
    if (!isPos(cfg.printer.multiplier)) return 'Extrusion multiplier must be greater than 0.';
    if (cfg.printer.mode === 'filament') {
      if (!isPos(cfg.printer.filament.diameter)) return 'Enter a valid filament diameter.';
      const f = cfg.printer.filament;
      if (!Number.isFinite(f.nozzle) || !Number.isFinite(f.bed) || !Number.isFinite(f.fan))
        return 'Enter valid filament temperatures / fan.';
    } else {
      const p = cfg.printer.pellet;
      if (
        !Number.isFinite(p.up) || !Number.isFinite(p.mid) || !Number.isFinite(p.down) ||
        !Number.isFinite(p.bed) || !Number.isFinite(p.pa) || !Number.isFinite(p.purge) ||
        !Number.isFinite(p.fan)
      )
        return 'Enter valid pellet zone/bed temps, pressure advance, purge and fan.';
    }
    return null;
  }

  function validateBrim(brim) {
    if (!brim.enabled) return null;
    if (brim.lines < 1) return 'Brim needs at least 1 line.';
    if (!isPos(brim.lineWidth)) return 'Enter a valid brim line width.';
    if (!isPos(brim.layerHeight)) return 'Enter a valid brim layer height.';
    if (!isPos(brim.feed)) return 'Enter a valid brim feedrate.';
    return null;
  }

  // Returns an error string if the config can't be generated, else null.
  function validate(cfg) {
    if (cfg.project === 'bendstool') {
      const basics = {
        'layer height': cfg.layerHeight,
        'line width': cfg.lineWidth,
        'print feed': cfg.printFeed,
        'travel feed': cfg.travelFeed,
        'chord tolerance': cfg.tolerance,
        'disc diameter': cfg.disc.diameter,
      };
      for (const name in basics) {
        if (!isPos(basics[name])) return 'Enter a valid ' + name + ' (must be greater than 0).';
      }
      if (!Number.isFinite(cfg.centerX) || !Number.isFinite(cfg.centerY))
        return 'Enter valid bed center X/Y.';
      if (cfg.disc.layers < 1) return 'Disc needs at least 1 layer.';
      if (!Number.isFinite(cfg.disc.dome) || cfg.disc.dome <= 0 || cfg.disc.dome > 1)
        return 'Dome multiplier must be between 0 and 1 (1 = flat).';
      if (cfg.disc.legs.enabled) {
        if (!isPos(cfg.disc.legs.seatHeight)) return 'Enter a valid seat height.';
        if (!isPos(cfg.disc.legs.width)) return 'Enter a valid leg width.';
        if (!Number.isFinite(cfg.disc.legs.fillet) || cfg.disc.legs.fillet < 0)
          return 'Enter a valid leg fillet (0 or more).';
        if (cfg.disc.attractor.enabled) {
          const a = cfg.disc.attractor;
          if (!Number.isFinite(a.pos)) return 'Enter a valid spread position.';
          if (!isPos(a.r1)) return 'Enter a valid full-spread radius R1.';
          if (!isPos(a.r2) || a.r2 <= a.r1) return 'Falloff radius R2 must be greater than R1.';
          if (!isPos(a.gap)) return 'Spread gap must be greater than 0.';
          if (!Number.isFinite(a.drop) || a.drop < 0 || a.drop > 1)
            return 'Overhang drop must be between 0 and 1.';
        }
      }
      return validatePrinter(cfg) || validateBrim(cfg.brim);
    }

    const checks = {
      'layer height': cfg.layerHeight,
      'line width': cfg.lineWidth,
      'total height': cfg.totalHeight,
      'print feed': cfg.printFeed,
      'travel feed': cfg.travelFeed,
    };
    for (const name in checks) {
      if (!isPos(checks[name])) return 'Enter a valid ' + name + ' (must be greater than 0).';
    }
    if (!Number.isFinite(cfg.centerX) || !Number.isFinite(cfg.centerY))
      return 'Enter valid bed center X/Y.';
    const pErr = validatePrinter(cfg);
    if (pErr) return pErr;
    if (!isPos(cfg.tolerance)) return 'Chord tolerance must be greater than 0.';
    for (const k in cfg.shapeParams) {
      const v = cfg.shapeParams[k];
      if (!Number.isFinite(v)) return 'Enter a valid value for ' + k + '.';
      if (k !== 'fillet' && v <= 0) return 'Shape value "' + k + '" must be greater than 0.';
    }
    const bErr = validateBrim(cfg.brim);
    if (bErr) return bErr;
    if (cfg.hanger.enabled) {
      if (!isPos(cfg.hanger.size) || cfg.hanger.size > 45)
        return 'Hanger gap must be between 1 and 45% of the outline.';
      if (!isPos(cfg.hanger.pocket) || cfg.hanger.pocket > 45)
        return 'Hanger pocket must be between 1 and 45% of the outline.';
      if (!isPos(cfg.hanger.bridgeFeed)) return 'Enter a valid hanger bridge feedrate.';
    }
    if (cfg.pattern.enabled) {
      if (!Number.isFinite(cfg.pattern.amplitude)) return 'Enter a valid pattern amplitude.';
      if (!Number.isFinite(cfg.pattern.zAngle)) return 'Enter a valid Z-angle.';
      if (!Number.isFinite(cfg.pattern.coverage)) return 'Enter a valid pattern coverage %.';
      if (!isPos(cfg.pattern.bumpFeed)) return 'Enter a valid bump feedrate.';
      if (cfg.pattern.type === 'weave' && cfg.pattern.bumps < 1)
        return 'Weave needs at least 1 bump per revolution.';
      if (cfg.pattern.type === 'spikes' && cfg.pattern.count < 1)
        return 'Spikes need at least 1 point.';
    }
    return null;
  }

  function showShapeParams(shape) {
    document.querySelectorAll('.shape-params').forEach((el) => {
      el.hidden = el.getAttribute('data-shape') !== shape;
    });
  }

  function syncPrinterCards() {
    [
      ['printerMode', 'printer-params', 'printerHint'],
      ['bs_printerMode', 'printer-params-bs', 'bs_printerHint'],
    ].forEach(([selId, cls, hintId]) => {
      const sel = $(selId);
      if (!sel) return;
      const mode = sel.value === 'filament' ? 'filament' : 'pellet';
      document.querySelectorAll('.' + cls).forEach((el) => {
        el.hidden = el.getAttribute('data-mode') !== mode;
      });
      $(hintId).textContent =
        mode === 'filament'
          ? 'E = mm of filament (volume ÷ filament cross-section) · Marlin start/end for the P1P'
          : 'E = pure volume in mm³ · Klipper start/end with the GINGER pellet macros';
    });
  }

  function showProject(p) {
    document.querySelectorAll('.card[data-project]').forEach((el) => {
      el.hidden = el.getAttribute('data-project') !== p;
    });
    $('tabCordhanger').classList.toggle('active', p === 'cordhanger');
    $('tabBendstool').classList.toggle('active', p === 'bendstool');
  }

  function showPatternParams(type) {
    document.querySelectorAll('.pattern-params').forEach((el) => {
      el.hidden = el.getAttribute('data-pattern') !== type;
    });
    $('patternHint').textContent =
      type === 'spikes'
        ? 'Spikes: blue-noise outward pokes, base width = line width. Change seed to re-roll.'
        : 'Weave: even bumps/rev = flutes · odd = woven';
  }

  // --- Live 2D previews ---
  function drawPreview(cfg) {
    if (cfg.project === 'bendstool') {
      drawPreviewBS(cfg);
      return;
    }
    const canvas = $('preview');
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const sf = W / 600; // stroke scale so lines look the same at any backing resolution

    let base;
    try {
      base = window.Geo.rotateToSeam(
        window.Geo.adaptiveShape(cfg.shape, cfg.shapeParams, isPos(cfg.tolerance) ? cfg.tolerance : 0.05),
        cfg.seamSide
      );
    } catch (e) {
      return;
    }
    if (!base.length || !Number.isFinite(base[0].x)) return;

    const loops = [base];
    if (cfg.brim.enabled && cfg.brim.lines > 0 && isPos(cfg.brim.lineWidth)) {
      const dir = cfg.brim.outer ? 1 : -1;
      for (let k = 1; k <= cfg.brim.lines; k++) {
        const d = cfg.brim.lineWidth / 2 + cfg.lineWidth / 2 + (k - 1) * cfg.brim.lineWidth;
        loops.push(window.Geo.offsetClosed(base, dir * d));
      }
    }

    // Hanger loop overlay (dashed) — computed here so it's part of the bounds.
    let hangerLoop = null;
    if (
      cfg.hanger && cfg.hanger.enabled &&
      isPos(cfg.hanger.size) && cfg.hanger.size <= 45 &&
      isPos(cfg.hanger.pocket) && cfg.hanger.pocket <= 45 && isPos(cfg.lineWidth)
    ) {
      try {
        hangerLoop = window.Geo.buildHangerLoop(
          base, cfg.hanger.size / 100, cfg.hanger.pocket / 100, cfg.lineWidth
        );
      } catch (e) {
        hangerLoop = null;
      }
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const boundLoops = hangerLoop ? loops.concat([hangerLoop]) : loops;
    boundLoops.forEach((loop) =>
      loop.forEach((p) => {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      })
    );
    if (!Number.isFinite(minX)) return;

    const pad = 30 * sf;
    const scale = Math.min((W - 2 * pad) / (maxX - minX || 1), (H - 2 * pad) / (maxY - minY || 1));
    const ox = (minX + maxX) / 2;
    const oy = (minY + maxY) / 2;
    const tx = (p) => W / 2 + (p.x - ox) * scale;
    const ty = (p) => H / 2 - (p.y - oy) * scale;

    function stroke(loop, color, width, close) {
      ctx.beginPath();
      loop.forEach((p, i) => (i === 0 ? ctx.moveTo(tx(p), ty(p)) : ctx.lineTo(tx(p), ty(p))));
      if (close) ctx.closePath();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    }
    for (let k = 1; k < loops.length; k++) stroke(loops[k], '#2bd9a0', 1.5 * sf, true);
    stroke(base, '#4f9dff', 2.5 * sf, true);

    if (hangerLoop) {
      ctx.setLineDash([6 * sf, 4 * sf]);
      stroke(hangerLoop, '#ffb454', 1.8 * sf, false);
      ctx.setLineDash([]);
    }

    // Seam marker (also the pattern center) as a dot.
    const seam = base[0];
    ctx.beginPath();
    ctx.arc(tx(seam), ty(seam), 7 * sf, 0, 2 * Math.PI);
    ctx.fillStyle = '#ff5252';
    ctx.fill();
    ctx.lineWidth = 2 * sf;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  }

  // Bend stool: rings (+ legs) with the staircase seam, via the shared spec.
  function drawPreviewBS(cfg) {
    const canvas = $('previewBS');
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const sf = W / 600;

    const lw = cfg.lineWidth;
    if (!isPos(lw) || !isPos(cfg.disc.diameter)) {
      $('bs_discHint').textContent = 'Enter a valid diameter and line width.';
      return;
    }
    const spec = window.GcodeGen.discSpec(cfg);
    const n = spec.ringN;
    const legs = spec.legs;
    let hint =
      'Snapped to Ø' + spec.snappedD + ' mm · ' + n + ' ring' + (n > 1 ? 's' : '') + ' of ' + lw + ' mm';
    if (legs) hint += ' · legs ' + legs.snappedW + ' mm wide (' + legs.m + ' pair' + (legs.m > 1 ? 's' : '') + ')';
    if (Number.isFinite(cfg.disc.dome) && cfg.disc.dome < 1 && cfg.disc.layers > 1) {
      const T = cfg.disc.layers;
      hint += ' · dome: top z ' + (cfg.layerHeight * (1 + (T - 1) * cfg.disc.dome)).toFixed(1) +
        ' center / ' + (cfg.layerHeight * T).toFixed(1) + ' edge';
    }
    if (legs && cfg.disc.attractor.enabled && isPos(cfg.disc.attractor.gap)) {
      const T = cfg.disc.layers;
      if (T > 1) {
        const dMax = ((2 * (legs.m - 1) + 1) * cfg.disc.attractor.gap * lw) / 2;
        const stepLat = dMax / (T - 1);
        const ang = (Math.atan2(stepLat, cfg.layerHeight) * 180) / Math.PI;
        const drop = Math.max(0, Math.min(1, cfg.disc.attractor.drop || 0));
        hint += ' · max overhang ' + ang.toFixed(1) + '° (' + stepLat.toFixed(2) + ' mm/layer, squeezed step ' +
          (cfg.layerHeight * (1 - drop)).toFixed(2) + ' mm)';
      } else {
        hint += ' · 1 layer: no gradient/drop';
      }
    }
    if (cfg.disc.legs && cfg.disc.legs.enabled && !legs) hint += ' · ' + (spec.warnings[spec.warnings.length - 1] || 'legs invalid');
    $('bs_discHint').textContent = hint;

    let maxR = spec.snappedD / 2;
    if (legs) maxR = n * lw + cfg.disc.legs.seatHeight;
    let brimExtent = 0;
    if (cfg.brim.enabled && cfg.brim.outer && cfg.brim.lines > 0 && isPos(cfg.brim.lineWidth)) {
      brimExtent = cfg.brim.lineWidth / 2 + lw / 2 + (cfg.brim.lines - 1) * cfg.brim.lineWidth + cfg.brim.lineWidth / 2;
    }
    maxR += brimExtent;
    const pad = 20 * sf;
    const scale = (Math.min(W, H) / 2 - pad) / (maxR || 1);
    const cxp = W / 2;
    const cyp = H / 2;
    const tol = isPos(cfg.tolerance) ? cfg.tolerance : 0.05;

    function strokePoly(pts, close) {
      ctx.beginPath();
      pts.forEach((p, i) => {
        const X = cxp + p.x * scale;
        const Y = cyp - p.y * scale;
        if (i === 0) ctx.moveTo(X, Y);
        else ctx.lineTo(X, Y);
      });
      if (close) ctx.closePath();
      ctx.stroke();
    }

    const dl = window.GcodeGen.discLoops(cfg, spec);

    // Brim (dashed): offsets of the outermost outline (legs + spread included).
    if (brimExtent > 0) {
      ctx.setLineDash([5 * sf, 4 * sf]);
      ctx.strokeStyle = '#2bd9a0';
      ctx.lineWidth = 1.2 * sf;
      for (let k = 1; k <= cfg.brim.lines; k++) {
        const d = cfg.brim.lineWidth / 2 + lw / 2 + (k - 1) * cfg.brim.lineWidth;
        strokePoly(window.Geo.offsetClosed(dl.outline, d), true);
      }
      ctx.setLineDash([]);
    }

    // Attractor points + their R1/R2 circles (bend-zone spread).
    if (legs && cfg.disc.attractor.enabled && isPos(cfg.disc.attractor.r1)) {
      const at = cfg.disc.attractor;
      const A = n * lw + (Number.isFinite(at.pos) ? at.pos : 0);
      ctx.setLineDash([3 * sf, 3 * sf]);
      window.GcodeGen.LEG_ANGLES.forEach((phi) => {
        const ax = cxp + A * Math.cos(phi) * scale;
        const ay = cyp - A * Math.sin(phi) * scale;
        ctx.strokeStyle = 'rgba(255,82,82,0.8)';
        ctx.lineWidth = 1 * sf;
        ctx.beginPath();
        ctx.arc(ax, ay, at.r1 * scale, 0, 2 * Math.PI);
        ctx.stroke();
        if (isPos(at.r2) && at.r2 > at.r1) {
          ctx.strokeStyle = 'rgba(255,82,82,0.35)';
          ctx.beginPath();
          ctx.arc(ax, ay, at.r2 * scale, 0, 2 * Math.PI);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.fillStyle = '#ff5252';
        ctx.beginPath();
        ctx.arc(ax, ay, 3.5 * sf, 0, 2 * Math.PI);
        ctx.fill();
        ctx.setLineDash([3 * sf, 3 * sf]);
      });
      ctx.setLineDash([]);
    }

    // Rings (+ legs) in the selected seam style, exactly as the generator
    // builds them; connectors drawn in orange.
    const loops = dl.loops;
    let prevEnd = null;
    ctx.lineWidth = 1.8 * sf;
    for (let i = 0; i < loops.length; i++) {
      const pts = loops[i];
      if (prevEnd) {
        ctx.strokeStyle = '#ffb454';
        ctx.beginPath();
        ctx.moveTo(cxp + prevEnd.x * scale, cyp - prevEnd.y * scale);
        ctx.lineTo(cxp + pts[0].x * scale, cyp - pts[0].y * scale);
        ctx.stroke();
      }
      ctx.strokeStyle = '#4f9dff';
      strokePoly(pts, false);
      prevEnd = pts[pts.length - 1];
    }
  }

  // --- 3D toolpath viewer ---
  // One finger: orbit. Two fingers: pinch to zoom + pan. Double-tap: reset
  // zoom/pan. Mouse wheel zooms too. The camera fit is computed once per
  // regenerate (bounding radius), then stays constant while orbiting.
  const View3D = (function () {
    let canvas, ctx;
    let pts = [];
    let az = -0.6;
    let el = 0.5; // 0 = side view, PI/2 = top view
    let center = { x: 0, y: 0, z: 0 };
    let radius = 1; // bounding radius; zoom-to-fit is derived from it per render
    let feedMin = 0, feedMax = 1;
    const NB = 18; // color buckets for batched stroking

    let userZoom = 1;
    let panX = 0, panY = 0; // in canvas pixels
    const pointers = new Map();
    let lastX = 0, lastY = 0; // single-pointer orbit
    let pinch = null; // { dist, zoom, cx, cy, panX, panY }
    let lastTap = { t: 0, x: 0, y: 0 };

    function cssToCanvas(e) {
      const r = canvas.getBoundingClientRect();
      const k = canvas.width / (r.width || 1);
      return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
    }

    function init() {
      canvas = $('preview3d');
      ctx = canvas.getContext('2d');

      canvas.addEventListener('pointerdown', (e) => {
        canvas.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 1) {
          lastX = e.clientX;
          lastY = e.clientY;
          // double-tap reset
          const now = Date.now();
          if (now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
            userZoom = 1;
            panX = 0;
            panY = 0;
            render();
          }
          lastTap = { t: now, x: e.clientX, y: e.clientY };
        } else if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          pinch = {
            dist: Math.hypot(b.x - a.x, b.y - a.y) || 1,
            zoom: userZoom,
            cx: (a.x + b.x) / 2,
            cy: (a.y + b.y) / 2,
            panX: panX,
            panY: panY,
          };
        }
      });

      canvas.addEventListener('pointermove', (e) => {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2 && pinch) {
          const [a, b] = [...pointers.values()];
          const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
          userZoom = Math.max(0.2, Math.min(40, (pinch.zoom * dist) / pinch.dist));
          const cx = (a.x + b.x) / 2;
          const cy = (a.y + b.y) / 2;
          const k = canvas.width / (canvas.getBoundingClientRect().width || 1);
          panX = pinch.panX + (cx - pinch.cx) * k;
          panY = pinch.panY + (cy - pinch.cy) * k;
          e.preventDefault();
          render();
        } else if (pointers.size === 1) {
          az += (e.clientX - lastX) * 0.01;
          el += (e.clientY - lastY) * 0.01;
          el = Math.max(0, Math.min(Math.PI / 2, el));
          lastX = e.clientX;
          lastY = e.clientY;
          e.preventDefault();
          render();
        }
      });

      const drop = (e) => {
        pointers.delete(e.pointerId);
        if (pointers.size < 2) pinch = null;
        if (pointers.size === 1) {
          const p = [...pointers.values()][0];
          lastX = p.x;
          lastY = p.y;
        }
      };
      canvas.addEventListener('pointerup', drop);
      canvas.addEventListener('pointercancel', drop);

      canvas.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault();
          userZoom = Math.max(0.2, Math.min(40, userZoom * Math.exp(-e.deltaY * 0.0015)));
          render();
        },
        { passive: false }
      );
    }

    function setPath(path) {
      pts = path.slice();
      if (pts.length < 2) {
        render();
        return;
      }
      // Bounding box center + radius -> fixed scale (rotation-invariant).
      let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
      let fMin = Infinity, fMax = -Infinity;
      for (const p of pts) {
        if (p.x < mnx) mnx = p.x; if (p.x > mxx) mxx = p.x;
        if (p.y < mny) mny = p.y; if (p.y > mxy) mxy = p.y;
        if (p.z < mnz) mnz = p.z; if (p.z > mxz) mxz = p.z;
        if (!p.travel && p.feed != null) {
          if (p.feed < fMin) fMin = p.feed;
          if (p.feed > fMax) fMax = p.feed;
        }
      }
      center = { x: (mnx + mxx) / 2, y: (mny + mxy) / 2, z: (mnz + mxz) / 2 };
      radius = 0;
      for (const p of pts) {
        const d = Math.hypot(p.x - center.x, p.y - center.y, p.z - center.z);
        if (d > radius) radius = d;
      }
      feedMin = Number.isFinite(fMin) ? fMin : 0;
      feedMax = Number.isFinite(fMax) ? fMax : 1;
      render();
    }

    // Z-up orthographic projection. Fit scale × user zoom, plus user pan.
    function project(p, scale) {
      const X = p.x - center.x, Y = p.y - center.y, Z = p.z - center.z;
      const ca = Math.cos(az), sa = Math.sin(az);
      const x1 = X * ca - Y * sa;
      const y1 = X * sa + Y * ca; // depth toward camera
      const ce = Math.cos(el), se = Math.sin(el);
      const sxp = x1;
      const syp = Z * ce - y1 * se; // +Z up; tilt mixes in depth
      return {
        x: canvas.width / 2 + panX + sxp * scale,
        y: canvas.height / 2 + panY - syp * scale,
      };
    }

    // Blue (fast) -> red (slow). bucket 0 = fastest.
    function bucketColor(b) {
      const t = NB <= 1 ? 0 : b / (NB - 1);
      const hue = 240 * (1 - t); // 240 blue -> 0 red
      return 'hsl(' + hue.toFixed(0) + ',85%,55%)';
    }
    function feedBucket(f) {
      if (feedMax <= feedMin) return 0;
      let t = (f - feedMin) / (feedMax - feedMin);
      t = Math.max(0, Math.min(1, t));
      return Math.round((1 - t) * (NB - 1)); // fast(high feed) -> bucket 0
    }

    function render() {
      if (!ctx) return;
      const W = canvas.width, H = canvas.height;
      const sf = W / 600;
      ctx.clearRect(0, 0, W, H);
      if (pts.length < 2) return;
      const scale = ((Math.min(W, H) / 2 - 18 * sf) / (radius || 1)) * userZoom;
      const proj = pts.map((p) => project(p, scale));

      // Travels first, faint.
      ctx.beginPath();
      for (let i = 1; i < pts.length; i++) {
        if (!pts[i].travel) continue;
        ctx.moveTo(proj[i - 1].x, proj[i - 1].y);
        ctx.lineTo(proj[i].x, proj[i].y);
      }
      ctx.strokeStyle = 'rgba(154,163,178,0.22)';
      ctx.lineWidth = 1 * sf;
      ctx.stroke();

      // Extrusions, batched by feed-color bucket.
      const buckets = [];
      for (let b = 0; b < NB; b++) buckets.push([]);
      for (let i = 1; i < pts.length; i++) {
        if (pts[i].travel) continue;
        buckets[feedBucket(pts[i].feed != null ? pts[i].feed : feedMax)].push(i);
      }
      for (let b = 0; b < NB; b++) {
        if (!buckets[b].length) continue;
        ctx.beginPath();
        for (const i of buckets[b]) {
          ctx.moveTo(proj[i - 1].x, proj[i - 1].y);
          ctx.lineTo(proj[i].x, proj[i].y);
        }
        ctx.strokeStyle = bucketColor(b);
        ctx.lineWidth = 1.2 * sf;
        ctx.stroke();
      }
    }

    return { init, setPath, render };
  })();

  // --- Live update (cheap) ---
  function syncCards(cfg) {
    if (cfg.project === 'cordhanger') {
      showShapeParams(cfg.shape);
      showPatternParams(cfg.pattern.type);
    }
    syncPrinterCards();
  }

  function updateShapeUI() {
    const cfg = readConfig();
    syncCards(cfg);
    drawPreview(cfg);
    saveLocal();
  }

  // --- Generate (button / Enter) ---
  function regenerate() {
    const cfg = readConfig();
    syncCards(cfg);
    drawPreview(cfg);

    const err = validate(cfg);
    if (err) {
      showWarnings([err], true);
      $('stats').textContent = '';
      return;
    }

    let result;
    try {
      result = window.GcodeGen.generate(cfg);
    } catch (e) {
      showWarnings(['Generation error: ' + e.message], true);
      return;
    }

    lastGcode = result.gcode;
    $('output').value = result.gcode;
    View3D.setPath(result.path || []);

    const s = result.stats;
    $('stats').textContent =
      Math.round(s.loops) + ' loops · ' + s.moves + ' moves · ' +
      s.volume.toFixed(0) + ' mm³ · ' + (s.pathLength / 1000).toFixed(1) + ' m path' +
      (s.timeMin > 0 ? ' · ~' + fmtTime(s.timeMin) : '');

    showWarnings(result.warnings, false);
  }

  function showWarnings(list, isError) {
    const warn = $('warnings');
    warn.innerHTML = '';
    const all = (list || []).slice();
    if (!storageOk) {
      all.unshift(
        'Settings cannot be auto-saved on this device (browser storage is blocked). ' +
          'They will reset if the app reloads — use "Save settings" to keep a file, ' +
          'and check Safari settings (e.g. "Block All Cookies").'
      );
    }
    all.forEach((w) => {
      const d = document.createElement('div');
      d.textContent = '⚠ ' + w;
      warn.appendChild(d);
    });
  }

  // --- Export ---
  function filename() {
    return 'vase_' + $('shape').value + '_' + Date.now() + '.gcode';
  }
  function download() {
    const blob = new Blob([lastGcode], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename();
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  async function share() {
    const file = new File([lastGcode], filename(), { type: 'text/plain' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Vase G-code' });
        return;
      } catch (e) {
        /* cancelled / unsupported — fall through */
      }
    }
    download();
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(lastGcode);
    } catch (e) {
      $('output').select();
      document.execCommand('copy');
    }
    flash($('copyBtn'), 'Copied!');
  }
  function flash(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(() => (btn.textContent = old), 1200);
  }

  function fmtTime(min) {
    if (min < 60) return Math.max(1, Math.round(min)) + ' min';
    const h = Math.floor(min / 60);
    return h + 'h ' + Math.round(min - h * 60) + 'm';
  }

  // Size canvas backing stores to the displayed size × devicePixelRatio so
  // lines are crisp on retina screens (drawing code scales strokes via W/600).
  function fitCanvases() {
    ['preview', 'previewBS', 'preview3d'].forEach((id) => {
      const c = $(id);
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const w = c.clientWidth || 600;
      // Cap the backing store so a canvas can never feed back into its own
      // layout size and grow without bound (belt-and-braces vs missing CSS).
      const px = Math.min(1600, Math.round(w * dpr));
      if (px > 0 && c.width !== px) {
        c.width = px;
        c.height = px;
      }
    });
  }

  // --- Settings preset: save/load JSON + auto-persist to localStorage ---
  const STORAGE_KEY = 'easygcode-settings';
  const BACKUP_KEY = STORAGE_KEY + '-backup';
  let storageOk = true; // false when the browser blocks script storage

  function collectSettings() {
    const out = {};
    document.querySelectorAll('input, select').forEach((el) => {
      if (!el.id || el.type === 'file') return;
      out[el.id] = el.type === 'checkbox' ? el.checked : el.value;
    });
    return out;
  }

  function applySettings(s) {
    if (!s || typeof s !== 'object') return;
    Object.keys(s).forEach((id) => {
      const el = document.getElementById(id);
      if (!el || el.type === 'file') return;
      if (el.type === 'checkbox') el.checked = !!s[id];
      else el.value = s[id];
    });
    // Sync groups whose checkboxes were set programmatically (no change event).
    $('brimFields').hidden = !$('brimEnabled').checked;
    $('patternFields').hidden = !$('patternEnabled').checked;
    $('hangFields').hidden = !$('hangEnabled').checked;
    $('bs_brimFields').hidden = !$('bs_brimEnabled').checked;
    $('bs_legFields').hidden = !$('bs_legsEnabled').checked;
    showProject(activeProject());
  }

  // First run after the tabs update: seed the bend stool's generic settings
  // (print, printer/material, brim) from the cord hanger's current values so
  // both projects start from the same place but stay independent afterwards.
  const SEED_MAP = {
    layerHeight: 'bs_layerHeight', lineWidth: 'bs_lineWidth',
    printFeed: 'bs_printFeed', travelFeed: 'bs_travelFeed',
    tolerance: 'bs_tolerance', centerX: 'bs_centerX', centerY: 'bs_centerY',
    printerMode: 'bs_printerMode', extrusionMultiplier: 'bs_extrusionMultiplier',
    startEndEnabled: 'bs_startEndEnabled',
    filDiameter: 'bs_filDiameter', filNozzleTemp: 'bs_filNozzleTemp',
    filBedTemp: 'bs_filBedTemp', filFan: 'bs_filFan',
    pelUpTemp: 'bs_pelUpTemp', pelMidTemp: 'bs_pelMidTemp', pelDownTemp: 'bs_pelDownTemp',
    pelBedTemp: 'bs_pelBedTemp', pelPA: 'bs_pelPA', pelPurge: 'bs_pelPurge', pelFan: 'bs_pelFan',
    brimEnabled: 'bs_brimEnabled', brimOuter: 'bs_brimOuter', brimLines: 'bs_brimLines',
    brimLineWidth: 'bs_brimLineWidth', brimLayerHeight: 'bs_brimLayerHeight', brimFeed: 'bs_brimFeed',
  };

  function seedBendstool() {
    Object.keys(SEED_MAP).forEach((src) => {
      const a = $(src);
      const b = $(SEED_MAP[src]);
      if (!a || !b) return;
      if (a.type === 'checkbox') b.checked = a.checked;
      else b.value = a.value;
    });
    $('bs_brimFields').hidden = !$('bs_brimEnabled').checked;
  }

  // Double-buffered save: the previous good state is kept under a backup key,
  // so a save interrupted by an iOS page eviction can't corrupt everything.
  function saveLocal() {
    try {
      const data = JSON.stringify(collectSettings());
      const prev = localStorage.getItem(STORAGE_KEY);
      if (prev && prev !== data) localStorage.setItem(BACKUP_KEY, prev);
      localStorage.setItem(STORAGE_KEY, data);
      storageOk = true;
    } catch (e) {
      storageOk = false;
    }
  }

  function restoreLocal() {
    let stored = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      storageOk = false;
      return null;
    }
    try {
      if (stored) {
        const parsed = JSON.parse(stored);
        applySettings(parsed);
        return parsed;
      }
    } catch (e) {
      /* main copy corrupt — fall through to backup */
    }
    try {
      const backup = localStorage.getItem(BACKUP_KEY);
      if (backup) {
        const parsed = JSON.parse(backup);
        applySettings(parsed);
        return parsed;
      }
    } catch (e) {
      /* backup unusable too — start from defaults */
    }
    return null;
  }

  function exportSettings() {
    const data = JSON.stringify({ app: 'easygcode', version: 1, settings: collectSettings() }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'easygcode-settings-' + Date.now() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    flash($('saveSettingsBtn'), 'Saved!');
  }

  function importSettings(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        applySettings(parsed && parsed.settings ? parsed.settings : parsed);
        saveLocal();
        updateShapeUI();
        regenerate();
        flash($('loadSettingsBtn'), 'Loaded!');
      } catch (e) {
        flash($('loadSettingsBtn'), 'Bad file');
      }
    };
    reader.readAsText(file);
  }

  // --- Wire up ---
  View3D.init();

  document.querySelectorAll('input, select').forEach((el) => {
    el.addEventListener('input', updateShapeUI);
    el.addEventListener('change', updateShapeUI);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        el.blur();
        regenerate();
      }
    });
  });

  $('brimEnabled').addEventListener('change', () => {
    $('brimFields').hidden = !$('brimEnabled').checked;
    updateShapeUI();
  });

  $('patternEnabled').addEventListener('change', () => {
    $('patternFields').hidden = !$('patternEnabled').checked;
    updateShapeUI();
  });

  $('hangEnabled').addEventListener('change', () => {
    $('hangFields').hidden = !$('hangEnabled').checked;
    updateShapeUI();
  });

  $('bs_brimEnabled').addEventListener('change', () => {
    $('bs_brimFields').hidden = !$('bs_brimEnabled').checked;
    updateShapeUI();
  });

  $('bs_legsEnabled').addEventListener('change', () => {
    $('bs_legFields').hidden = !$('bs_legsEnabled').checked;
    updateShapeUI();
  });

  function switchProject(p) {
    $('activeProject').value = p;
    showProject(p);
    fitCanvases();
    updateShapeUI();
    regenerate();
  }
  $('tabCordhanger').addEventListener('click', () => switchProject('cordhanger'));
  $('tabBendstool').addEventListener('click', () => switchProject('bendstool'));

  $('regenBtn').addEventListener('click', regenerate);
  $('copyBtn').addEventListener('click', copy);
  $('downloadBtn').addEventListener('click', download);
  $('shareBtn').addEventListener('click', share);

  $('saveSettingsBtn').addEventListener('click', exportSettings);
  $('loadSettingsBtn').addEventListener('click', () => $('settingsFile').click());
  $('settingsFile').addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) importSettings(e.target.files[0]);
    e.target.value = '';
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  // iOS shows the numeric keypad for inputmode=decimal.
  document.querySelectorAll('input[type="number"]').forEach((el) => {
    el.setAttribute('inputmode', 'decimal');
    el.setAttribute('autocomplete', 'off');
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      fitCanvases();
      updateShapeUI();
      View3D.render();
    }, 150);
  });

  // Persist when the app is backgrounded or the page is being torn down —
  // iOS home-screen web apps reload freely, so never rely on the DOM surviving.
  window.addEventListener('pagehide', saveLocal);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveLocal();
  });

  // Restore last-used settings (with backup fallback); seed the bend stool's
  // generic settings from the cord hanger the first time after the tabs update.
  const restored = restoreLocal();
  if (restored && !('bs_layerHeight' in restored)) seedBendstool();
  showProject(activeProject());
  fitCanvases();
  updateShapeUI();
  regenerate();
})();
