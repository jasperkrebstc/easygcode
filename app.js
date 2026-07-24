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
    const v = $('activeProject').value;
    return v === 'bendstool' || v === 'vessel' ? v : 'cordhanger';
  }

  // Read a shape select + its params for the given input-id prefix ('' for the
  // coat hanger, 've_' for the vessel) so both share one shape model.
  function readShape(pre) {
    const shape = $(pre + 'shape').value;
    const shapeParams = {
      circle: { radius: num(pre + 'circle_radius') },
      roundedRect: {
        width: num(pre + 'rect_width'),
        length: num(pre + 'rect_length'),
        fillet: num(pre + 'rect_fillet'),
      },
      ellipse: { rx: num(pre + 'ellipse_rx'), ry: num(pre + 'ellipse_ry') },
      polygon: { radius: num(pre + 'poly_radius'), sides: num(pre + 'poly_sides') },
      star: { outerR: num(pre + 'star_outer'), innerR: num(pre + 'star_inner'), points: num(pre + 'star_points') },
      squircle: { size: num(pre + 'sq_size'), n: num(pre + 'sq_n') },
    }[shape];
    return { shape: shape, shapeParams: shapeParams };
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
      outerStyle: $(pre + 'brimOuterStyle').value === 'mouseEar' ? 'mouseEar' : 'normal',
      linesOuter: Math.max(0, Math.round(num(pre + 'brimLinesOuter'))),
      linesInner: Math.max(0, Math.round(num(pre + 'brimLinesInner'))),
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
          foam: {
            enabled: $('bs_foamEnabled').checked,
            tempUp: num('bs_foamTempUp'),
            tempMid: num('bs_foamTempMid'),
            tempDown: num('bs_foamTempDown'),
            extrusionPct: num('bs_foamExtrusionPct'),
            primer1: {
              length: num('bs_primer1Length'),
              lineWidth: num('bs_primer1Width'),
              layerHeight: num('bs_primer1LayerHeight'),
              feed: num('bs_primer1Feed'),
            },
            primer2: {
              length: num('bs_primer2Length'),
              lineWidth: num('bs_primer2Width'),
              layerHeight: num('bs_primer2LayerHeight'),
              feed: num('bs_primer2Feed'),
            },
          },
          flowFeed: {
            enabled: $('bs_flowFeedEnabled').checked,
            rate: num('bs_flowFeedRate'),
          },
        },
        brim: readBrim('bs_'),
      };
    }

    if (activeProject() === 'vessel') {
      const vs = readShape('ve_');
      return {
        project: 'vessel',
        printer: readPrinter('ve_'),
        layerHeight: num('ve_layerHeight'),
        lineWidth: num('ve_lineWidth'),
        printFeed: num('ve_printFeed'),
        travelFeed: num('ve_travelFeed'),
        tolerance: num('ve_tolerance'),
        seamSide: $('ve_seamSide').value,
        centerX: num('ve_centerX'),
        centerY: num('ve_centerY'),
        shape: vs.shape,
        shapeParams: vs.shapeParams,
        vessel: {
          height: num('ve_height'),
          bottomLayers: Math.max(0, Math.round(num('ve_bottomLayers'))),
          seamStyle: ['alternating', 'spiral'].indexOf($('ve_seamStyle').value) >= 0 ? $('ve_seamStyle').value : 'staircase',
          topStyle: $('ve_topStyle').value === 'spiral' ? 'spiral' : 'flat',
          bottom: num('ve_profBottom'),
          midH: num('ve_profMidH'),
          mid: num('ve_profMid'),
          top: num('ve_profTop'),
        },
        brim: readBrim('ve_'),
      };
    }

    const cs = readShape('');
    return {
      project: 'cordhanger',
      shape: cs.shape,
      shapeParams: cs.shapeParams,
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
      fanMode: $('fanMode').value === 'bumps' ? 'bumps' : 'always',
      brim: readBrim(''),
      hanger: {
        enabled: $('hangEnabled').checked,
        size: num('hangSize'),
        pocket: num('hangPocket'),
        bottom: Math.max(1, Math.round(num('hangBottom'))),
        transition: Math.max(1, Math.round(num('hangTransition'))),
        bridgeFeed: num('hangBridgeFeed'),
        overhangAngle: num('hangOverhangAngle'),
        overhangFeed: num('hangOverhangFeed'),
      },
      pattern: {
        enabled: $('patternEnabled').checked,
        type: $('patternType').value,
        amplitude: num('patAmplitude'),
        zAngle: num('patZAngle'),
        coverage: num('patCoverage'),
        bumpFeed: num('patBumpFeed'),
        bottomFeed: num('patBottomFeed'),
        plBottom: Math.max(0, Math.round(num('patPlBottom'))),
        plTop: Math.max(0, Math.round(num('patPlTop'))),
        bumps: Math.max(1, Math.round(num('patBumps'))),
        count: Math.max(1, Math.round(num('patCount'))),
        spikeVar: Math.max(0, num('patSpikeVar')),
        seed: Math.max(0, Math.round(num('patSeed'))),
        spikeDwell: Math.max(0, num('patSpikeDwell')),
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
    if (!(brim.linesOuter >= 0) || !(brim.linesInner >= 0))
      return 'Enter valid outer/inner brim line counts.';
    if (brim.linesOuter < 1 && brim.linesInner < 1)
      return 'Brim needs at least 1 outer or inner line.';
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
      if (!(cfg.disc.layers >= 1)) return 'Disc needs at least 1 layer.';
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
      if (cfg.disc.foam.enabled) {
        // Mode/layer-count mismatches are NOT blocked here: switching to
        // filament mode to test shape/scale on a smaller printer with foam
        // left enabled is normal, and generate() already warns + skips foam
        // gracefully in that case rather than refusing to generate at all.
        const fm = cfg.disc.foam;
        if (!isPos(fm.tempUp) || !isPos(fm.tempMid) || !isPos(fm.tempDown))
          return 'Enter valid foam zone up/mid/down temperatures.';
        if (!Number.isFinite(fm.extrusionPct) || fm.extrusionPct <= 0 || fm.extrusionPct > 100)
          return 'Foam extrusion % must be between 1 and 100.';
        for (const key of ['primer1', 'primer2']) {
          const pr = fm[key];
          if (!isPos(pr.length) || !isPos(pr.lineWidth) || !isPos(pr.layerHeight) || !isPos(pr.feed)) {
            return 'Enter valid ' + (key === 'primer1' ? 'enter-foam' : 'exit-foam') +
              ' primer length/line width/layer height/feed.';
          }
        }
      }
      if (cfg.disc.flowFeed.enabled && !isPos(cfg.disc.flowFeed.rate)) {
        return 'Enter a valid target volumetric flow (mm³/s).';
      }
      return validatePrinter(cfg) || validateBrim(cfg.brim);
    }

    if (cfg.project === 'vessel') {
      const vchecks = {
        'layer height': cfg.layerHeight,
        'line width': cfg.lineWidth,
        'wall height': cfg.vessel.height,
        'print feed': cfg.printFeed,
        'travel feed': cfg.travelFeed,
        'chord tolerance': cfg.tolerance,
      };
      for (const name in vchecks) {
        if (!isPos(vchecks[name])) return 'Enter a valid ' + name + ' (must be greater than 0).';
      }
      if (!Number.isFinite(cfg.centerX) || !Number.isFinite(cfg.centerY))
        return 'Enter valid bed center X/Y.';
      if (!Number.isInteger(cfg.vessel.bottomLayers) || cfg.vessel.bottomLayers < 0)
        return 'Bottom layers must be 0 or more.';
      const pr = cfg.vessel;
      if (!isPos(pr.bottom) || !isPos(pr.mid) || !isPos(pr.top))
        return 'Profile scales must be greater than 0.';
      if (!Number.isFinite(pr.midH) || pr.midH < 0 || pr.midH > 1)
        return 'Middle height must be between 0 and 1.';
      for (const k in cfg.shapeParams) {
        const v = cfg.shapeParams[k];
        if (!Number.isFinite(v)) return 'Enter a valid value for ' + k + '.';
        if (k !== 'fillet' && v <= 0) return 'Shape value "' + k + '" must be greater than 0.';
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
      if (!(cfg.hanger.bottom >= 1) || !(cfg.hanger.transition >= 1))
        return 'Enter valid hanger bottom/transition loop counts.';
      if (!isPos(cfg.hanger.bridgeFeed)) return 'Enter a valid hanger bridge feedrate.';
      if (!(cfg.hanger.overhangAngle > 0 && cfg.hanger.overhangAngle < 90))
        return 'Overhang angle must be between 1 and 89 degrees.';
      if (!isPos(cfg.hanger.overhangFeed)) return 'Enter a valid hanger overhang feedrate.';
    }
    if (cfg.pattern.enabled) {
      if (!Number.isFinite(cfg.pattern.amplitude)) return 'Enter a valid pattern amplitude.';
      if (!Number.isFinite(cfg.pattern.zAngle)) return 'Enter a valid Z-angle.';
      if (!Number.isFinite(cfg.pattern.coverage)) return 'Enter a valid pattern coverage %.';
      if (!(cfg.pattern.plBottom >= 0) || !(cfg.pattern.plTop >= 0))
        return 'Enter valid patternless layer counts.';
      if (!isPos(cfg.pattern.bumpFeed)) return 'Enter a valid bump feedrate.';
      if (!Number.isFinite(cfg.pattern.bottomFeed) || cfg.pattern.bottomFeed < 0)
        return 'Enter a valid bottom feedrate (0 to use the normal print feed).';
      if (cfg.pattern.type === 'weave' && !(cfg.pattern.bumps >= 1))
        return 'Weave needs at least 1 bump per revolution.';
      if (cfg.pattern.type === 'spikes' && !(cfg.pattern.count >= 1))
        return 'Spikes need at least 1 point.';
      if (cfg.pattern.type === 'spikes' && (!Number.isFinite(cfg.pattern.spikeVar) || cfg.pattern.spikeVar < 0))
        return 'Spike length variation must be 0 or more.';
      if (cfg.pattern.type === 'spikes' && (!Number.isFinite(cfg.pattern.spikeDwell) || cfg.pattern.spikeDwell < 0))
        return 'Spike tip dwell must be 0 or more.';
    }
    return null;
  }

  function showShapeParams(shape, cls) {
    document.querySelectorAll('.' + (cls || 'shape-params')).forEach((el) => {
      el.hidden = el.getAttribute('data-shape') !== shape;
    });
  }

  function syncPrinterCards() {
    [
      ['printerMode', 'printer-params', 'printerHint'],
      ['bs_printerMode', 'printer-params-bs', 'bs_printerHint'],
      ['ve_printerMode', 'printer-params-ve', 've_printerHint'],
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
    $('tabVessel').classList.toggle('active', p === 'vessel');
  }

  function showPatternParams(type) {
    document.querySelectorAll('.pattern-params').forEach((el) => {
      el.hidden = el.getAttribute('data-pattern') !== type;
    });
    $('patternHint').textContent =
      (type === 'spikes'
        ? 'Spikes: blue-noise outward pokes, base width = line width. Change seed to re-roll. ' +
          'Bump feedrate only slows the way OUT to the tip — the way back in is normal print feed. ' +
          'An optional tip dwell (G4) pauses at the tip before heading back in.'
        : 'Weave: even bumps/rev = flutes · odd = woven') +
      ' Bottom feedrate (0 = use the normal print feed) applies only to the patternless bottom ' +
      'revolutions, below where the pattern starts — independent of the main print feed.';
  }

  // Mouse-ear brim rings, mirroring gcode.js's construction exactly (kept in
  // sync by hand, same as the hanger-loop preview overlay below already
  // duplicates buildHangerLoop's call rather than sharing generator internals):
  // per unique fillet corner, the offset loops' corner arcs completed into
  // full circles, clipped to stay outside the wall (offset out by one line
  // width), chained outer-to-inner into one open path per corner.
  function mouseEarChains(cfg, base) {
    if (cfg.shape !== 'roundedRect' || !cfg.brim || !isPos(cfg.brim.lineWidth) || !(cfg.brim.linesOuter > 0)) {
      return [];
    }
    const sp = cfg.shapeParams;
    const fl = window.Geo.roundedRectFillets(sp.width, sp.length, sp.fillet);
    const centers = [];
    fl.corners.forEach((c) => {
      if (!centers.some((e) => Math.hypot(e.x - c.x, e.y - c.y) < 1e-6)) centers.push({ x: c.x, y: c.y });
    });
    const clipPoly = window.Geo.offsetClosed(base, cfg.lineWidth);
    const STEPS = 96;
    const chains = [];
    centers.forEach((center) => {
      const chain = [];
      let printedRings = 0;
      for (let k = cfg.brim.linesOuter; k >= 1; k--) {
        const d = cfg.brim.lineWidth / 2 + cfg.lineWidth / 2 + (k - 1) * cfg.brim.lineWidth;
        const r = fl.rf + d;
        const raw = [];
        for (let s = 0; s < STEPS; s++) {
          const a = (2 * Math.PI * s) / STEPS;
          raw.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
        }
        const outside = raw.map((p) => !window.Geo.pointInPolygon(p, clipPoly));
        let bestStart = -1, bestLen = 0;
        for (let s = 0; s < STEPS; s++) {
          if (!outside[s] || outside[(s - 1 + STEPS) % STEPS]) continue;
          let len = 0;
          while (len < STEPS && outside[(s + len) % STEPS]) len++;
          if (len > bestLen) { bestLen = len; bestStart = s; }
        }
        if (bestLen === 0) continue;
        const arcPts = [];
        for (let i = 0; i <= bestLen; i++) arcPts.push(raw[(bestStart + i) % STEPS]);
        if (printedRings % 2 === 1) arcPts.reverse();
        chain.push(...arcPts);
        printedRings++;
      }
      if (chain.length >= 2) chains.push(chain);
    });
    return chains;
  }

  // Inner brim loops, mirroring gcode.js's clamp-to-last-safe-offset exactly:
  // past the safe inward distance (checked by containment, not just area/
  // inradius, so a thin shape's rounded ends folding back on themselves
  // locally is still caught), every further line reuses the last safe
  // offset instead of overshooting into the opposite side or vanishing.
  function innerBrimLoops(cfg, base, count) {
    const lw = cfg.lineWidth;
    const centroid = base.reduce((s, p) => ({ x: s.x + p.x, y: s.y + p.y }), { x: 0, y: 0 });
    centroid.x /= base.length;
    centroid.y /= base.length;
    const inradius = base.reduce((m, p) => Math.min(m, window.Geo.dist(p, centroid)), Infinity);
    function safeLoop(d) {
      if (d >= inradius) return null;
      const loop = window.Geo.offsetClosed(base, -d);
      if (window.Geo.signedArea(loop) <= 1e-3) return null;
      return loop.every((p) => window.Geo.pointInPolygon(p, base)) ? loop : null;
    }
    const ds = [];
    for (let k = 1; k <= count; k++) ds.push(cfg.brim.lineWidth / 2 + lw / 2 + (k - 1) * cfg.brim.lineWidth);
    let maxSafeD = -1, maxSafeLoop = null;
    const safeLoops = ds.map((d) => {
      const loop = safeLoop(d);
      if (loop && d > maxSafeD) {
        maxSafeD = d;
        maxSafeLoop = loop;
      }
      return loop;
    });
    const out = [];
    safeLoops.forEach((loop) => {
      if (loop) out.push(loop);
      else if (maxSafeLoop) out.push(maxSafeLoop);
    });
    return out;
  }

  // --- Live 2D previews ---
  function drawPreview(cfg) {
    if (cfg.project === 'bendstool') {
      drawPreviewBS(cfg);
      return;
    }
    if (cfg.project === 'vessel') {
      drawPreviewVessel(cfg);
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
    let openChains = [];
    if (cfg.brim.enabled && isPos(cfg.brim.lineWidth)) {
      if (cfg.brim.outerStyle === 'mouseEar' && cfg.shape === 'roundedRect') {
        openChains = mouseEarChains(cfg, base);
      } else {
        for (let k = 1; k <= cfg.brim.linesOuter; k++) {
          const d = cfg.brim.lineWidth / 2 + cfg.lineWidth / 2 + (k - 1) * cfg.brim.lineWidth;
          loops.push(window.Geo.offsetClosed(base, d));
        }
      }
      innerBrimLoops(cfg, base, cfg.brim.linesInner).forEach((l) => loops.push(l));
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
    const boundLoops = (hangerLoop ? loops.concat([hangerLoop]) : loops).concat(openChains);
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
    openChains.forEach((chain) => stroke(chain, '#2bd9a0', 1.5 * sf, false));
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
    if (Number.isFinite(cfg.disc.dome) && cfg.disc.dome < 1 && cfg.disc.layers > 1 && n > 1) {
      const T = cfg.disc.layers;
      const lh = cfg.layerHeight;
      // Top layer always adds a full lh everywhere (see gcode.js zAt/zRingAt),
      // one full lh higher than a naive continuation of the eased step.
      const topZCenter = 2 * lh + Math.max(0, T - 2) * cfg.disc.dome * lh;
      hint += ' · dome: top z ' + topZCenter.toFixed(1) + ' center / ' + (lh * T).toFixed(1) + ' edge';
    }
    if (legs && cfg.disc.attractor.enabled && isPos(cfg.disc.attractor.gap)) {
      const T = cfg.disc.layers;
      if (T > 1) {
        const dMax = ((2 * (legs.m - 1) + 1) * cfg.disc.attractor.gap * lw) / 2;
        const stepLat = dMax / (T - 1);
        const ang = (Math.atan2(stepLat, cfg.layerHeight) * 180) / Math.PI;
        const drop = Math.max(0, Math.min(1, cfg.disc.attractor.drop || 0));
        hint += ' · max overhang ' + ang.toFixed(1) + '° (' + stepLat.toFixed(2) + ' mm/layer, packed to ' +
          Math.round((1 - drop) * 100) + '% along slope)';
      } else {
        hint += ' · 1 layer: no gradient/drop';
      }
    }
    if (cfg.disc.legs && cfg.disc.legs.enabled && !legs) hint += ' · ' + (spec.warnings[spec.warnings.length - 1] || 'legs invalid');

    // Bed fit: the generator always rotates the disc 15° and recenters the
    // ROTATED bounding box on the bed-center input (the 3-leg layout is
    // roughly triangular, so this fits a rectangular bed better than printing
    // it axis-aligned) — computed here with the SAME shared helper the
    // generator uses, on the SAME (bottom-layer, unspread) outline it brims,
    // so the numbers always match the actual G-code exactly. Pure centerline
    // coordinates, no line-width margin — the bed has room to spare outside
    // where the head can travel.
    const dlForFit = window.GcodeGen.discLoops(cfg, spec);
    const fitOutline =
      dlForFit.attrOn && cfg.disc.layers > 1 ? window.GcodeGen.discLoops(cfg, spec, 0).outline : dlForFit.outline;
    const fit = window.GcodeGen.discBedFit(fitOutline, cfg.centerX, cfg.centerY);
    hint += ' · bed fit: rotated ' + window.GcodeGen.BS_ROTATION_DEG + '° → ' + fit.width.toFixed(1) + ' × ' +
      fit.height.toFixed(1) + ' mm, centered at (' + cfg.centerX + ', ' + cfg.centerY + ')';

    $('bs_discHint').textContent = hint;

    let maxR = spec.snappedD / 2;
    if (legs) maxR = n * lw + cfg.disc.legs.seatHeight;
    let brimExtent = 0;
    if (cfg.brim.enabled && cfg.brim.linesOuter > 0 && isPos(cfg.brim.lineWidth)) {
      brimExtent = cfg.brim.lineWidth / 2 + lw / 2 + (cfg.brim.linesOuter - 1) * cfg.brim.lineWidth + cfg.brim.lineWidth / 2;
    }
    maxR += brimExtent;
    const pad = 20 * sf;
    const scale = (Math.min(W, H) / 2 - pad) / (maxR || 1);
    const cxp = W / 2;
    const cyp = H / 2;

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

    // Brim (dashed): offsets of the outline the GENERATOR brims — the bottom
    // layer's, which is unspread while the bend-spread gradient is active.
    if (brimExtent > 0) {
      const brimOutline =
        dl.attrOn && cfg.disc.layers > 1 ? window.GcodeGen.discLoops(cfg, spec, 0).outline : dl.outline;
      ctx.setLineDash([5 * sf, 4 * sf]);
      ctx.strokeStyle = '#2bd9a0';
      ctx.lineWidth = 1.2 * sf;
      for (let k = 1; k <= cfg.brim.linesOuter; k++) {
        const d = cfg.brim.lineWidth / 2 + lw / 2 + (k - 1) * cfg.brim.lineWidth;
        strokePoly(window.Geo.offsetClosed(brimOutline, d), true);
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

  // Vessel: top-view (base shape + bottom fill rings + wall + brim) and a
  // side-profile silhouette from the radius control points.
  function drawPreviewVessel(cfg) {
    const ve = cfg.vessel;
    const lh = cfg.layerHeight;
    const nWall = isPos(lh) && isPos(ve.height) ? Math.max(1, Math.round(ve.height / lh)) : 0;
    const hasBottom = ve.bottomLayers > 0;
    $('ve_hint').textContent =
      'wall ' + (nWall * lh).toFixed(1) + ' mm (' + nWall + ' rev' + (nWall === 1 ? '' : 's') + ') · ' +
      (hasBottom
        ? 'bottom ' + ve.bottomLayers + ' layer' + (ve.bottomLayers === 1 ? '' : 's') + ' · ' +
          (ve.seamStyle === 'spiral' ? 'true-spiral (continuous into wall)' : ve.seamStyle === 'alternating' ? 'zipper' : 'staircase') +
          ' bottom'
        : 'no bottom (open tube)') +
      ' · ' + (ve.topStyle === 'spiral' ? 'open spiral top' : 'flat ramp-down top');

    const canvas = $('ve_preview');
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const sf = W / 600;

    let base = null;
    try {
      base = window.Geo.rotateToSeam(
        window.Geo.adaptiveShape(cfg.shape, cfg.shapeParams, isPos(cfg.tolerance) ? cfg.tolerance : 0.05),
        cfg.seamSide
      );
    } catch (e) {
      base = null;
    }
    if (base && base.length && Number.isFinite(base[0].x) && isPos(cfg.lineWidth)) {
      const s0 = isPos(ve.bottom) ? ve.bottom : 1;
      const wall = base.map((p) => ({ x: p.x * s0, y: p.y * s0 }));
      const lw = cfg.lineWidth;
      const tol = isPos(cfg.tolerance) ? cfg.tolerance : 0.05;
      let fill = { loops: [], outline: null };
      if (ve.bottomLayers > 0) {
        try {
          fill = window.Geo.ringFill(
            window.Geo.offsetClosed(wall, -lw), lw, tol, ve.seamStyle, cfg.seamSide,
            ve.seamStyle === 'spiral' ? wall : null
          );
        } catch (e) {
          fill = { loops: [], outline: null };
        }
      }
      const brimLoops = [];
      if (cfg.brim.enabled && isPos(cfg.brim.lineWidth)) {
        for (let k = 1; k <= cfg.brim.linesOuter; k++) {
          const d = cfg.brim.lineWidth / 2 + lw / 2 + (k - 1) * cfg.brim.lineWidth;
          brimLoops.push(window.Geo.offsetClosed(wall, d));
        }
        innerBrimLoops(cfg, wall, cfg.brim.linesInner).forEach((l) => brimLoops.push(l));
      }
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      [wall].concat(brimLoops).forEach((l) =>
        l.forEach((p) => {
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        })
      );
      const pad = 30 * sf;
      const scale = Math.min((W - 2 * pad) / (maxX - minX || 1), (H - 2 * pad) / (maxY - minY || 1));
      const ox = (minX + maxX) / 2;
      const oy = (minY + maxY) / 2;
      const tx = (p) => W / 2 + (p.x - ox) * scale;
      const ty = (p) => H / 2 - (p.y - oy) * scale;
      const strokeArr = (loop, color, width, close) => {
        ctx.beginPath();
        loop.forEach((p, i) => (i === 0 ? ctx.moveTo(tx(p), ty(p)) : ctx.lineTo(tx(p), ty(p))));
        if (close) ctx.closePath();
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.stroke();
      };
      if (brimLoops.length) {
        ctx.setLineDash([5 * sf, 4 * sf]);
        brimLoops.forEach((l) => strokeArr(l, '#8a8f98', 1 * sf, true));
        ctx.setLineDash([]);
      }
      // Bottom fill: rings in blue, radial/zipper connectors in orange — the
      // same seam display as the bend stool. Traced inner -> outer.
      let prevEnd = null;
      for (let i = 0; i < fill.loops.length; i++) {
        const lp = fill.loops[i];
        if (!lp.length) continue;
        if (prevEnd) {
          ctx.beginPath();
          ctx.moveTo(tx(prevEnd), ty(prevEnd));
          ctx.lineTo(tx(lp[0]), ty(lp[0]));
          ctx.strokeStyle = '#ffb454';
          ctx.lineWidth = 1.6 * sf;
          ctx.stroke();
        }
        strokeArr(lp, '#4f9dff', 1.4 * sf, false);
        prevEnd = lp[lp.length - 1];
      }
      // Wall outline (thicker, the vessel's outer edge).
      strokeArr(wall, '#6fb4ff', 2.5 * sf, true);
      const seam = wall[0];
      ctx.beginPath();
      ctx.arc(tx(seam), ty(seam), 7 * sf, 0, 2 * Math.PI);
      ctx.fillStyle = '#ff5252';
      ctx.fill();
      ctx.lineWidth = 2 * sf;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }

    drawVesselProfile(cfg);
  }

  // Side silhouette: radius scale (× base max radius) vs height, mirrored, with
  // the control points marked. Shows exactly the lofted profile the wall uses.
  function drawVesselProfile(cfg) {
    const canvas = $('ve_profile');
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const sf = W / 600;
    const ve = cfg.vessel;
    if (!isPos(ve.height)) return;

    const cps = [{ h: 0, s: isPos(ve.bottom) ? ve.bottom : 1 }];
    if (Number.isFinite(ve.midH) && ve.midH > 0.001 && ve.midH < 0.999) {
      cps.push({ h: ve.midH, s: isPos(ve.mid) ? ve.mid : 1 });
    }
    cps.push({ h: 1, s: isPos(ve.top) ? ve.top : 1 });
    cps.sort((a, b) => a.h - b.h);
    const prof = window.GcodeGen.makeProfile(cps);

    let baseR = 30;
    try {
      const b = window.Geo.adaptiveShape(cfg.shape, cfg.shapeParams, 0.3);
      baseR = Math.max.apply(null, b.map((p) => Math.hypot(p.x, p.y)));
    } catch (e) {
      baseR = 30;
    }
    const H0 = ve.height;
    const N = 120;
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const hf = i / N;
      pts.push({ r: baseR * prof(hf), z: hf * H0 });
    }
    const maxR = Math.max.apply(null, pts.map((p) => p.r)) * 1.06 || 1;
    const pad = 24 * sf;
    const sx = (W / 2 - pad) / maxR;
    const sz = (H - 2 * pad) / (H0 || 1);
    const cxp = W / 2;
    const bottomY = H - pad;
    const X = (r) => cxp + r * sx;
    const Y = (z) => bottomY - z * sz;

    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(X(p.r), Y(p.z)) : ctx.lineTo(X(p.r), Y(p.z))));
    for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(X(-pts[i].r), Y(pts[i].z));
    ctx.closePath();
    ctx.fillStyle = 'rgba(79,157,255,0.18)';
    ctx.fill();
    ctx.strokeStyle = '#4f9dff';
    ctx.lineWidth = 2 * sf;
    ctx.stroke();

    ctx.strokeStyle = 'rgba(154,163,178,0.35)';
    ctx.lineWidth = 1 * sf;
    ctx.setLineDash([4 * sf, 4 * sf]);
    ctx.beginPath();
    ctx.moveTo(cxp, Y(0));
    ctx.lineTo(cxp, Y(H0));
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = 'rgba(43,217,160,0.8)';
    ctx.lineWidth = 2.5 * sf;
    ctx.beginPath();
    ctx.moveTo(X(-pts[0].r), Y(0));
    ctx.lineTo(X(pts[0].r), Y(0));
    ctx.stroke();

    ctx.fillStyle = '#ff5252';
    cps.forEach((cp) => {
      const r = baseR * cp.s;
      const z = cp.h * H0;
      [r, -r].forEach((rr) => {
        ctx.beginPath();
        ctx.arc(X(rr), Y(z), 4.5 * sf, 0, 2 * Math.PI);
        ctx.fill();
      });
    });
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
    } else if (cfg.project === 'vessel') {
      showShapeParams(cfg.shape, 've-shape-params');
    } else if (cfg.project === 'bendstool') {
      syncFoamHint(cfg);
      syncFlowFeedHint(cfg);
    }
    syncPrinterCards();
  }

  // Live status for the foaming card: mode/layer mismatches (which the
  // generator itself just warns about and skips, rather than blocking), and
  // the derived speed% so the extrusion/speed relationship stays visible
  // without being a second field someone has to keep in sync by hand.
  function syncFoamHint(cfg) {
    const fm = cfg.disc.foam;
    $('bs_foamModeHint').textContent =
      cfg.printer.mode !== 'pellet'
        ? 'Foaming only applies in Pellet (Klipper) mode — currently inactive.'
        : cfg.disc.layers < 3
        ? 'Foaming needs at least 3 layers (first + a foam layer + last) — currently inactive.'
        : '';
    if (!fm.enabled || !isPos(fm.extrusionPct)) {
      $('bs_foamHint').textContent = '';
      return;
    }
    const speedPct = Math.round(10000 / fm.extrusionPct);
    $('bs_foamHint').textContent =
      'Speed follows extrusion to keep flow constant: ' + fm.extrusionPct + '% extrusion → ' +
      speedPct + '% speed (M220/M221). Both primers always print at 100%/100%.';
  }

  // Live status for the feed-mode card: shows whichever number the CURRENT
  // mode doesn't already fix — feed range while in constant-flow mode (since
  // that's what varies), or the resulting flow range while in constant-feed
  // mode (since the dome makes bead area, and therefore flow, vary) — using
  // the SAME shared helper the generator uses, so the numbers always match.
  function syncFlowFeedHint(cfg) {
    if (!isPos(cfg.lineWidth) || !isPos(cfg.layerHeight) || !isPos(cfg.disc.diameter)) {
      $('bs_flowFeedHint').textContent = '';
      return;
    }
    const range = window.GcodeGen.domeHeightRange(cfg);
    const areaMin = window.GcodeGen.beadArea(cfg.lineWidth, range.hMin);
    const areaMax = window.GcodeGen.beadArea(cfg.lineWidth, range.hMax);
    const ff = cfg.disc.flowFeed;
    if (ff.enabled && isPos(ff.rate)) {
      const feedAtMin = (ff.rate * 60) / areaMin; // smallest area -> fastest feed
      const feedAtMax = (ff.rate * 60) / areaMax; // largest area -> slowest feed
      $('bs_flowFeedHint').textContent =
        'Feed varies ' + feedAtMax.toFixed(0) + '–' + feedAtMin.toFixed(0) + ' mm/min ' +
        '(bead area ' + areaMin.toFixed(2) + '–' + areaMax.toFixed(2) + ' mm² across the dome) to hold ' +
        ff.rate + ' mm³/s.';
    } else if (isPos(cfg.printFeed)) {
      const flowAtMin = (cfg.printFeed * areaMin) / 60;
      const flowAtMax = (cfg.printFeed * areaMax) / 60;
      $('bs_flowFeedHint').textContent = range.domed
        ? 'At a constant ' + cfg.printFeed + ' mm/min, volumetric flow varies ' + flowAtMin.toFixed(2) +
          '–' + flowAtMax.toFixed(2) + ' mm³/s across the dome (bead area ' + areaMin.toFixed(2) + '–' +
          areaMax.toFixed(2) + ' mm²).'
        : 'At a constant ' + cfg.printFeed + ' mm/min: ' + flowAtMax.toFixed(2) +
          ' mm³/s (undomed — bead area is uniform, so flow is too).';
    } else {
      $('bs_flowFeedHint').textContent = '';
    }
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
      regenFailed([err]);
      return;
    }

    let result;
    try {
      result = window.GcodeGen.generate(cfg);
    } catch (e) {
      regenFailed(['Generation error: ' + e.message]);
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

  // A failed regenerate must not leave the PREVIOUS G-code exportable — on a
  // printing tool that ships the wrong file to the machine. Clear it all.
  function regenFailed(msgs) {
    showWarnings(msgs, true);
    $('stats').textContent = '';
    lastGcode = '';
    $('output').value = '';
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
  // Name (and share title) follow the ACTIVE tab, not the coat hanger's
  // possibly-hidden shape select.
  function filename() {
    const p = activeProject();
    const stem =
      p === 'bendstool'
        ? 'stool'
        : p === 'vessel'
        ? 'vessel_' + $('ve_shape').value
        : 'vase_' + $('shape').value;
    return stem + '_' + Date.now() + '.gcode';
  }
  function download() {
    if (!lastGcode) {
      flash($('downloadBtn'), 'No G-code');
      return;
    }
    // iOS Safari appends ".txt" to a download whenever the blob's MIME type
    // is a recognized text type (text/plain included) paired with a file
    // extension it doesn't know, like .gcode — application/octet-stream
    // reads as generic binary data instead, so Safari just uses the given
    // filename verbatim.
    const blob = new Blob([lastGcode], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename();
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // The GAP OPENING itself — not the wall outline. Bounded on one side by the
  // bridging loop's new bezier/pocket path (A to B, the innermost extent —
  // where the wall sits at the bottom of the gap) and on the other by the
  // plain base curve's own back arc between the same two points A/B (the
  // outermost extent — where the wall sits once the transition has fully
  // closed the gap back up). Both curves already meet exactly at A and B (both
  // are literally base points sampled at the same u — buildHangerLoop uses
  // them as its own bezier endpoints), so stitching bridging-path-forward +
  // base-arc-backward is already a closed loop with no gap of its own.
  // Returned at the raw toolpath centerline, unoffset — offsetting is left to
  // the user's own CAD tool.
  function hangerGapOutline(cfg) {
    const base = window.Geo.rotateToSeam(
      window.Geo.adaptiveShape(cfg.shape, cfg.shapeParams, isPos(cfg.tolerance) ? cfg.tolerance : 0.05),
      cfg.seamSide
    );
    const gapFrac = cfg.hanger.size / 100;
    const hangerLoop = window.Geo.buildHangerLoop(base, gapFrac, cfg.hanger.pocket / 100, cfg.lineWidth);

    let firstNew = -1, lastNew = -1;
    for (let i = 0; i < hangerLoop.length; i++) {
      if (hangerLoop[i].isNew) {
        if (firstNew < 0) firstNew = i;
        lastNew = i;
      }
    }
    if (firstNew < 0) throw new Error('no bezier/pocket section found');
    const bridgingPath = hangerLoop.slice(firstNew - 1, lastNew + 2); // A .. B inclusive

    const uA = 0.5 - gapFrac / 2;
    const uB = 0.5 + gapFrac / 2;
    const s = window.Geo.makeSampler(base);
    const baseArc = [];
    for (let i = 0; i < base.length; i++) {
      const u = s.uOf(i);
      if (u > uA && u < uB) baseArc.push(base[i]);
    }

    // No offset here — exported at the raw toolpath centerline so it can be
    // offset by hand in Rhino instead.
    return bridgingPath.concat(baseArc.slice().reverse());
  }

  function exportHangerSvg() {
    const btn = $('hangExportSvgBtn');
    const cfg = readConfig();
    if (cfg.project !== 'cordhanger' || !cfg.hanger.enabled) {
      flash(btn, 'Enable the hanger first');
      return;
    }
    if (
      !isPos(cfg.hanger.size) || cfg.hanger.size > 45 ||
      !isPos(cfg.hanger.pocket) || cfg.hanger.pocket > 45 || !isPos(cfg.lineWidth)
    ) {
      flash(btn, 'Fix hanger settings first');
      return;
    }
    let outline;
    try {
      outline = hangerGapOutline(cfg);
    } catch (e) {
      flash(btn, 'Export failed');
      return;
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    outline.forEach((p) => {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    });
    const margin = 2;
    const w = maxX - minX + 2 * margin;
    const h = maxY - minY + 2 * margin;
    // SVG Y is down-positive; flip to match the app's own 2D preview orientation.
    const d = outline.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(4) + ',' + (-p.y).toFixed(4)).join(' ') + ' Z';
    const svg =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + w.toFixed(2) + 'mm" height="' + h.toFixed(2) + 'mm" ' +
      'viewBox="' + (minX - margin).toFixed(4) + ' ' + (-maxY - margin).toFixed(4) + ' ' + w.toFixed(2) + ' ' + h.toFixed(2) + '">\n' +
      '<path d="' + d + '" fill="none" stroke="#000" stroke-width="0.1"/>\n' +
      '</svg>\n';

    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'hanger_profile_' + Date.now() + '.svg';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function share() {
    if (!lastGcode) {
      flash($('shareBtn'), 'No G-code');
      return;
    }
    const file = new File([lastGcode], filename(), { type: 'application/octet-stream' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'EasyGCode ' + activeProject() });
        return;
      } catch (e) {
        /* cancelled / unsupported — fall through */
      }
    }
    download();
  }
  async function copy() {
    if (!lastGcode) {
      flash($('copyBtn'), 'No G-code');
      return;
    }
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
    ['preview', 'previewBS', 've_preview', 've_profile', 'preview3d'].forEach((id) => {
      const c = $(id);
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const w = c.clientWidth || 600;
      // Cap the backing store so a canvas can never feed back into its own
      // layout size and grow without bound (belt-and-braces vs missing CSS).
      const px = Math.min(1600, Math.round(w * dpr));
      const py = id === 've_profile' ? Math.round(px * 0.6) : px; // profile is wide, not square
      if (px > 0 && (c.width !== px || c.height !== py)) {
        c.width = px;
        c.height = py;
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
    $('bs_foamFields').hidden = !$('bs_foamEnabled').checked;
    $('bs_foamPrimerFields').hidden = !$('bs_foamEnabled').checked;
    $('bs_flowFeedFields').hidden = !$('bs_flowFeedEnabled').checked;
    $('ve_brimFields').hidden = !$('ve_brimEnabled').checked;
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
    brimEnabled: 'bs_brimEnabled', brimOuterStyle: 'bs_brimOuterStyle',
    brimLinesOuter: 'bs_brimLinesOuter', brimLinesInner: 'bs_brimLinesInner',
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

  // Same idea for the vessel: seed its generic settings + shape from the cord
  // hanger the first time it appears, then it stays independent.
  const SEED_MAP_VE = {
    layerHeight: 've_layerHeight', lineWidth: 've_lineWidth',
    printFeed: 've_printFeed', travelFeed: 've_travelFeed',
    tolerance: 've_tolerance', seamSide: 've_seamSide', centerX: 've_centerX', centerY: 've_centerY',
    printerMode: 've_printerMode', extrusionMultiplier: 've_extrusionMultiplier',
    startEndEnabled: 've_startEndEnabled',
    filDiameter: 've_filDiameter', filNozzleTemp: 've_filNozzleTemp',
    filBedTemp: 've_filBedTemp', filFan: 've_filFan',
    pelUpTemp: 've_pelUpTemp', pelMidTemp: 've_pelMidTemp', pelDownTemp: 've_pelDownTemp',
    pelBedTemp: 've_pelBedTemp', pelPA: 've_pelPA', pelPurge: 've_pelPurge', pelFan: 've_pelFan',
    shape: 've_shape',
    circle_radius: 've_circle_radius', rect_width: 've_rect_width', rect_length: 've_rect_length',
    rect_fillet: 've_rect_fillet', ellipse_rx: 've_ellipse_rx', ellipse_ry: 've_ellipse_ry',
    poly_radius: 've_poly_radius', poly_sides: 've_poly_sides',
    star_outer: 've_star_outer', star_inner: 've_star_inner', star_points: 've_star_points',
    sq_size: 've_sq_size', sq_n: 've_sq_n',
    brimEnabled: 've_brimEnabled', brimOuterStyle: 've_brimOuterStyle',
    brimLinesOuter: 've_brimLinesOuter', brimLinesInner: 've_brimLinesInner',
    brimLineWidth: 've_brimLineWidth', brimLayerHeight: 've_brimLayerHeight', brimFeed: 've_brimFeed',
  };

  function seedVessel() {
    Object.keys(SEED_MAP_VE).forEach((src) => {
      const a = $(src);
      const b = $(SEED_MAP_VE[src]);
      if (!a || !b) return;
      if (a.type === 'checkbox') b.checked = a.checked;
      else b.value = a.value;
    });
    $('ve_brimFields').hidden = !$('ve_brimEnabled').checked;
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
  $('hangExportSvgBtn').addEventListener('click', exportHangerSvg);

  $('bs_brimEnabled').addEventListener('change', () => {
    $('bs_brimFields').hidden = !$('bs_brimEnabled').checked;
    updateShapeUI();
  });

  $('bs_legsEnabled').addEventListener('change', () => {
    $('bs_legFields').hidden = !$('bs_legsEnabled').checked;
    updateShapeUI();
  });

  $('bs_foamEnabled').addEventListener('change', () => {
    $('bs_foamFields').hidden = !$('bs_foamEnabled').checked;
    $('bs_foamPrimerFields').hidden = !$('bs_foamEnabled').checked;
    updateShapeUI();
  });

  $('bs_flowFeedEnabled').addEventListener('change', () => {
    $('bs_flowFeedFields').hidden = !$('bs_flowFeedEnabled').checked;
    updateShapeUI();
  });

  $('ve_brimEnabled').addEventListener('change', () => {
    $('ve_brimFields').hidden = !$('ve_brimEnabled').checked;
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
  $('tabVessel').addEventListener('click', () => switchProject('vessel'));

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
    // updateViaCache 'none' => the browser re-fetches sw.js from the network on
    // every load (not the HTTP cache), so a new release is detected right away.
    // If the page is already controlled at load, a later controllerchange means
    // an updated worker took over -> reload once to swap to the fresh code. (Not
    // attached on the very first visit, so the initial claim doesn't reload.)
    let refreshing = false;
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return;
        refreshing = true;
        window.location.reload();
      });
    }
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('sw.js', { updateViaCache: 'none' })
        .then((reg) => reg.update())
        .catch(() => {});
    });
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
  if (restored && !('ve_layerHeight' in restored)) seedVessel();
  showProject(activeProject());
  fitCanvases();
  updateShapeUI();
  regenerate();
})();
