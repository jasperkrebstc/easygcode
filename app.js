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
  // The container project produces two G-codes (base + lid) from one
  // generate() call — stored together here, with cnActivePart choosing
  // which one currently populates the app's single shared output section
  // (3D preview, stats, warnings, textarea, download).
  let lastContainerResult = null;
  let cnActivePart = 'base';

  function activeProject() {
    const v = $('activeProject').value;
    return v === 'bendstool' || v === 'vessel' || v === 'spoon' || v === 'lamp' || v === 'container'
      ? v
      : 'cordhanger';
  }

  const VE_PT_MAX = 20;
  // Both the top and bottom custom-curve editors share the exact same field
  // layout/behavior (point count, up to VE_PT_MAX pre-built field groups
  // with only the SELECTED one ever shown, prev/next, drag-to-adjust on a
  // canvas, split randomize) parameterized by `kind` ('top' or 'bot') —
  // mirrors readShape(pre)'s own prefix-sharing pattern. Top has a Z field
  // per point and its own zPct; bottom never does ("without the z
  // difference", per instruction).
  function vePtPrefix(kind) { return kind === 'top' ? 've_topPt' : 've_botPt'; }
  function vePtHasZ(kind) { return kind === 'top'; }
  let veTopPtSelected = 1;
  let veBotPtSelected = 1;
  function vePtSelected(kind) { return kind === 'top' ? veTopPtSelected : veBotPtSelected; }
  function vePtSetSelected(kind, n) {
    if (kind === 'top') veTopPtSelected = n; else veBotPtSelected = n;
  }
  // Last draw's transform + per-point hit-list for each curve canvas —
  // lets the pointer handlers hit-test and drag without recomputing the
  // base-shape geometry on every move.
  let veCurveState = { top: null, bot: null };

  // Radius profile's own middle points (bottom/top are always-visible,
  // separate fields, not part of this selector — see showSelectedProfMid):
  // same "only the selected one visible, prev/next" pattern as the top/
  // bottom curves, but with its own state since it's a single list, not a
  // 'top'/'bot' pair.
  const PROF_MID_MAX = 8;
  let veProfMidSelected = 1;
  let veProfCurveState = null;
  function profMidCount() {
    return Math.max(0, Math.min(PROF_MID_MAX, Math.round(num('ve_profMidCount')) || 0));
  }
  function readProfileMidPoints() {
    const count = profMidCount();
    const pts = [];
    for (let i = 1; i <= PROF_MID_MAX; i++) pts.push({ h: num('ve_profMidH' + i), s: num('ve_profMid' + i) });
    return pts.slice(0, count);
  }

  // The container project's own radius profile editor — a duplicate of the
  // vessel's own (same fields/behavior, cn_ prefixed) rather than a shared
  // generalization, a deliberate choice to ship the container without
  // touching the vessel's already-shipped, already-tested profile code in
  // the same pass. Worth revisiting as a follow-up cleanup once the
  // container itself has settled.
  let cnProfMidSelected = 1;
  let cnProfCurveState = null;
  function cnProfMidCount() {
    return Math.max(0, Math.min(PROF_MID_MAX, Math.round(num('cn_profMidCount')) || 0));
  }
  function cnReadProfileMidPoints() {
    const count = cnProfMidCount();
    const pts = [];
    for (let i = 1; i <= PROF_MID_MAX; i++) pts.push({ h: num('cn_profMidH' + i), s: num('cn_profMid' + i) });
    return pts.slice(0, count);
  }

  // Read one curve's points (up to VE_PT_MAX pre-built field groups),
  // sliced to the configured count — mirrors how the radius profile's own
  // middle points are read.
  function readVesselCurvePoints(kind) {
    const pre = vePtPrefix(kind);
    const count = Math.max(3, Math.min(VE_PT_MAX, Math.round(num(pre + 'Count'))));
    const pts = [];
    for (let i = 1; i <= VE_PT_MAX; i++) {
      const p = { u: num(pre + 'U' + i), radialPct: num(pre + 'R' + i) };
      if (vePtHasZ(kind)) p.zPct = num(pre + 'Z' + i);
      pts.push(p);
    }
    return pts.slice(0, count);
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
      endLift: num(pre + 'endLift'),
      filament: {
        diameter: num(pre + 'filDiameter'),
        nozzle: num(pre + 'filNozzleTemp'),
        bed: num(pre + 'filBedTemp'),
        fan: Math.max(0, Math.min(100, num(pre + 'filFan'))),
        // Only the coat hanger's "bumps only" fan mode has these — every
        // other project's printer card has no such fields, so read them
        // defensively (0 when absent) rather than assuming they exist.
        fanWall: $(pre + 'filFanWall') ? Math.max(0, Math.min(100, num(pre + 'filFanWall'))) : 0,
        fanBump: $(pre + 'filFanBump') ? Math.max(0, Math.min(100, num(pre + 'filFanBump'))) : 0,
      },
      pellet: {
        up: num(pre + 'pelUpTemp'),
        mid: num(pre + 'pelMidTemp'),
        down: num(pre + 'pelDownTemp'),
        bed: num(pre + 'pelBedTemp'),
        pa: num(pre + 'pelPA'),
        purge: num(pre + 'pelPurge'),
        fan: Math.max(0, Math.min(100, num(pre + 'pelFan'))),
        fanWall: $(pre + 'pelFanWall') ? Math.max(0, Math.min(100, num(pre + 'pelFanWall'))) : 0,
        fanBump: $(pre + 'pelFanBump') ? Math.max(0, Math.min(100, num(pre + 'pelFanBump'))) : 0,
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
      multiplier: num(pre + 'brimMultiplier'),
    };
  }

  function readConfig() {
    if (activeProject() === 'bendstool') {
      return {
        project: 'bendstool',
        printer: readPrinter('bs_'),
        materialDensity: num('bs_materialDensity'),
        materialPrice: num('bs_materialPrice'),
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
          seamStyle:
            ['alternating', 'spiral', 'filleted'].indexOf($('ve_seamStyle').value) >= 0
              ? $('ve_seamStyle').value
              : 'staircase',
          topStyle: $('ve_topStyle').value === 'spiral' ? 'spiral' : 'flat',
          bottomFillet: Math.max(0, num('ve_bottomFillet')),
          bottom: num('ve_profBottom'),
          midCount: profMidCount(),
          midPoints: readProfileMidPoints(),
          top: num('ve_profTop'),
          topShape:
            ['roundedStar', 'points'].indexOf($('ve_topShape').value) >= 0 ? $('ve_topShape').value : 'same',
          topStarOuter: num('ve_topStar_outer'),
          topStarInner: num('ve_topStar_inner'),
          topStarPoints: Math.max(2, Math.round(num('ve_topStar_points'))),
          topStarZDiffPct: Math.max(0, Math.min(100, num('ve_topStar_zDiffPct'))),
          topPointsCount: Math.max(3, Math.min(VE_PT_MAX, Math.round(num('ve_topPtCount')))),
          topPoints: readVesselCurvePoints('top'),
          bottomShape:
            ['sameAsTop', 'points'].indexOf($('ve_bottomShape').value) >= 0 ? $('ve_bottomShape').value : 'base',
          bottomPointsCount: Math.max(3, Math.min(VE_PT_MAX, Math.round(num('ve_botPtCount')))),
          bottomPoints: readVesselCurvePoints('bot'),
        },
        brim: readBrim('ve_'),
      };
    }

    if (activeProject() === 'spoon') {
      return {
        project: 'spoon',
        printer: readPrinter('sp_'),
        layerHeight: num('sp_layerHeight'),
        lineWidth: num('sp_lineWidth'),
        printFeed: num('sp_printFeed'),
        travelFeed: num('sp_travelFeed'),
        centerX: num('sp_centerX'),
        centerY: num('sp_centerY'),
        spoon: {
          turns: Math.max(0, num('sp_turns')),
          startRadius: Math.max(0, num('sp_startRadius')),
          stickLength: Math.max(0, num('sp_stickLength')),
          layers: Math.max(1, Math.round(num('sp_layers'))),
          startPoint: $('sp_startPoint').value === 'stick' ? 'stick' : 'center',
          stickLineWidth: Math.max(0, num('sp_stickLineWidth')),
          stickLayerHeight: Math.max(0, num('sp_stickLayerHeight')),
          stickFeed: Math.max(0, num('sp_stickFeed')),
          flowFeed: {
            enabled: $('sp_flowFeedEnabled').checked,
            rate: num('sp_flowFeedRate'),
          },
        },
      };
    }

    if (activeProject() === 'lamp') {
      return {
        project: 'lamp',
        printer: readPrinter('ls_'),
        lineWidth: num('ls_lineWidth'),
        printFeed: num('ls_printFeed'),
        travelFeed: num('ls_travelFeed'),
        tolerance: num('ls_tolerance'),
        centerX: num('ls_centerX'),
        centerY: num('ls_centerY'),
        lamp: {
          socket: ['e14', 'e27', 'custom'].indexOf($('ls_socket').value) >= 0 ? $('ls_socket').value : 'e27',
          customDiameter: num('ls_customDiameter'),
          customPitch: num('ls_customPitch'),
          fitTolerance: num('ls_fitTolerance'),
          shape: ['cone', 'arcOut', 'arcIn', 'sphere'].indexOf($('ls_shape').value) >= 0 ? $('ls_shape').value : 'cone',
          maxAngle: Math.max(0, num('ls_maxAngle')),
          sphereDiameter: num('ls_sphereDiameter'),
          throatLength: Math.max(0, num('ls_throatLength')),
          fillet: Math.max(0, num('ls_fillet')),
          bottomDiameter: num('ls_bottomDiameter'),
          transitionHeight: num('ls_transitionHeight'),
          orientation: $('ls_orientation').value === 'wide' ? 'wide' : 'throat',
          compMode: ['width', 'layerHeight', 'off'].indexOf($('ls_compMode').value) >= 0 ? $('ls_compMode').value : 'width',
          compStrength: Math.max(0, Math.min(100, num('ls_compStrength'))),
          compMaxMult: num('ls_compMaxMult'),
          flowFeed: {
            enabled: $('ls_flowFeedEnabled').checked,
            rate: num('ls_flowFeedRate'),
            shadeRate: Math.max(0, num('ls_flowShadeRate')),
            transitionHeight: Math.max(0, num('ls_flowTransitionHeight')),
          },
        },
        brim: {
          enabled: $('ls_brimEnabled').checked,
          outerStyle: 'normal',
          linesOuter: Math.max(0, Math.round(num('ls_brimLinesOuter'))),
          linesInner: 0,
          lineWidth: num('ls_brimLineWidth'),
          layerHeight: num('ls_brimLayerHeight'),
          feed: num('ls_brimFeed'),
          multiplier: num('ls_brimMultiplier'),
        },
      };
    }

    if (activeProject() === 'container') {
      return {
        project: 'container',
        container: {
          printer: readPrinter('cn_'),
          layerHeight: num('cn_layerHeight'),
          lineWidth: num('cn_lineWidth'),
          printFeed: num('cn_printFeed'),
          travelFeed: num('cn_travelFeed'),
          tolerance: num('cn_tolerance'),
          printDirection: $('cn_printDirection').value === 'cw' ? 'cw' : 'ccw',
          seamSide: $('cn_seamSide').value,
          centerX: num('cn_centerX'),
          centerY: num('cn_centerY'),
          radius: num('cn_radius'),
          height: num('cn_height'),
          bottomFillet: Math.max(0, num('cn_bottomFillet')),
          bottom: num('cn_profBottom'),
          midCount: cnProfMidCount(),
          midPoints: cnReadProfileMidPoints(),
          top: num('cn_profTop'),
        },
        lid: {
          printer: readPrinter('cnl_'),
          // Layer height and line width are NOT independent lid settings —
          // both directly set the vase-mode "thread" pitch/wall thickness,
          // and a mismatch there would keep the lid from ever engaging the
          // base cleanly, so the lid always uses the base's own values
          // (read straight off cfg.container in gcode.js).
          printFeed: num('cnl_printFeed'),
          travelFeed: num('cnl_travelFeed'),
          tolerance: num('cnl_tolerance'),
          printDirection: $('cnl_printDirection').value === 'cw' ? 'cw' : 'ccw',
          seamSide: $('cnl_seamSide').value,
          centerX: num('cnl_centerX'),
          centerY: num('cnl_centerY'),
          straightHeight: num('cnl_straightHeight'),
          fillet: Math.max(0, num('cnl_fillet')),
          fitTolerance: num('cnl_fitTolerance'),
        },
      };
    }

    const cs = readShape('');
    return {
      project: 'cordhanger',
      shape: cs.shape,
      shapeParams: cs.shapeParams,
      printer: readPrinter(''),
      materialDensity: num('materialDensity'),
      materialPrice: num('materialPrice'),
      layerHeight: num('layerHeight'),
      lineWidth: num('lineWidth'),
      totalHeight: num('totalHeight'),
      bottomFillet: Math.max(0, num('bottomFillet')),
      printFeed: num('printFeed'),
      flowFeed: {
        enabled: $('flowFeedEnabled').checked,
        rate: num('flowFeedRate'),
      },
      travelFeed: num('travelFeed'),
      accelToWallFeed: Math.max(0, num('accelToWallFeed')),
      tolerance: num('tolerance'),
      seamSide: $('seamSide').value,
      printDirection: $('printDirection').value === 'cw' ? 'cw' : 'ccw',
      centerX: num('centerX'),
      centerY: num('centerY'),
      fanMode: $('fanMode').value === 'bumps' ? 'bumps' : 'always',
      topStyle: $('topStyle').value === 'spiral' ? 'spiral' : 'flat',
      brim: readBrim(''),
      hanger: {
        enabled: $('hangEnabled').checked,
        mode: $('hangMode').value === 'double' ? 'double' : 'single',
        size: num('hangSize'),
        pocket: num('hangPocket'),
        gapWidthMM: num('hangGapWidth'),
        pocketWidthMM: num('hangPocketWidth'),
        bottom: Math.max(1, Math.round(num('hangBottom'))),
        transition: Math.max(1, Math.round(num('hangTransition'))),
        bridgeFeed: num('hangBridgeFeed'),
        overhangAngle: num('hangOverhangAngle'),
        overhangFeed: num('hangOverhangFeed'),
        flowMode: $('hangFlowMode').checked,
      },
      pattern: {
        enabled: $('patternEnabled').checked,
        type: $('patternType').value,
        amplitude: num('patAmplitude'),
        zAngle: num('patZAngle'),
        zAngleLowMM: Math.max(0, num('patZAngleLowMM')),
        zAngleLow: num('patZAngleLow'),
        coverage: num('patCoverage'),
        bumpFeed: num('patBumpFeed'),
        flowMode: $('patFlowMode').checked,
        plBottom: Math.max(0, Math.round(num('patPlBottom'))),
        plTop: Math.max(0, Math.round(num('patPlTop'))),
        bumps: Math.max(1, Math.round(num('patBumps'))),
        spikeDensity: Math.max(0, num('patSpikeDensity')),
        spikeVar: Math.max(0, num('patSpikeVar')),
        seed: Math.max(0, Math.round(num('patSeed'))),
        spikeBalance: $('patSpikeBalance').value === 'on',
        spikeDwell: Math.max(0, num('patSpikeDwell')),
        spikeOutMotion: $('patSpikeOutMotion').value === 'arc' ? 'arc' : 'straight',
        spikeFeedOut: num('patSpikeFeedOut'),
        spikeFeedTip: num('patSpikeFeedTip'),
        spikeFeedIn: num('patSpikeFeedIn'),
        spikeLineWidth: Math.max(0, num('patSpikeLineWidth')),
        spikeLayerHeight: Math.max(0, num('patSpikeLayerHeight')),
      },
    };
  }

  function validatePrinter(cfg) {
    if (!isPos(cfg.printer.multiplier)) return 'Extrusion multiplier must be greater than 0.';
    if (!Number.isFinite(cfg.printer.endLift) || cfg.printer.endLift < 0)
      return 'End lift must be 0 or more.';
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
    if (!Number.isFinite(brim.multiplier) || brim.multiplier < 0)
      return 'Brim extrusion multiplier must be 0 (same as wall) or more.';
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
      if (!Number.isFinite(cfg.materialDensity) || cfg.materialDensity < 0)
        return 'Material density must be 0 (skip cost) or more.';
      if (!Number.isFinite(cfg.materialPrice) || cfg.materialPrice < 0)
        return 'Material price must be 0 (skip cost) or more.';
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
      if (!isPos(pr.bottom) || !isPos(pr.top)) return 'Profile scales must be greater than 0.';
      if (!(pr.midCount >= 0 && pr.midCount <= PROF_MID_MAX))
        return 'Middle points must be between 0 and ' + PROF_MID_MAX + '.';
      for (const m of pr.midPoints) {
        if (!Number.isFinite(m.h) || m.h < 0 || m.h > 1) return 'Middle height must be between 0 and 1.';
        if (!isPos(m.s)) return 'Middle scale must be greater than 0.';
      }
      if (pr.seamStyle === 'filleted' && (!Number.isFinite(pr.bottomFillet) || pr.bottomFillet < 0)) {
        return 'Bottom fillet height must be 0 or more.';
      }
      if (pr.topShape === 'roundedStar') {
        if (!isPos(pr.topStarOuter) || !isPos(pr.topStarInner)) {
          return 'Top curve star outer/inner radius must be greater than 0.';
        }
        if (!(pr.topStarPoints >= 2)) return 'Top curve star points must be 2 or more.';
        if (!Number.isFinite(pr.topStarZDiffPct) || pr.topStarZDiffPct < 0 || pr.topStarZDiffPct > 100) {
          return 'Inner-point Z lift must be between 0 and 100%.';
        }
      }
      if (pr.topShape === 'points') {
        if (!(pr.topPointsCount >= 3)) return 'Custom top curve needs at least 3 points.';
        if (pr.topPoints.length < 3) return 'Custom top curve needs at least 3 points.';
        for (const p of pr.topPoints) {
          if (!Number.isFinite(p.u) || p.u < 0 || p.u > 1) return 'Top curve point position must be between 0 and 1.';
          if (!Number.isFinite(p.radialPct) || p.radialPct < -100 || p.radialPct > 100)
            return 'Top curve point outward % must be between -100 and 100.';
          if (!Number.isFinite(p.zPct) || p.zPct < -100 || p.zPct > 100)
            return 'Top curve point Z % must be between -100 and 100.';
        }
      }
      if (pr.bottomShape === 'points') {
        if (!(pr.bottomPointsCount >= 3)) return 'Custom bottom curve needs at least 3 points.';
        if (pr.bottomPoints.length < 3) return 'Custom bottom curve needs at least 3 points.';
        for (const p of pr.bottomPoints) {
          if (!Number.isFinite(p.u) || p.u < 0 || p.u > 1) return 'Bottom curve point position must be between 0 and 1.';
          if (!Number.isFinite(p.radialPct) || p.radialPct < -100 || p.radialPct > 100)
            return 'Bottom curve point outward % must be between -100 and 100.';
        }
      }
      for (const k in cfg.shapeParams) {
        const v = cfg.shapeParams[k];
        if (!Number.isFinite(v)) return 'Enter a valid value for ' + k + '.';
        if (k !== 'fillet' && v <= 0) return 'Shape value "' + k + '" must be greater than 0.';
      }
      return validatePrinter(cfg) || validateBrim(cfg.brim);
    }

    if (cfg.project === 'spoon') {
      const schecks = {
        'layer height': cfg.layerHeight,
        'line width': cfg.lineWidth,
        'print feed': cfg.printFeed,
        'travel feed': cfg.travelFeed,
      };
      for (const name in schecks) {
        if (!isPos(schecks[name])) return 'Enter a valid ' + name + ' (must be greater than 0).';
      }
      if (!Number.isFinite(cfg.centerX) || !Number.isFinite(cfg.centerY))
        return 'Enter valid bed center X/Y.';
      if (!(cfg.spoon.turns >= 0)) return 'Turns must be 0 or more.';
      if (!(cfg.spoon.startRadius >= 0)) return 'Start radius must be 0 or more.';
      if (!(cfg.spoon.stickLength >= 0)) return 'Stick length must be 0 or more.';
      if (cfg.spoon.turns <= 0 && cfg.spoon.stickLength <= 0)
        return 'Enter at least some turns or a stick length.';
      if (!(cfg.spoon.layers >= 1)) return 'Layers must be at least 1.';
      if (!Number.isFinite(cfg.spoon.stickLineWidth) || cfg.spoon.stickLineWidth < 0)
        return 'Stick line width must be 0 (same as spiral) or more.';
      if (!Number.isFinite(cfg.spoon.stickLayerHeight) || cfg.spoon.stickLayerHeight < 0)
        return 'Stick layer height must be 0 (same as spiral) or more.';
      if (!Number.isFinite(cfg.spoon.stickFeed) || cfg.spoon.stickFeed < 0)
        return 'Stick feed must be 0 (same as spiral) or more.';
      if (cfg.spoon.flowFeed.enabled && !isPos(cfg.spoon.flowFeed.rate)) {
        return 'Enter a valid target volumetric flow (mm³/s).';
      }
      return validatePrinter(cfg);
    }

    if (cfg.project === 'lamp') {
      const lchecks = {
        'line width': cfg.lineWidth,
        'print feed': cfg.printFeed,
        'travel feed': cfg.travelFeed,
        'chord tolerance': cfg.tolerance,
        'bottom opening diameter': cfg.lamp.bottomDiameter,
        'transition height': cfg.lamp.transitionHeight,
      };
      for (const name in lchecks) {
        if (!isPos(lchecks[name])) return 'Enter a valid ' + name + ' (must be greater than 0).';
      }
      if (!Number.isFinite(cfg.centerX) || !Number.isFinite(cfg.centerY))
        return 'Enter valid bed center X/Y.';
      if (cfg.lamp.socket === 'custom') {
        if (!isPos(cfg.lamp.customDiameter)) return 'Enter a valid custom thread diameter.';
        if (!isPos(cfg.lamp.customPitch)) return 'Enter a valid custom thread pitch.';
      }
      if (!Number.isFinite(cfg.lamp.fitTolerance)) return 'Enter a valid fit tolerance.';
      if (!(cfg.lamp.throatLength >= 0)) return 'Throat length must be 0 or more.';
      if (!(cfg.lamp.fillet >= 0)) return 'Fillet radius must be 0 or more.';
      if (!isPos(cfg.lamp.compMaxMult) || cfg.lamp.compMaxMult < 1)
        return 'Max line width multiplier must be 1 or more.';
      if (cfg.lamp.flowFeed.enabled) {
        if (!isPos(cfg.lamp.flowFeed.rate)) return 'Enter a valid throat flow (mm³/s).';
        if (!Number.isFinite(cfg.lamp.flowFeed.shadeRate) || cfg.lamp.flowFeed.shadeRate < 0)
          return 'Shade flow must be 0 (same as throat) or more.';
        if (!Number.isFinite(cfg.lamp.flowFeed.transitionHeight) || cfg.lamp.flowFeed.transitionHeight < 0)
          return 'Flow ramp height must be 0 (use the fillet) or more.';
      }
      if (!Number.isFinite(cfg.lamp.maxAngle) || cfg.lamp.maxAngle < 0 || cfg.lamp.maxAngle > 89)
        return 'Max angle must be between 0 (uncapped) and 89 degrees.';
      if (cfg.lamp.shape === 'sphere') {
        if (!isPos(cfg.lamp.sphereDiameter)) return 'Enter a valid sphere diameter.';
        if (cfg.lamp.sphereDiameter <= cfg.lamp.bottomDiameter)
          return 'Sphere diameter must be larger than the bottom opening.';
      }
      const thread = lampThread(cfg);
      if (cfg.lamp.bottomDiameter < thread.diameter)
        return 'Bottom opening must be at least as wide as the socket thread (⌀' + thread.diameter + ' mm).';
      return validatePrinter(cfg) || validateBrim(cfg.brim);
    }

    if (cfg.project === 'container') {
      const cn = cfg.container;
      const lid = cfg.lid;
      const cnChecks = {
        'base layer height': cn.layerHeight,
        'base line width': cn.lineWidth,
        'base print feed': cn.printFeed,
        'base travel feed': cn.travelFeed,
        'base chord tolerance': cn.tolerance,
        'base radius': cn.radius,
        'base wall height': cn.height,
      };
      for (const name in cnChecks) {
        if (!isPos(cnChecks[name])) return 'Enter a valid ' + name + ' (must be greater than 0).';
      }
      if (!Number.isFinite(cn.centerX) || !Number.isFinite(cn.centerY)) return 'Enter valid base bed center X/Y.';
      if (!(cn.bottomFillet >= 0)) return 'Base fillet height must be 0 or more.';
      if (!isPos(cn.bottom) || !isPos(cn.top)) return 'Base profile scales must be greater than 0.';
      if (!(cn.midCount >= 0 && cn.midCount <= PROF_MID_MAX))
        return 'Base middle points must be between 0 and ' + PROF_MID_MAX + '.';
      for (const m of cn.midPoints) {
        if (!Number.isFinite(m.h) || m.h < 0 || m.h > 1) return 'Base middle height must be between 0 and 1.';
        if (!isPos(m.s)) return 'Base middle scale must be greater than 0.';
      }
      const cnpErr = validatePrinter(cn);
      if (cnpErr) return 'Base: ' + cnpErr;

      const lidChecks = {
        'lid print feed': lid.printFeed,
        'lid travel feed': lid.travelFeed,
        'lid chord tolerance': lid.tolerance,
        'lid straight height': lid.straightHeight,
      };
      for (const name in lidChecks) {
        if (!isPos(lidChecks[name])) return 'Enter a valid ' + name + ' (must be greater than 0).';
      }
      if (!Number.isFinite(lid.centerX) || !Number.isFinite(lid.centerY)) return 'Enter valid lid bed center X/Y.';
      if (!(lid.fillet >= 0)) return 'Lid fillet height must be 0 or more.';
      if (!Number.isFinite(lid.fitTolerance)) return 'Enter a valid lid fit tolerance.';
      if (!(cn.radius + cn.lineWidth + lid.fitTolerance > 0))
        return 'Lid radius (base radius + line width + fit tolerance) came out to zero or less.';
      const lidpErr = validatePrinter(lid);
      if (lidpErr) return 'Lid: ' + lidpErr;
      return null;
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
    if (!(cfg.bottomFillet >= 0)) return 'Bottom fillet height must be 0 or more.';
    if (cfg.flowFeed.enabled && !isPos(cfg.flowFeed.rate)) {
      return 'Enter a valid target volumetric flow (mm³/s).';
    }
    if (!Number.isFinite(cfg.materialDensity) || cfg.materialDensity < 0)
      return 'Material density must be 0 (skip cost) or more.';
    if (!Number.isFinite(cfg.materialPrice) || cfg.materialPrice < 0)
      return 'Material price must be 0 (skip cost) or more.';
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
      if (cfg.hanger.mode === 'double') {
        if (!isPos(cfg.hanger.gapWidthMM)) return 'Enter a valid hanger gap width (mm).';
        if (!isPos(cfg.hanger.pocketWidthMM)) return 'Enter a valid hanger pocket width (mm).';
      } else if (!isPos(cfg.hanger.pocket) || cfg.hanger.pocket > 45) {
        return 'Hanger pocket must be between 1 and 45% of the outline.';
      }
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
      if (!Number.isFinite(cfg.pattern.zAngleLowMM) || cfg.pattern.zAngleLowMM < 0)
        return 'Lower zone height must be 0 (off) or more.';
      if (!Number.isFinite(cfg.pattern.zAngleLow)) return 'Enter a valid lower zone Z-angle.';
      if (!Number.isFinite(cfg.pattern.coverage)) return 'Enter a valid pattern coverage %.';
      if (!(cfg.pattern.plBottom >= 0) || !(cfg.pattern.plTop >= 0))
        return 'Enter valid patternless layer counts.';
      if (cfg.pattern.type === 'weave') {
        if (!isPos(cfg.pattern.bumpFeed)) return 'Enter a valid bump feedrate.';
        if (!(cfg.pattern.bumps >= 1)) return 'Weave needs at least 1 bump per revolution.';
      }
      if (cfg.pattern.type === 'spikes') {
        if (!isPos(cfg.pattern.spikeDensity)) return 'Enter a valid spike density (spikes per cm²).';
        if (!Number.isFinite(cfg.pattern.spikeVar) || cfg.pattern.spikeVar < 0)
          return 'Spike length variation must be 0 or more.';
        if (!Number.isFinite(cfg.pattern.spikeDwell) || cfg.pattern.spikeDwell < 0)
          return 'Spike tip dwell must be 0 or more.';
        if (!isPos(cfg.pattern.spikeFeedOut)) return 'Enter a valid spike feedrate for the way out.';
        if (!isPos(cfg.pattern.spikeFeedTip)) return 'Enter a valid spike feedrate for the tip.';
        if (!isPos(cfg.pattern.spikeFeedIn)) return 'Enter a valid spike feedrate for the way in.';
        if (!Number.isFinite(cfg.pattern.spikeLineWidth) || cfg.pattern.spikeLineWidth < 0)
          return 'Spike line width must be 0 (same as wall) or more.';
        if (!Number.isFinite(cfg.pattern.spikeLayerHeight) || cfg.pattern.spikeLayerHeight < 0)
          return 'Spike layer height must be 0 (same as wall) or more.';
      }
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
      ['sp_printerMode', 'printer-params-sp', 'sp_printerHint'],
      ['ls_printerMode', 'printer-params-ls', 'ls_printerHint'],
      ['cn_printerMode', 'printer-params-cn', 'cn_printerHint'],
      ['cnl_printerMode', 'printer-params-cnl', 'cnl_printerHint'],
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

  // Coat hanger only: "always on" shows the plain Fan (%) field; "bumps
  // only" swaps it for independent wall/bump percentages instead, since a
  // single shared level can't express "quieter on the wall, stronger right
  // at a bump" — the whole reason for adding it.
  function syncFanFields() {
    const sel = $('fanMode');
    const bumps = !!sel && sel.value === 'bumps';
    ['pel', 'fil'].forEach((pre) => {
      const always = $(pre + 'FanAlwaysField');
      const wall = $(pre + 'FanWallField');
      const bump = $(pre + 'FanBumpField');
      if (always) always.hidden = bumps;
      if (wall) wall.hidden = !bumps;
      if (bump) bump.hidden = !bumps;
    });
  }

  function showProject(p) {
    document.querySelectorAll('.card[data-project]').forEach((el) => {
      el.hidden = el.getAttribute('data-project') !== p;
    });
    if (p === 'container') cnApplyPartVisibility();
    $('tabCordhanger').classList.toggle('active', p === 'cordhanger');
    $('tabBendstool').classList.toggle('active', p === 'bendstool');
    $('tabVessel').classList.toggle('active', p === 'vessel');
    $('tabSpoon').classList.toggle('active', p === 'spoon');
    $('tabLamp').classList.toggle('active', p === 'lamp');
    $('tabContainer').classList.toggle('active', p === 'container');
  }

  // The container tab holds base AND lid settings/output on one page,
  // switched by this toggle rather than two separate top-level tabs — cards
  // tagged data-container-part show/hide by it (on top of the normal
  // data-project show/hide above, which already narrows to "any container
  // card"), and the shared output section (3D preview/stats/warnings/
  // textarea/download) re-renders from whichever half of the last
  // generate() result matches.
  function cnApplyPartVisibility() {
    document.querySelectorAll('.card[data-container-part]').forEach((el) => {
      el.hidden = el.getAttribute('data-container-part') !== cnActivePart;
    });
    $('cnPartBaseBtn').classList.toggle('active', cnActivePart === 'base');
    $('cnPartLidBtn').classList.toggle('active', cnActivePart === 'lid');
  }

  function cnSetPart(part) {
    cnActivePart = part === 'lid' ? 'lid' : 'base';
    cnApplyPartVisibility();
    cnRenderOutput();
  }

  // Pushes whichever half (base/lid) of the last container generate() call
  // cnActivePart selects into the app's one shared output section — same
  // fields regenerate() itself populates for every other project.
  function cnRenderOutput() {
    if (!lastContainerResult) return;
    const r = cnActivePart === 'lid' ? lastContainerResult.lid : lastContainerResult.base;
    lastGcode = r.gcode;
    $('output').value = r.gcode;
    View3D.setPath(r.path || []);
    const s = r.stats;
    $('stats').textContent =
      Math.round(s.loops) + ' loops · ' + s.moves + ' moves · ' +
      s.materialVolume.toFixed(0) + ' mm³ · ' + (s.pathLength / 1000).toFixed(1) + ' m path' +
      (s.actualTimeMin > 0 ? ' · ~' + fmtTime(s.actualTimeMin) : '');
    showWarnings(r.warnings, false);
  }

  function showPatternParams(type) {
    document.querySelectorAll('.pattern-params').forEach((el) => {
      el.hidden = el.getAttribute('data-pattern') !== type;
    });
    $('patternHint').textContent =
      (type === 'spikes'
        ? 'Spikes: blue-noise outward "staples" — the stretch of wall each one replaces is ' +
          'pushed straight out (90°), continues at that height, then straight back in (90°) to ' +
          'rejoin, rather than tapering to a point. Base width = line width. Change seed to ' +
          're-roll. Feedrate out and feedrate in are fully independent — slow out / fast back ' +
          'in, slow both ways, or anything else. An optional tip dwell (G4) pauses right before ' +
          'heading back in; leave it at 0 for a plain back-and-forth with no pause.'
        : 'Weave: even bumps/rev = flutes · odd = woven') +
      ' Bottom feedrate (0 = use the normal print feed) applies only to the patternless bottom ' +
      'revolutions, below where the pattern starts — independent of the main print feed.';
  }

  function showHangerParams(mode) {
    document.querySelectorAll('.hang-params').forEach((el) => {
      el.hidden = el.getAttribute('data-hangmode') !== mode;
    });
    $('hangHint').textContent =
      (mode === 'double'
        ? 'Double: two smaller hangers instead of one. The gap % input now picks two anchor ' +
          'points at half that percentage either side of the seam; each gets its own gap of the ' +
          'given width (mm), bridged to a pocket of the given width (mm) at the mirrored point ' +
          'on the opposite side.'
        : 'Single: one keyhole hanger opposite the seam — gap cutout at the back + inward pocket ' +
          'at the seam, joined by tangent beziers. Keep the pocket % smaller than the gap % so the ' +
          'beziers have room.') +
      ' The first hanger loop bridges — its new sections print at the bridge feedrate, then it ' +
      'tweens back to the normal curve. Any segment in that tween zone that shifts sideways more ' +
      'than the overhang angle allows (for the current layer height) prints at the overhang ' +
      'feedrate instead, to fight sagging on steep transitions.';
  }

  // Mouse-ear brim: exactly the normal offset brim, minus the straight
  // sections — only the corner (fillet) arcs survive, each as its own
  // separate open path. A point is a fillet-arc point if it sits at
  // exactly the fillet radius from one of the 4 corner centers, checked
  // once on the un-offset wall (offsetClosed preserves point order, so the
  // same classification applies to every offset ring). Mirrors gcode.js by
  // hand, same as the hanger-loop overlay below already duplicates
  // buildHangerLoop rather than sharing generator internals.
  function mouseEarChains(cfg, base, dirSign) {
    if (cfg.shape !== 'roundedRect' || !cfg.brim || !isPos(cfg.brim.lineWidth) || !(cfg.brim.linesOuter > 0)) {
      return [];
    }
    const sp = cfg.shapeParams;
    const fl = window.Geo.roundedRectFillets(sp.width, sp.length, sp.fillet);
    const eps = Math.max(0.05, cfg.lineWidth * 0.25);
    // roundedRect() never generates a plain "straight" point — every sample
    // point lies on one of the 4 corner arcs; the straight side is purely
    // the implicit connector between the last point of one arc and the
    // first point of the next. So each point is labeled with WHICH corner
    // it belongs to, and a straight section is wherever that label changes
    // (or is unrecognized) — a run sharing one label is one corner's arc.
    function cornerOf(p) {
      for (let ci = 0; ci < fl.corners.length; ci++) {
        if (Math.abs(Math.hypot(p.x - fl.corners[ci].x, p.y - fl.corners[ci].y) - fl.rf) < eps) return ci;
      }
      return -1;
    }
    const labels = base.map(cornerOf);
    const n = labels.length;
    const runs = [];
    let boundary = -1;
    for (let i = 0; i < n; i++) {
      if (labels[i] >= 0 && labels[i] !== labels[(i - 1 + n) % n]) {
        boundary = i;
        break;
      }
    }
    if (boundary < 0) {
      if (labels[0] >= 0) runs.push({ start: 0, len: n });
    } else {
      for (let i = 0; i < n; ) {
        const idx = (boundary + i) % n;
        if (labels[idx] < 0) {
          i++;
          continue;
        }
        let len = 1;
        while (len < n && labels[(idx + len) % n] === labels[idx]) len++;
        runs.push({ start: idx, len });
        i += len;
      }
    }
    const realRuns = runs.filter((run) => run.len >= 2);
    const chains = [];
    for (let k = cfg.brim.linesOuter; k >= 1; k--) {
      const d = cfg.brim.lineWidth / 2 + cfg.lineWidth / 2 + (k - 1) * cfg.brim.lineWidth;
      const loop = window.Geo.offsetClosed(base, d, dirSign);
      realRuns.forEach((run) => {
        const arcPts = [];
        for (let i = 0; i < run.len; i++) arcPts.push(loop[(run.start + i) % n]);
        chains.push(arcPts);
      });
    }
    return chains;
  }

  // Inner brim loops, mirroring gcode.js's clamp-to-last-safe-offset exactly:
  // past the safe inward distance (checked by containment, not just area/
  // inradius, so a thin shape's rounded ends folding back on themselves
  // locally is still caught), every further line reuses the last safe
  // offset instead of overshooting into the opposite side or vanishing.
  function innerBrimLoops(cfg, base, count, dirSign) {
    const sign = dirSign || 1;
    const lw = cfg.lineWidth;
    const centroid = base.reduce((s, p) => ({ x: s.x + p.x, y: s.y + p.y }), { x: 0, y: 0 });
    centroid.x /= base.length;
    centroid.y /= base.length;
    const inradius = base.reduce((m, p) => Math.min(m, window.Geo.dist(p, centroid)), Infinity);
    function safeLoop(d) {
      if (d >= inradius) return null;
      const loop = window.Geo.offsetClosed(base, -d, sign);
      if (sign * window.Geo.signedArea(loop) <= 1e-3) return null;
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

  // The custom thread diameter/pitch fields only matter when the socket
  // dropdown is on "custom" — the E14/E27 values come from the built-in table.
  function showLampSocketParams(socket) {
    document.querySelectorAll('.lamp-socket-params').forEach((el) => {
      el.hidden = el.getAttribute('data-socket') !== socket;
    });
  }

  // Shade-shape parameter blocks. data-shape may list several shapes (the
  // transition height is shared by all three non-sphere shapes), so match on
  // membership rather than equality.
  function showLampShapeParams(shape) {
    document.querySelectorAll('.lamp-shape-params').forEach((el) => {
      el.hidden = (el.getAttribute('data-shape') || '').split(/\s+/).indexOf(shape) < 0;
    });
  }

  // Only the SELECTED middle point's own field group is ever shown (same
  // "one visible at a time" pattern as the top/bottom curve editors) — 0
  // middle points means a plain bottom-to-top loft, so the whole field
  // block hides rather than showing an empty selector.
  function showProfMidCount(count) {
    const n = Math.max(0, Math.min(PROF_MID_MAX, Math.round(count || 0)));
    $('ve_profMidFields').hidden = n === 0;
    if (veProfMidSelected > n) veProfMidSelected = Math.max(1, n);
    showSelectedProfMid();
  }

  function showSelectedProfMid() {
    const count = profMidCount();
    if (count === 0) return;
    const sel = Math.max(1, Math.min(count, veProfMidSelected));
    veProfMidSelected = sel;
    document.querySelectorAll('.ve-prof-mid').forEach((el) => {
      el.hidden = Number(el.getAttribute('data-mid')) !== sel;
    });
    const hint = $('ve_profMidSelHint');
    if (hint) hint.textContent = 'Middle point ' + sel + ' of ' + count;
  }

  function selectProfMid(n) {
    const count = profMidCount();
    if (count === 0) return;
    veProfMidSelected = Math.max(1, Math.min(count, n));
    showSelectedProfMid();
    updateShapeUI();
  }

  // Container project's own copy of the three functions above (cn_ prefix,
  // .cn-prof-mid class) — see the note by cnProfMidSelected.
  function cnShowProfMidCount(count) {
    const n = Math.max(0, Math.min(PROF_MID_MAX, Math.round(count || 0)));
    $('cn_profMidFields').hidden = n === 0;
    if (cnProfMidSelected > n) cnProfMidSelected = Math.max(1, n);
    cnShowSelectedProfMid();
  }

  function cnShowSelectedProfMid() {
    const count = cnProfMidCount();
    if (count === 0) return;
    const sel = Math.max(1, Math.min(count, cnProfMidSelected));
    cnProfMidSelected = sel;
    document.querySelectorAll('.cn-prof-mid').forEach((el) => {
      el.hidden = Number(el.getAttribute('data-mid')) !== sel;
    });
    const hint = $('cn_profMidSelHint');
    if (hint) hint.textContent = 'Middle point ' + sel + ' of ' + count;
  }

  function cnSelectProfMid(n) {
    const count = cnProfMidCount();
    if (count === 0) return;
    cnProfMidSelected = Math.max(1, Math.min(count, n));
    cnShowSelectedProfMid();
    updateShapeUI();
  }

  // The filleted bottom style always uses exactly one flat layer before it
  // starts rounding into the wall — "bottom layers" plays no part in it — so
  // that field is swapped for the fillet's own height input instead.
  function showVesselBottomStyle(style) {
    const filleted = style === 'filleted';
    $('ve_bottomLayersField').hidden = filleted;
    $('ve_filletFields').hidden = !filleted;
  }

  // The rounded-star top curve has its own outer/inner radius + point-count
  // fields, only relevant once it's actually chosen; the custom-points top
  // curve has its own separate editor.
  function showVesselTopShape(shape) {
    $('ve_topStarFields').hidden = shape !== 'roundedStar';
    $('ve_topPointsFields').hidden = shape !== 'points';
  }

  // The bottom-curve editor only matters once "custom points" (or "same as
  // top curve") is actually chosen for the bottom shape.
  function showVesselBottomShape(shape) {
    $('ve_botPtFields').hidden = shape !== 'points';
  }

  function vePtCount(kind) {
    return Math.max(3, Math.min(VE_PT_MAX, Math.round(num(vePtPrefix(kind) + 'Count')) || 5));
  }

  // Show exactly `count` of the VE_PT_MAX pre-built point field groups AS
  // CANDIDATES (i.e. selectable at all) — which ONE of those is actually
  // visible is a separate, single-point-at-a-time concern (see
  // showSelectedVePoint) so the editor never shows "a lot of numbers" at
  // once, however many points the curve has.
  function showVeCurvePointCount(kind, count) {
    const n = Math.max(3, Math.min(VE_PT_MAX, Math.round(count || 5)));
    document.querySelectorAll('.ve-' + kind + '-point').forEach((el) => {
      el.hidden = Number(el.getAttribute('data-pt')) > n;
    });
    if (vePtSelected(kind) > n) vePtSetSelected(kind, n);
    showSelectedVePoint(kind);
  }

  // Show ONLY the currently-selected point's own field group (position,
  // outward, and — top only — Z), with a "Point X of N" indicator and
  // prev/next buttons so precise selection never depends on hitting a small
  // target on the canvas. This — not a wall of up to 30 fields — is the
  // editor's actual surface: tap or drag a point on the curve preview to
  // select and adjust it instead.
  function showSelectedVePoint(kind) {
    const count = vePtCount(kind);
    const sel = Math.max(1, Math.min(count, vePtSelected(kind)));
    vePtSetSelected(kind, sel);
    document.querySelectorAll('.ve-' + kind + '-point').forEach((el) => {
      el.hidden = Number(el.getAttribute('data-pt')) !== sel;
    });
    const hint = $('ve_' + (kind === 'top' ? 'topPt' : 'botPt') + 'SelHint');
    if (hint) hint.textContent = 'Point ' + sel + ' of ' + count;
  }

  function selectVePoint(kind, n) {
    vePtSetSelected(kind, Math.max(1, Math.min(vePtCount(kind), n)));
    showSelectedVePoint(kind);
    updateShapeUI();
  }

  // Reset every visible custom-curve point's own position (u) to an even
  // spacing around the loop — point i of n at i/n, matching "by default the
  // points are evenly spaced" — without touching the outward/Z values, which
  // stay whatever they were (0 for a fresh point).
  function evenSpaceVeCurvePoints(kind, count) {
    const n = Math.max(3, Math.min(VE_PT_MAX, Math.round(count || 5)));
    const pre = vePtPrefix(kind);
    for (let i = 1; i <= n; i++) $(pre + 'U' + i).value = ((i - 1) / n).toFixed(3);
  }

  // Shuffle every visible point's own POSITION (u) — never the point count,
  // which is always a deliberate input decision, not something to
  // randomize. Each point's new position is drawn independently, so two
  // points cannot simply be given the SAME neighbor as a shared bound (that
  // still lets both land in the shared overlap and swap order) — instead
  // each point's range stops at the MIDPOINT to each of its own CURRENT
  // immediate neighbors, not the neighbor's own raw position. Two adjacent
  // points' ranges then meet exactly at that shared midpoint and never
  // overlap, so crossing is impossible by construction, not just unlikely,
  // regardless of what either point's own draw comes out to. u is cyclic (a
  // closed loop), so the smallest and largest point border each other
  // through 0/1 the same way any interior pair borders each other. A small
  // margin keeps a shuffled point from landing exactly on its own boundary.
  function shuffleVeCurvePositions(kind, rng) {
    const rand = rng || Math.random;
    const pre = vePtPrefix(kind);
    const count = vePtCount(kind);
    const us = [];
    for (let i = 1; i <= count; i++) us.push(num(pre + 'U' + i));
    const order = us.map((_, idx) => idx).sort((a, b) => us[a] - us[b]);
    const margin = 0.1;
    for (let j = 0; j < count; j++) {
      const i = order[j];
      const p = us[i];
      let left = us[order[(j - 1 + count) % count]];
      let right = us[order[(j + 1) % count]];
      if (j === 0) left -= 1; // the point just before the smallest u is one full turn back
      if (j === count - 1) right += 1; // the point just after the largest u is one full turn ahead
      const lo = (left + p) / 2;
      const hi = (p + right) / 2;
      const pad = (hi - lo) * margin;
      const u = (((lo + pad + rand() * Math.max(0, hi - lo - 2 * pad)) % 1) + 1) % 1;
      $(pre + 'U' + (i + 1)).value = u.toFixed(3);
    }
  }

  // Randomize every visible point's OUTWARD value within its own domain.
  function randomizeVeCurveR(kind, rng) {
    const rand = rng || Math.random;
    const pre = vePtPrefix(kind);
    const count = vePtCount(kind);
    const a = Math.min(num(pre + 'RandRMin'), num(pre + 'RandRMax'));
    const b = Math.max(num(pre + 'RandRMin'), num(pre + 'RandRMax'));
    for (let i = 1; i <= count; i++) {
      $(pre + 'R' + i).value = Math.round(a + rand() * (b - a));
    }
  }

  // Randomize every visible point's Z value within its own domain — top
  // curve only, since the bottom never has a Z field at all.
  function randomizeVeCurveZ(kind, rng) {
    const rand = rng || Math.random;
    const pre = vePtPrefix(kind);
    const count = vePtCount(kind);
    const a = Math.min(num(pre + 'RandZMin'), num(pre + 'RandZMax'));
    const b = Math.max(num(pre + 'RandZMin'), num(pre + 'RandZMax'));
    for (let i = 1; i <= count; i++) {
      $(pre + 'Z' + i).value = Math.round(a + rand() * (b - a));
    }
  }

  // "Make it unique" — one call combining every axis this curve has
  // (position, outward, and Z for the top curve only) so a single button
  // press produces a fresh, unrepeated shape. Point count is never
  // touched — always a deliberate input decision, not something to
  // randomize. An optional seeded rng (see mulberry32 below) lets the
  // master "randomize everything" button drive this deterministically.
  function randomizeVeCurveAll(kind, rng) {
    shuffleVeCurvePositions(kind, rng);
    randomizeVeCurveR(kind, rng);
    if (vePtHasZ(kind)) randomizeVeCurveZ(kind, rng);
  }

  // Resolve the lampshade's socket thread (diameter + pitch) — from the
  // built-in IEC 60399 table the generator itself exports, so the preview and
  // the G-code can never disagree about what an E14 or E27 actually is.
  function lampThread(cfg) {
    const ls = cfg.lamp || {};
    if (ls.socket === 'custom') return { diameter: ls.customDiameter, pitch: ls.customPitch, label: 'custom' };
    return window.GcodeGen.LAMP_SOCKETS[ls.socket] || window.GcodeGen.LAMP_SOCKETS.e27;
  }

  // Lampshade: side elevation of the revolve profile (both sides mirrored
  // about the axis), built from the same Geo.lampProfile the generator uses.
  // The profile is the thing worth seeing here — the wall angle, where the
  // fillet lands, and how much straight throat is left to grip the socket.
  function drawPreviewLamp(cfg) {
    const canvas = $('ls_preview');
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const sf = W / 600;

    const ls = cfg.lamp || {};
    const thread = lampThread(cfg);
    if (!isPos(cfg.lineWidth) || !isPos(thread.diameter) || !isPos(thread.pitch) ||
        !isPos(ls.bottomDiameter) || !isPos(ls.transitionHeight)) {
      $('ls_hint').textContent = 'Enter a valid socket, line width, bottom opening and transition height.';
      $('ls_compHint').textContent = '';
      $('ls_flowFeedHint').textContent = '';
      return;
    }
    const innerD = thread.diameter + (ls.fitTolerance || 0);
    const rThroat = (innerD + cfg.lineWidth) / 2;
    if (ls.shape === 'sphere' && !(ls.sphereDiameter / 2 > rThroat)) {
      $('ls_hint').textContent = 'Sphere diameter must be larger than the throat (⌀' + (rThroat * 2).toFixed(1) + ' mm).';
      $('ls_compHint').textContent = '';
      $('ls_flowFeedHint').textContent = '';
      return;
    }
    const prof = window.Geo.lampProfile({
      rThroat: rThroat,
      rBottom: ls.bottomDiameter / 2,
      throatLen: ls.throatLength,
      transitionH: ls.transitionHeight,
      fillet: ls.fillet,
      shape: ls.shape,
      maxAngle: ((ls.maxAngle || 0) * Math.PI) / 180,
      sphereRadius: (ls.sphereDiameter || 0) / 2,
    });
    let pts = prof.pts;
    if (ls.orientation === 'wide') pts = window.Geo.flipLampProfile(pts);
    const totalH = pts[pts.length - 1].z;
    const coneDeg = (Math.abs(prof.angle) * 180) / Math.PI;

    const joinDeg = (Math.abs(prof.joinAngle) * 180) / Math.PI;
    const widest = Math.max(...pts.map((p) => p.r)) * 2;
    $('ls_hint').textContent =
      'Throat inner ⌀' + innerD.toFixed(2) + ' mm on a ⌀' + thread.diameter + ' × ' + thread.pitch +
      ' mm thread · layer height locked to ' + thread.pitch + ' mm (the pitch) · wall reaches ' +
      coneDeg.toFixed(1) + '° from vertical (' + joinDeg.toFixed(1) + '° where it leaves the throat) · ⌀' +
      widest.toFixed(0) + ' at its widest · total height ' + totalH.toFixed(1) + ' mm' +
      (Math.abs(prof.fillet - ls.fillet) > 0.05 ? ' · fillet clamped to ' + prof.fillet.toFixed(1) + ' mm' : '');

    // Compensation read-out: the resulting bead width / layer rise at the
    // steepest point, plus the support ratio (how much of each bead lands on
    // the one below) — the number that actually predicts drooping.
    const a = Math.abs(prof.angle);
    const c = Math.max(0.05, Math.cos(a));
    const k = Math.max(0, Math.min(1, (ls.compStrength != null ? ls.compStrength : 100) / 100));
    const maxMult = ls.compMaxMult > 0 ? ls.compMaxMult : 2.5;
    let wEff = cfg.lineWidth;
    let dzEff = thread.pitch;
    if (ls.compMode === 'width') wEff = cfg.lineWidth * Math.min(maxMult, 1 + k * (1 / c - 1));
    else if (ls.compMode === 'layerHeight') dzEff = thread.pitch * (1 - k * (1 - c));
    const support = Math.max(0, 1 - (dzEff * Math.tan(a)) / wEff);

    // Feed/flow read-out. The two extremes are the base bead and the
    // compensated one, which is exactly the range flow mode has to span.
    const ff = ls.flowFeed || {};
    const aLo = window.GcodeGen.beadArea(cfg.lineWidth, ls.compMode === 'layerHeight' ? thread.pitch : dzEff);
    const aHi = window.GcodeGen.beadArea(wEff, ls.compMode === 'layerHeight' ? thread.pitch : dzEff);
    if (ff.enabled && isPos(ff.rate)) {
      const shadeRate = ff.shadeRate > 0 ? ff.shadeRate : ff.rate;
      const span = ff.transitionHeight > 0 ? ff.transitionHeight : prof.filletZ1 - prof.filletZ0;
      $('ls_flowFeedHint').textContent =
        shadeRate === ff.rate
          ? 'Feed varies ' + ((ff.rate * 60) / aHi).toFixed(0) + '–' + ((ff.rate * 60) / aLo).toFixed(0) +
            ' mm/min (bead area ' + aLo.toFixed(2) + '–' + aHi.toFixed(2) + ' mm²) to hold ' + ff.rate + ' mm³/s.'
          : 'Throat ' + ff.rate + ' → shade ' + shadeRate + ' mm³/s, ramped over ' +
            (span > 1e-9 ? span.toFixed(1) + ' mm of fillet' : '0 mm — no fillet on this shape, set a ramp height') +
            ' · feed ' + ((ff.rate * 60) / aLo).toFixed(0) + ' mm/min at the throat, ' +
            ((shadeRate * 60) / aHi).toFixed(0) + '–' + ((shadeRate * 60) / aLo).toFixed(0) + ' in the shade.';
    } else if (isPos(cfg.printFeed)) {
      $('ls_flowFeedHint').textContent =
        aHi - aLo > 0.01
          ? 'At a constant ' + cfg.printFeed + ' mm/min, flow varies ' + ((cfg.printFeed * aLo) / 60).toFixed(2) +
            '–' + ((cfg.printFeed * aHi) / 60).toFixed(2) + ' mm³/s as compensation widens the bead.'
          : 'At a constant ' + cfg.printFeed + ' mm/min: ' + ((cfg.printFeed * aLo) / 60).toFixed(2) + ' mm³/s.';
    } else {
      $('ls_flowFeedHint').textContent = '';
    }
    $('ls_compHint').textContent =
      ls.compMode === 'off'
        ? 'No compensation: ' + cfg.lineWidth + ' mm bead, ' + thread.pitch + ' mm rise — ' +
          Math.round(support * 100) + '% of each bead lands on the one below at the steepest point.' +
          (coneDeg > 50 ? ' That is steep — compensation is worth turning on.' : '')
        : 'At the steepest ' + coneDeg.toFixed(1) + '°: bead ' + wEff.toFixed(2) + ' mm, rise ' + dzEff.toFixed(2) +
          ' mm → ' + Math.round(support * 100) + '% of each bead lands on the one below' +
          (ls.compMode === 'layerHeight' ? ' (extrusion still uses the full ' + thread.pitch + ' mm, so it squeezes wider).' : '.');

    // Draw: axis, then the profile mirrored either side of it.
    const maxR = Math.max(...pts.map((p) => p.r));
    const pad = 26 * sf;
    const scale = Math.min((W / 2 - pad) / (maxR || 1), (H - 2 * pad) / (totalH || 1));
    const cxp = W / 2;
    const baseY = H - pad;
    const X = (r) => cxp + r * scale;
    const Y = (z) => baseY - z * scale;

    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1 * sf;
    ctx.setLineDash([4 * sf, 4 * sf]);
    ctx.beginPath();
    ctx.moveTo(cxp, Y(0));
    ctx.lineTo(cxp, Y(totalH));
    ctx.stroke();
    ctx.setLineDash([]);

    // Bed line.
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.moveTo(pad, Y(0));
    ctx.lineTo(W - pad, Y(0));
    ctx.stroke();

    ctx.strokeStyle = '#4f9dff';
    ctx.lineWidth = 2 * sf;
    [1, -1].forEach((side) => {
      ctx.beginPath();
      pts.forEach((p, i) => {
        const px = cxp + side * p.r * scale;
        const py = Y(p.z);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    });

    // Mark the straight throat — the part that actually grips the socket.
    const throatPts = pts.filter((p) => Math.abs(p.a) < 1e-9);
    if (throatPts.length > 1) {
      ctx.strokeStyle = '#2bd9a0';
      ctx.lineWidth = 3.5 * sf;
      [1, -1].forEach((side) => {
        ctx.beginPath();
        ctx.moveTo(cxp + side * throatPts[0].r * scale, Y(throatPts[0].z));
        ctx.lineTo(cxp + side * throatPts[throatPts.length - 1].r * scale, Y(throatPts[throatPts.length - 1].z));
        ctx.stroke();
      });
    }
  }

  // Spoon: single flat spiral + stick path, same Geo.spoonPath the generator
  // itself uses, so the preview always matches the actual G-code exactly.
  function drawPreviewSpoon(cfg) {
    const canvas = $('sp_preview');
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const sf = W / 600;

    const sp = cfg.spoon || {};
    if (!isPos(cfg.lineWidth) || !(sp.turns >= 0) || !(sp.stickLength >= 0)) {
      $('sp_hint').textContent = 'Enter a valid line width, turns, and stick length.';
      return;
    }
    if (sp.turns <= 0 && sp.stickLength <= 0) {
      $('sp_hint').textContent = 'Enter at least some turns or a stick length.';
      return;
    }
    let pts = window.Geo.spoonPath(sp.turns, sp.startRadius, cfg.lineWidth, sp.stickLength, 0.05);
    if (sp.startPoint === 'stick') pts = pts.slice().reverse();
    const endRadius = (sp.startRadius || 0) + sp.turns * cfg.lineWidth;
    const tipRadius = endRadius + sp.stickLength;

    // Bed-fit: same 45 deg rotation + bounding-box recenter the generator
    // applies, computed with the SAME shared helper so the preview always
    // matches the actual G-code exactly.
    const fit = window.GcodeGen.discBedFit(pts, cfg.centerX, cfg.centerY, window.GcodeGen.SPOON_ROTATION_DEG);
    pts = pts.map((p) => ({
      x: p.x * fit.cosR - p.y * fit.sinR + fit.shiftX,
      y: p.x * fit.sinR + p.y * fit.cosR + fit.shiftY,
    }));

    $('sp_hint').textContent =
      'Disc Ø' + (endRadius * 2).toFixed(1) + ' mm · stick tip ' + tipRadius.toFixed(1) +
      ' mm from center · ' + sp.layers + ' layer' + (sp.layers > 1 ? 's' : '') + ' (' +
      (sp.layers * cfg.layerHeight).toFixed(2) + ' mm thick) · starts at ' +
      (sp.startPoint === 'stick' ? 'the stick tip' : 'the center') + ' · bed-fit: rotated ' +
      window.GcodeGen.SPOON_ROTATION_DEG + '° → ' + fit.width.toFixed(1) + ' × ' + fit.height.toFixed(1) +
      ' mm, centered at (' + cfg.centerX + ', ' + cfg.centerY + ')' +
      (sp.stickLineWidth > 0 || sp.stickLayerHeight > 0
        ? ' · stick extrudes as ' + (sp.stickLineWidth > 0 ? sp.stickLineWidth : cfg.lineWidth) + 'x' +
          (sp.stickLayerHeight > 0 ? sp.stickLayerHeight : cfg.layerHeight) + 'mm (shape unaffected)'
        : '');

    const maxR = Math.max(fit.width, fit.height, 1) / 2;
    const pad = 20 * sf;
    const scale = (Math.min(W, H) / 2 - pad) / maxR;
    const cxp = W / 2;
    const cyp = H / 2;

    ctx.strokeStyle = '#4f9dff';
    ctx.lineWidth = 1.8 * sf;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const X = cxp + p.x * scale;
      const Y = cyp - p.y * scale;
      if (i === 0) ctx.moveTo(X, Y);
      else ctx.lineTo(X, Y);
    });
    ctx.stroke();

    // Start point marker (green) — the actual first point of the toolpath.
    ctx.fillStyle = '#2bd9a0';
    ctx.beginPath();
    ctx.arc(cxp + pts[0].x * scale, cyp - pts[0].y * scale, 3.5 * sf, 0, 2 * Math.PI);
    ctx.fill();
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
    if (cfg.project === 'spoon') {
      drawPreviewSpoon(cfg);
      return;
    }
    if (cfg.project === 'lamp') {
      drawPreviewLamp(cfg);
      return;
    }
    if (cfg.project === 'container') {
      cnDrawProfile(cfg);
      const hint = $('cnl_inheritedHint');
      if (hint) {
        hint.textContent =
          'Layer height and line width always match the base (currently ' + cfg.container.layerHeight +
          'mm / ' + cfg.container.lineWidth + 'mm) — mismatched pitch or wall thickness would keep the two ' +
          'vase-mode "threads" from engaging, so they\'re not separate settings here.';
      }
      return;
    }
    const canvas = $('preview');
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const sf = W / 600; // stroke scale so lines look the same at any backing resolution

    const dirSign = cfg.printDirection === 'cw' ? -1 : 1;
    let base;
    try {
      let rawBase = window.Geo.adaptiveShape(cfg.shape, cfg.shapeParams, isPos(cfg.tolerance) ? cfg.tolerance : 0.05);
      if (dirSign < 0) rawBase = window.Geo.reverseWinding(rawBase);
      base = window.Geo.rotateToSeam(rawBase, cfg.seamSide);
    } catch (e) {
      return;
    }
    if (!base.length || !Number.isFinite(base[0].x)) return;

    const loops = [base];
    let openChains = [];
    if (cfg.brim.enabled && isPos(cfg.brim.lineWidth)) {
      if (cfg.brim.outerStyle === 'mouseEar' && cfg.shape === 'roundedRect') {
        openChains = mouseEarChains(cfg, base, dirSign);
      } else {
        for (let k = 1; k <= cfg.brim.linesOuter; k++) {
          const d = cfg.brim.lineWidth / 2 + cfg.lineWidth / 2 + (k - 1) * cfg.brim.lineWidth;
          loops.push(window.Geo.offsetClosed(base, d, dirSign));
        }
      }
      innerBrimLoops(cfg, base, cfg.brim.linesInner, dirSign).forEach((l) => loops.push(l));
    }

    // Hanger loop overlay (dashed) — computed here so it's part of the bounds.
    let hangerLoop = null;
    if (
      cfg.hanger && cfg.hanger.enabled &&
      isPos(cfg.hanger.size) && cfg.hanger.size <= 45 && isPos(cfg.lineWidth) &&
      (cfg.hanger.mode === 'double'
        ? isPos(cfg.hanger.gapWidthMM) && isPos(cfg.hanger.pocketWidthMM)
        : isPos(cfg.hanger.pocket) && cfg.hanger.pocket <= 45)
    ) {
      try {
        hangerLoop = cfg.hanger.mode === 'double'
          ? window.Geo.buildDoubleHangerLoop(
              base, cfg.hanger.size / 100, cfg.hanger.gapWidthMM, cfg.hanger.pocketWidthMM, cfg.lineWidth, dirSign
            )
          : window.Geo.buildHangerLoop(base, cfg.hanger.size / 100, cfg.hanger.pocket / 100, cfg.lineWidth, dirSign);
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
    const isFilleted = ve.seamStyle === 'filleted';
    const hasBottom = ve.bottomLayers > 0 || isFilleted;
    $('ve_hint').textContent =
      'wall ' + (nWall * lh).toFixed(1) + ' mm (' + nWall + ' rev' + (nWall === 1 ? '' : 's') + ') · ' +
      (isFilleted
        ? '1 flat layer + ' + (ve.bottomFillet || 0) + 'mm rounded transition into the wall (continuous)'
        : hasBottom
        ? 'bottom ' + ve.bottomLayers + ' layer' + (ve.bottomLayers === 1 ? '' : 's') + ' · ' +
          (ve.seamStyle === 'spiral' ? 'true-spiral (continuous into wall)' : ve.seamStyle === 'alternating' ? 'zipper' : 'staircase') +
          ' bottom'
        : 'no bottom (open tube)') +
      ' · ' + (ve.topStyle === 'spiral' ? 'open spiral top' : 'flat ramp-down top') +
      (ve.bottomShape === 'sameAsTop'
        ? ' · bottom traces the top curve, flattened'
        : ve.bottomShape === 'points'
        ? ' · bottom is a custom ' + (ve.bottomPointsCount || 5) + '-point curve'
        : '') +
      (ve.topShape === 'roundedStar'
        ? ' · top curve blends into a ' + (ve.topStarPoints || 5) + '-point rounded star' +
          (ve.topStarZDiffPct > 0
            ? ' (inner points lift up to ' + ((ve.topStarZDiffPct / 100) * 25).toFixed(1) + 'mm, uncompensated)'
            : '')
        : ve.topShape === 'points'
        ? ' · top curve blends into a custom ' + (ve.topPointsCount || 5) + '-point curve (uncompensated)'
        : '');

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
      const isFilleted = ve.seamStyle === 'filleted';
      // The filleted style always fills the bottom (no separate layer count
      // gating it), and top-down its true-spiral fill looks identical to the
      // 'spiral' style's own — ringFill doesn't know 'filleted' by name, so
      // map to the style that actually draws the same top-down path.
      if (ve.bottomLayers > 0 || isFilleted) {
        const fillStyle = isFilleted ? 'spiral' : ve.seamStyle;
        try {
          fill = window.Geo.ringFill(
            window.Geo.offsetClosed(wall, -lw), lw, tol, fillStyle, cfg.seamSide,
            fillStyle === 'spiral' ? wall : null
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
    drawVesselCurve('top', cfg);
    drawVesselCurve('bot', cfg);
  }

  // Side silhouette: radius scale (× base max radius) vs height, mirrored,
  // with the control points marked — bottom/top (green) and every middle
  // point (the SELECTED one bigger/red, others plain). Shows exactly the
  // lofted profile the wall uses. Markers are built from the raw FIELD
  // values (ve_profBottom/ve_profTop/ve_profMidH+ve_profMid{n}), not the
  // sorted/filtered curve-building list, so a marker's position always
  // matches its own field even for a not-yet-valid middle point (e.g. two
  // points momentarily at the same height mid-drag). Each point is drawn
  // mirrored (± radius); both sides hit-test to the same field, so grabbing
  // either one drags the same value. Tap/drag wiring lives in
  // wireVesselProfileCanvas/profileDragAdjust against the hit-list stored
  // here in veProfCurveState.
  function drawVesselProfile(cfg) {
    const canvas = $('ve_profile');
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    veProfCurveState = null;
    const sf = W / 600;
    const ve = cfg.vessel;
    if (!isPos(ve.height)) return;

    const cps = window.GcodeGen.buildVesselProfileCps(ve);
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
    const maxR = Math.max.apply(null, pts.map((p) => p.r).concat([baseR * ve.bottom, baseR * ve.top])) * 1.06 || 1;
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

    const count = profMidCount();
    const sel = veProfMidSelected;
    const hit = [];
    const drawMarker = (r, z, color, radius) => {
      [r, -r].forEach((rr) => {
        const cx2 = X(rr);
        const cy2 = Y(z);
        ctx.beginPath();
        ctx.arc(cx2, cy2, radius * sf, 0, 2 * Math.PI);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 1.5 * sf;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      });
    };

    drawMarker(baseR * ve.bottom, 0, '#2bd9a0', 5);
    hit.push({ idx: 0, type: 'bottom', cx: X(baseR * ve.bottom), cy: Y(0) });
    hit.push({ idx: 0, type: 'bottom', cx: X(-baseR * ve.bottom), cy: Y(0) });
    drawMarker(baseR * ve.top, H0, '#2bd9a0', 5);
    hit.push({ idx: 0, type: 'top', cx: X(baseR * ve.top), cy: Y(H0) });
    hit.push({ idx: 0, type: 'top', cx: X(-baseR * ve.top), cy: Y(H0) });

    for (let i = 1; i <= count; i++) {
      const h = Math.max(0, Math.min(1, num('ve_profMidH' + i)));
      const s = num('ve_profMid' + i);
      const isSel = i === sel;
      drawMarker(baseR * s, h * H0, isSel ? '#ff5252' : '#4f9dff', isSel ? 7 : 5);
      hit.push({ idx: i, type: 'mid', cx: X(baseR * s), cy: Y(h * H0) });
      hit.push({ idx: i, type: 'mid', cx: X(-baseR * s), cy: Y(h * H0) });
    }

    veProfCurveState = { W: W, H: H, sx: sx, sz: sz, cxp: cxp, bottomY: bottomY, baseR: baseR, hit: hit };
  }

  // Pointer wiring for the profile canvas — tap a middle point to select it
  // (exposing its own height/scale fields below), drag any marker (bottom,
  // top, or middle) to live-adjust it. Bottom/top only ever move sideways
  // (scale) — their height is fixed at 0/1 by definition, not a choice.
  function wireVesselProfileCanvas() {
    const canvas = $('ve_profile');
    let dragging = null;

    function canvasPt(e) {
      const r = canvas.getBoundingClientRect();
      const k = canvas.width / (r.width || 1);
      return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
    }
    function hitTest(p) {
      const st = veProfCurveState;
      if (!st) return null;
      let best = null;
      let bestD = 22 * (st.W / 600);
      st.hit.forEach((h) => {
        const d = Math.hypot(p.x - h.cx, p.y - h.cy);
        if (d < bestD) {
          bestD = d;
          best = h;
        }
      });
      return best;
    }

    canvas.addEventListener('pointerdown', (e) => {
      const p = canvasPt(e);
      const found = hitTest(p);
      if (!found) return;
      dragging = found;
      canvas.setPointerCapture(e.pointerId);
      if (found.type === 'mid') selectProfMid(found.idx);
      profileDragAdjust(found, p);
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      profileDragAdjust(dragging, canvasPt(e));
      e.preventDefault();
    });
    const endDrag = () => {
      dragging = null;
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
  }

  // Container project's own copy of drawVesselProfile/wireVesselProfileCanvas
  // (cn_ prefix, cfg.container instead of cfg.vessel) — see the note by
  // cnProfMidSelected.
  function cnDrawProfile(cfg) {
    const canvas = $('cn_profile');
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    cnProfCurveState = null;
    const sf = W / 600;
    const cn = cfg.container;
    if (!cn || !isPos(cn.height)) return;

    const cps = window.GcodeGen.buildVesselProfileCps(cn);
    const prof = window.GcodeGen.makeProfile(cps);

    const baseR = isPos(cn.radius) ? cn.radius : 30;
    const H0 = cn.height;
    const N = 120;
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const hf = i / N;
      pts.push({ r: baseR * prof(hf), z: hf * H0 });
    }
    const maxR = Math.max.apply(null, pts.map((p) => p.r).concat([baseR * cn.bottom, baseR * cn.top])) * 1.06 || 1;
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

    const count = cnProfMidCount();
    const sel = cnProfMidSelected;
    const hit = [];
    const drawMarker = (r, z, color, radius) => {
      [r, -r].forEach((rr) => {
        const cx2 = X(rr);
        const cy2 = Y(z);
        ctx.beginPath();
        ctx.arc(cx2, cy2, radius * sf, 0, 2 * Math.PI);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 1.5 * sf;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      });
    };

    drawMarker(baseR * cn.bottom, 0, '#2bd9a0', 5);
    hit.push({ idx: 0, type: 'bottom', cx: X(baseR * cn.bottom), cy: Y(0) });
    hit.push({ idx: 0, type: 'bottom', cx: X(-baseR * cn.bottom), cy: Y(0) });
    drawMarker(baseR * cn.top, H0, '#2bd9a0', 5);
    hit.push({ idx: 0, type: 'top', cx: X(baseR * cn.top), cy: Y(H0) });
    hit.push({ idx: 0, type: 'top', cx: X(-baseR * cn.top), cy: Y(H0) });

    for (let i = 1; i <= count; i++) {
      const h = Math.max(0, Math.min(1, num('cn_profMidH' + i)));
      const s = num('cn_profMid' + i);
      const isSel = i === sel;
      drawMarker(baseR * s, h * H0, isSel ? '#ff5252' : '#4f9dff', isSel ? 7 : 5);
      hit.push({ idx: i, type: 'mid', cx: X(baseR * s), cy: Y(h * H0) });
      hit.push({ idx: i, type: 'mid', cx: X(-baseR * s), cy: Y(h * H0) });
    }

    cnProfCurveState = { W: W, H: H, sx: sx, sz: sz, cxp: cxp, bottomY: bottomY, baseR: baseR, hit: hit };
  }

  function cnWireProfileCanvas() {
    const canvas = $('cn_profile');
    let dragging = null;

    function canvasPt(e) {
      const r = canvas.getBoundingClientRect();
      const k = canvas.width / (r.width || 1);
      return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
    }
    function hitTest(p) {
      const st = cnProfCurveState;
      if (!st) return null;
      let best = null;
      let bestD = 22 * (st.W / 600);
      st.hit.forEach((h) => {
        const d = Math.hypot(p.x - h.cx, p.y - h.cy);
        if (d < bestD) {
          bestD = d;
          best = h;
        }
      });
      return best;
    }

    canvas.addEventListener('pointerdown', (e) => {
      const p = canvasPt(e);
      const found = hitTest(p);
      if (!found) return;
      dragging = found;
      canvas.setPointerCapture(e.pointerId);
      if (found.type === 'mid') cnSelectProfMid(found.idx);
      cnProfileDragAdjust(found, p);
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      cnProfileDragAdjust(dragging, canvasPt(e));
      e.preventDefault();
    });
    const endDragCn = () => {
      dragging = null;
    };
    canvas.addEventListener('pointerup', endDragCn);
    canvas.addEventListener('pointercancel', endDragCn);
  }

  // Shuffle every middle point's own HEIGHT at once — same non-crossing
  // guarantee as the top/bottom curve's own shuffleVeCurvePositions, and
  // for the same reason: giving each point the full range up to its
  // neighbor's raw height would let two adjacent points both land in the
  // gap between them and swap order, since they'd move simultaneously.
  // Bounding each point's range at the MIDPOINT to each neighbor instead
  // means two adjacent points' ranges meet exactly at that shared midpoint
  // and can never overlap. Bottom (0) and top (1) always count as fixed
  // neighbors — this only ever touches middle points.
  function shuffleProfMidHeights(rng) {
    const rand = rng || Math.random;
    const count = profMidCount();
    if (count === 0) return;
    const order = [];
    for (let i = 1; i <= count; i++) order.push(i);
    order.sort((a, b) => num('ve_profMidH' + a) - num('ve_profMidH' + b));
    const seq = [0].concat(order.map((i) => num('ve_profMidH' + i))).concat([1]);
    const margin = 0.1;
    for (let j = 0; j < count; j++) {
      const i = order[j];
      const left = seq[j];
      const p = seq[j + 1];
      const right = seq[j + 2];
      const lo = (left + p) / 2;
      const hi = (p + right) / 2;
      const pad = (hi - lo) * margin;
      const h = lo + pad + rand() * Math.max(0, hi - lo - 2 * pad);
      $('ve_profMidH' + i).value = h.toFixed(3);
    }
  }

  // Randomize every point's own SCALE within one shared domain — bottom,
  // top, and every middle point alike (middle points' own height is left
  // to shuffleProfMidHeights, not touched here).
  function randomizeProfScale(rng) {
    const rand = rng || Math.random;
    const a = Math.min(num('ve_profRandScaleMin'), num('ve_profRandScaleMax'));
    const b = Math.max(num('ve_profRandScaleMin'), num('ve_profRandScaleMax'));
    const pick = () => (a + rand() * (b - a)).toFixed(3);
    $('ve_profBottom').value = pick();
    $('ve_profTop').value = pick();
    const count = profMidCount();
    for (let i = 1; i <= count; i++) $('ve_profMid' + i).value = pick();
  }

  // "Make it unique" — shuffles every middle point's height AND randomizes
  // every point's scale in one call, so a single button press produces a
  // fresh, unrepeated profile. Point count is never touched. An optional
  // seeded rng (see mulberry32 below) lets the master "randomize
  // everything" button drive this deterministically.
  function randomizeProfileAll(rng) {
    shuffleProfMidHeights(rng);
    randomizeProfScale(rng);
  }

  // Deterministic PRNG (mulberry32) — the same algorithm gcode.js's own
  // pattern seed already uses for its drop layout, just not exported from
  // there, so a small self-contained copy lives here too rather than
  // reaching across module boundaries. Given the same seed, always
  // produces the same sequence, which is what lets the master "randomize
  // everything" button reproduce an exact vase from a seed number later.
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

  // Reset every visible middle point's own height to an even spacing across
  // the open (0,1) interval — point i of n at i/(n+1), so n points divide
  // the range into n+1 equal spans (bottom and top themselves are the two
  // endpoints, not part of this spacing). Mirrors evenSpaceVeCurvePoints'
  // own role for the curve editors.
  function evenSpaceProfMidHeights(count) {
    const n = Math.max(0, Math.min(PROF_MID_MAX, Math.round(count || 0)));
    for (let i = 1; i <= n; i++) $('ve_profMidH' + i).value = (i / (n + 1)).toFixed(3);
  }

  // Randomizes every axis of the vessel that's currently randomizable — the
  // radius profile always, plus the top and/or bottom curve whenever
  // they're actually set to custom points (randomizing a curve that isn't
  // in points mode would silently change fields with no visible effect,
  // which would make the seed less meaningful, not more). Point counts are
  // never touched anywhere.
  //
  // shuffleProfMidHeights/shuffleVeCurvePositions both nudge each point
  // from wherever it CURRENTLY sits — exactly right for the standalone
  // "shuffle a bit more" buttons, but wrong for a seed: the same seed would
  // then produce a different result depending on whatever was already in
  // the fields, not a reproducible one. So a seeded pass always resets
  // every position to its even-spacing baseline FIRST, then shuffles from
  // that fixed, known starting point — making the whole result a pure
  // function of (seed, point counts, mid count, randomize domains), fully
  // reproducible regardless of what was there before.
  function veRandomizeAllFromSeed(seed) {
    const rng = mulberry32(seed);
    evenSpaceProfMidHeights(profMidCount());
    randomizeProfileAll(rng);
    if ($('ve_topShape').value === 'points') {
      evenSpaceVeCurvePoints('top', vePtCount('top'));
      randomizeVeCurveAll('top', rng);
    }
    if ($('ve_bottomShape').value === 'points') {
      evenSpaceVeCurvePoints('bot', vePtCount('bot'));
      randomizeVeCurveAll('bot', rng);
    }
  }

  function veRandomizeEverything() {
    const seed = Math.floor(Math.random() * 1e9);
    $('ve_seed').value = seed;
    veRandomizeAllFromSeed(seed);
  }

  // A middle point's height can never cross past its own CURRENT immediate
  // neighbor (by height) on either side — bottom (0) and top (1) always
  // count as neighbors too. Unlike the top/bottom curve's simultaneous
  // shuffle, only ONE point ever moves during a live drag, so simply
  // clamping against the other points' own (unmoving) current values is
  // enough to guarantee no crossing here — no midpoint-splitting needed.
  function clampMidHeight(idx, desiredH) {
    const count = profMidCount();
    let lo = 0;
    let hi = 1;
    for (let i = 1; i <= count; i++) {
      if (i === idx) continue;
      const h = num('ve_profMidH' + i);
      if (h <= desiredH && h > lo) lo = h;
      if (h >= desiredH && h < hi) hi = h;
    }
    const eps = Math.min(0.02, (hi - lo) * 0.1);
    return Math.max(lo + eps, Math.min(hi - eps, desiredH));
  }

  function profileDragAdjust(hitEntry, p) {
    const st = veProfCurveState;
    if (!st) return;
    const r = Math.abs(p.x - st.cxp) / st.sx;
    const scale = Math.max(0.05, r / st.baseR);
    if (hitEntry.type === 'bottom') {
      const el = $('ve_profBottom');
      el.value = scale.toFixed(3);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (hitEntry.type === 'top') {
      const el = $('ve_profTop');
      el.value = scale.toFixed(3);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const z = (st.bottomY - p.y) / st.sz;
      const H0 = num('ve_height');
      const desiredH = H0 > 0 ? z / H0 : 0;
      const h = clampMidHeight(hitEntry.idx, Math.max(0, Math.min(1, desiredH)));
      const hEl = $('ve_profMidH' + hitEntry.idx);
      const sEl = $('ve_profMid' + hitEntry.idx);
      hEl.value = h.toFixed(3);
      sEl.value = scale.toFixed(3);
      hEl.dispatchEvent(new Event('input', { bubbles: true }));
      hEl.dispatchEvent(new Event('change', { bubbles: true }));
      sEl.dispatchEvent(new Event('input', { bubbles: true }));
      sEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  // Container project's own copy of clampMidHeight/profileDragAdjust (cn_
  // prefix) — see the note by cnProfMidSelected.
  function cnClampMidHeight(idx, desiredH) {
    const count = cnProfMidCount();
    let lo = 0;
    let hi = 1;
    for (let i = 1; i <= count; i++) {
      if (i === idx) continue;
      const h = num('cn_profMidH' + i);
      if (h <= desiredH && h > lo) lo = h;
      if (h >= desiredH && h < hi) hi = h;
    }
    const eps = Math.min(0.02, (hi - lo) * 0.1);
    return Math.max(lo + eps, Math.min(hi - eps, desiredH));
  }

  function cnProfileDragAdjust(hitEntry, p) {
    const st = cnProfCurveState;
    if (!st) return;
    const r = Math.abs(p.x - st.cxp) / st.sx;
    const scale = Math.max(0.05, r / st.baseR);
    if (hitEntry.type === 'bottom') {
      const el = $('cn_profBottom');
      el.value = scale.toFixed(3);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (hitEntry.type === 'top') {
      const el = $('cn_profTop');
      el.value = scale.toFixed(3);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const z = (st.bottomY - p.y) / st.sz;
      const H0 = num('cn_height');
      const desiredH = H0 > 0 ? z / H0 : 0;
      const h = cnClampMidHeight(hitEntry.idx, Math.max(0, Math.min(1, desiredH)));
      const hEl = $('cn_profMidH' + hitEntry.idx);
      const sEl = $('cn_profMid' + hitEntry.idx);
      hEl.value = h.toFixed(3);
      sEl.value = scale.toFixed(3);
      hEl.dispatchEvent(new Event('input', { bubbles: true }));
      hEl.dispatchEvent(new Event('change', { bubbles: true }));
      sEl.dispatchEvent(new Event('input', { bubbles: true }));
      sEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  // 2D top-down preview of one custom curve (top or bottom): the shape it
  // blends FROM (faint dashed base cross-section), the resulting
  // Catmull-Rom curve (solid blue), and one marker per control point with a
  // thin connector back to its own anchor on the base curve (so "outward"
  // reads as a displacement, not a floating dot). The selected point is
  // drawn bigger/red; for the top curve, non-selected points shade from
  // blue toward warm the more they're lifted in Z, so which points pull up
  // reads at a glance without opening each one's own fields. Tap/drag is
  // wired separately (wireVesselCurveCanvas/dragAdjust) against the hit-list
  // stored here in veCurveState[kind].
  function drawVesselCurve(kind, cfg) {
    const canvas = $(kind === 'top' ? 've_topCurveCanvas' : 've_botCurveCanvas');
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    veCurveState[kind] = null;
    if (cfg.project !== 'vessel') return;
    const ve = cfg.vessel;
    const active = kind === 'top' ? ve.topShape === 'points' : ve.bottomShape === 'points';
    if (!active) return;

    let base = null;
    try {
      base = window.Geo.rotateToSeam(
        window.Geo.adaptiveShape(cfg.shape, cfg.shapeParams, isPos(cfg.tolerance) ? cfg.tolerance : 0.05),
        cfg.seamSide
      );
    } catch (e) {
      base = null;
    }
    if (!base || !base.length || !Number.isFinite(base[0].x)) return;

    const pts = readVesselCurvePoints(kind); // field order, index i -> point (i+1)
    if (pts.length < 3) return;

    const hasZ = vePtHasZ(kind);
    const tol = isPos(cfg.tolerance) ? cfg.tolerance : 0.05;
    const sampler = window.Geo.makeSampler(base);
    const anchors = pts.map((p) => {
      const u = Math.max(0, Math.min(1, p.u));
      const s = sampler.at(u);
      const nx = s.tan.y;
      const ny = -s.tan.x;
      const mag = Math.hypot(nx, ny) || 1;
      return { u: u, base: s.pos, nx: nx / mag, ny: ny / mag, tx: s.tan.x / mag, ty: s.tan.y / mag };
    });

    let curve = null;
    try {
      const sorted = pts
        .map((p) => ({
          u: Math.max(0, Math.min(1, p.u)),
          radialMM: (Math.max(-100, Math.min(100, p.radialPct)) / 100) * 25,
          zMM: hasZ ? (Math.max(-100, Math.min(100, p.zPct)) / 100) * 25 : 0,
        }))
        .sort((a, b) => a.u - b.u);
      curve = window.Geo.customTopCurve(base, sorted, 1, tol);
    } catch (e) {
      curve = null;
    }

    const sf = W / 600;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const growBounds = (l) =>
      l.forEach((p) => {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      });
    growBounds(base);
    if (curve) growBounds(curve);
    // Include the full ±100% drag rail so the canvas never has to rescale
    // mid-drag as a point is pulled toward either extreme.
    anchors.forEach((a) => {
      growBounds([
        { x: a.base.x + a.nx * -25, y: a.base.y + a.ny * -25 },
        { x: a.base.x + a.nx * 25, y: a.base.y + a.ny * 25 },
      ]);
    });

    const pad = 30 * sf;
    const scale = Math.min((W - 2 * pad) / (maxX - minX || 1), (H - 2 * pad) / (maxY - minY || 1));
    const ox = (minX + maxX) / 2;
    const oy = (minY + maxY) / 2;
    const tx = (p) => W / 2 + (p.x - ox) * scale;
    const ty = (p) => H / 2 - (p.y - oy) * scale;

    ctx.beginPath();
    base.forEach((p, i) => (i === 0 ? ctx.moveTo(tx(p), ty(p)) : ctx.lineTo(tx(p), ty(p))));
    ctx.closePath();
    ctx.setLineDash([5 * sf, 4 * sf]);
    ctx.strokeStyle = '#5a6273';
    ctx.lineWidth = 1.2 * sf;
    ctx.stroke();
    ctx.setLineDash([]);

    if (curve) {
      ctx.beginPath();
      curve.forEach((p, i) => (i === 0 ? ctx.moveTo(tx(p), ty(p)) : ctx.lineTo(tx(p), ty(p))));
      ctx.closePath();
      ctx.strokeStyle = '#4f9dff';
      ctx.lineWidth = 2.2 * sf;
      ctx.stroke();
    }

    const sel = vePtSelected(kind);
    const hit = [];
    anchors.forEach((a, i) => {
      const idx = i + 1;
      const p = pts[i];
      const mm = (Math.max(-100, Math.min(100, p.radialPct)) / 100) * 25;
      const wx = a.base.x + a.nx * mm;
      const wy = a.base.y + a.ny * mm;
      const cx = tx({ x: wx, y: wy });
      const cy = ty({ x: wx, y: wy });
      const bx = tx(a.base);
      const by = ty(a.base);

      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(cx, cy);
      ctx.strokeStyle = 'rgba(154,163,178,0.5)';
      ctx.lineWidth = 1 * sf;
      ctx.stroke();

      const isSel = idx === sel;
      let color = isSel ? '#ff5252' : '#4f9dff';
      if (!isSel && hasZ) {
        const t = (Math.max(-100, Math.min(100, p.zPct)) + 100) / 200;
        color =
          'rgb(' + Math.round(79 + t * (255 - 79)) + ',' + Math.round(157 - t * 17) + ',' + Math.round(255 - t * 175) + ')';
      }
      ctx.beginPath();
      ctx.arc(cx, cy, (isSel ? 8 : 6) * sf, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = (isSel ? 2.5 : 1.5) * sf;
      ctx.strokeStyle = '#fff';
      ctx.stroke();

      hit.push({ idx, cx, cy, u: a.u, baseX: a.base.x, baseY: a.base.y, nx: a.nx, ny: a.ny, tx: a.tx, ty: a.ty });
    });

    veCurveState[kind] = { W, H, scale, ox, oy, perimeter: sampler.perimeter, hit };
  }

  // Pointer wiring for a curve canvas: tap a marker to select it (exposes
  // just that point's own field group + hint text below), drag a marker to
  // live-adjust its outward value. Selecting/dragging only ever touches
  // updateShapeUI's cheap live-preview path (via the input/change events
  // dragAdjust dispatches) — never a full regenerate, same as typing.
  function wireVesselCurveCanvas(kind) {
    const canvas = $(kind === 'top' ? 've_topCurveCanvas' : 've_botCurveCanvas');
    let dragIdx = -1;

    function canvasPt(e) {
      const r = canvas.getBoundingClientRect();
      const k = canvas.width / (r.width || 1);
      return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
    }
    function hitTest(p) {
      const st = veCurveState[kind];
      if (!st) return -1;
      let best = -1;
      let bestD = 22 * (st.W / 600);
      st.hit.forEach((h) => {
        const d = Math.hypot(p.x - h.cx, p.y - h.cy);
        if (d < bestD) {
          bestD = d;
          best = h.idx;
        }
      });
      return best;
    }

    canvas.addEventListener('pointerdown', (e) => {
      const p = canvasPt(e);
      const idx = hitTest(p);
      if (idx < 0) return;
      dragIdx = idx;
      canvas.setPointerCapture(e.pointerId);
      selectVePoint(kind, idx);
      dragAdjust(kind, idx, p);
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (dragIdx < 0) return;
      dragAdjust(kind, dragIdx, canvasPt(e));
      e.preventDefault();
    });
    const endDrag = () => {
      dragIdx = -1;
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
  }

  // A point's position (u) can never cross past its own CURRENT immediate
  // neighbor on either side — u is cyclic (a closed loop), so the lowest
  // and highest point border each other through 0/1 the same as any
  // interior pair. Only ONE point ever moves during a live drag (unlike
  // the simultaneous shuffle above), so simply clamping against the other
  // points' own unmoving current values is enough to guarantee that — the
  // same reasoning the profile editor's own height clamp already uses.
  function clampCurveU(kind, idx, desiredU) {
    const pre = vePtPrefix(kind);
    const count = vePtCount(kind);
    const d = ((desiredU % 1) + 1) % 1;
    const others = [];
    for (let i = 1; i <= count; i++) if (i !== idx) others.push(((num(pre + 'U' + i) % 1) + 1) % 1);
    if (!others.length) return d;
    let lo = -Infinity;
    let hi = Infinity;
    others.forEach((v) => {
      if (v <= d && v > lo) lo = v;
      if (v >= d && v < hi) hi = v;
    });
    if (lo === -Infinity) lo = Math.max.apply(null, others) - 1;
    if (hi === Infinity) hi = Math.min.apply(null, others) + 1;
    const eps = Math.min(0.01, (hi - lo) * 0.1);
    const clamped = Math.max(lo + eps, Math.min(hi - eps, d));
    return ((clamped % 1) + 1) % 1;
  }

  // Projects the pointer's world position onto point idx's own stored
  // outward normal (the SAME normal customTopCurve itself displaces along)
  // to get a new radial mm value, AND onto its stored tangent to get a new
  // position along the curve (u) — dragging in any direction combines
  // "move away from/into the curve" with "slide along it", the same way
  // the profile editor's middle points move both sideways and up/down in
  // one drag. Position is clamped so a point can never cross a neighbor
  // (clampCurveU); outward is only clamped to the field's own -100..100%
  // range. Both write into their inputs — dispatching input/change so the
  // app's existing generic wiring picks it up exactly like typing would.
  function dragAdjust(kind, idx, p) {
    const st = veCurveState[kind];
    if (!st) return;
    const h = st.hit[idx - 1];
    if (!h) return;
    const wx = st.ox + (p.x - st.W / 2) / st.scale;
    const wy = st.oy - (p.y - st.H / 2) / st.scale;
    const dx = wx - h.baseX;
    const dy = wy - h.baseY;
    const radialMM = dx * h.nx + dy * h.ny;
    const pct = Math.max(-100, Math.min(100, Math.round((radialMM / 25) * 100)));
    const rEl = $(vePtPrefix(kind) + 'R' + idx);
    if (rEl) {
      rEl.value = pct;
      rEl.dispatchEvent(new Event('input', { bubbles: true }));
      rEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (st.perimeter > 1e-6) {
      const tangentMM = dx * h.tx + dy * h.ty;
      const desiredU = h.u + tangentMM / st.perimeter;
      const newU = clampCurveU(kind, idx, desiredU);
      const uEl = $(vePtPrefix(kind) + 'U' + idx);
      if (uEl) {
        uEl.value = newU.toFixed(3);
        uEl.dispatchEvent(new Event('input', { bubbles: true }));
        uEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
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
      // +Z up; tilt mixes in depth. +y1 (not -y1): world +Y has to move
      // toward the top of the screen as the camera tilts down, the same
      // way a top view in any slicer/CAD viewer draws it -- getting the
      // sign backwards here doesn't move anything to the wrong SIDE, it
      // mirrors the apparent rotation direction of the whole toolpath
      // (a CCW print reading as CW on screen and vice versa) without
      // changing a single number in the actual G-code.
      const syp = Z * ce + y1 * se;
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
      showHangerParams(cfg.hanger.mode === 'double' ? 'double' : 'single');
      syncFanFields();
      $('flowFeedFields').hidden = !cfg.flowFeed.enabled;
      syncCordhangerFlowFeedHint(cfg);
      syncPatFlowLabels(cfg);
      syncHangFlowLabels(cfg);
      syncSpikeOutMotionHint(cfg);
      syncAccelToWallFeedHint(cfg);
    } else if (cfg.project === 'vessel') {
      showShapeParams(cfg.shape, 've-shape-params');
      showProfMidCount(cfg.vessel.midCount);
      showVesselBottomStyle(cfg.vessel.seamStyle);
      showVesselTopShape(cfg.vessel.topShape);
      showVeCurvePointCount('top', cfg.vessel.topPointsCount);
      showVesselBottomShape(cfg.vessel.bottomShape);
      showVeCurvePointCount('bot', cfg.vessel.bottomPointsCount);
    } else if (cfg.project === 'bendstool') {
      syncFoamHint(cfg);
      syncFlowFeedHint(cfg);
    } else if (cfg.project === 'spoon') {
      syncSpoonFlowFeedHint(cfg);
    } else if (cfg.project === 'lamp') {
      showLampSocketParams(cfg.lamp.socket);
      showLampShapeParams(cfg.lamp.shape);
    } else if (cfg.project === 'container') {
      cnShowProfMidCount(cfg.container.midCount);
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

  // Bump/spike and hanger bridge/overhang feed overrides can each be
  // expressed as a feed rate OR a volumetric flow (one shared toggle per
  // card, since they're independent settings by design — a spike's own
  // asymmetric out/in/tip speeds stay fully independent either way, just
  // all read in whichever unit the toggle picks). 0 still means "inherit
  // the wall's own feed" regardless of which unit mode is active.
  function feedFlowConvert(value, area, toFeed) {
    if (!isPos(value) || !isPos(area)) return null;
    return toFeed ? (value * 60) / area : (value * area) / 60;
  }

  // The arc way-out motion only makes sense climbing (a positive Z-angle,
  // in whichever zone a spike actually lands in) — a level or downward
  // spike stays a straight line regardless of this setting, since curving
  // "up first" would mean climbing away from the tip rather than toward
  // it. Told here rather than silently, since flipping this dropdown with
  // a flat/downward angle set would otherwise look like it did nothing.
  function syncSpikeOutMotionHint(cfg) {
    const hint = $('patSpikeOutMotionHint');
    if (!hint) return;
    if (cfg.pattern.type !== 'spikes' || cfg.pattern.spikeOutMotion !== 'arc') {
      hint.textContent = '';
      return;
    }
    const zAngle = cfg.pattern.zAngle || 0;
    const zAngleLow = cfg.pattern.zAngleLowMM > 0 ? cfg.pattern.zAngleLow || 0 : zAngle;
    if (zAngle <= 0 && zAngleLow <= 0) {
      hint.textContent =
        'No effect yet: the way out only arcs where a spike actually climbs (Z-angle above 0°) — ' +
        'right now it\'s flat or pointing down there, so it stays a straight line.';
    } else if (zAngle <= 0 || zAngleLow <= 0) {
      hint.textContent =
        'Arcs only in whichever zone actually climbs (Z-angle above 0°) — the other zone stays a straight line.';
    } else {
      hint.textContent =
        'The way out lifts straight up off the wall, then arcs over to arrive level at the tip — ' +
        'a true quarter circle only where the climb and reach happen to match; otherwise a stretched arc.';
    }
  }

  // The acceleration ramp only has something to do wherever the segment
  // it's smoothing out of is actually slower than the wall it rejoins —
  // otherwise there's no speed jump to cover in the first place. Applies
  // in two places that share the same underlying problem (a slow segment
  // handing straight back to the wall's own faster feed, often over a
  // very short stretch): a spike's own "feedrate in", and the wall
  // hanger's own bridge feed right after its one bridging loop. Shows the
  // same distance/feed numbers the generator itself computes for
  // whichever of those actually apply, so there's no guessing before
  // hitting Regenerate and looking at the color-coded 3D preview.
  function syncAccelToWallFeedHint(cfg) {
    const hint = $('accelToWallFeedHint');
    if (!hint) return;
    if (!(cfg.accelToWallFeed > 0)) {
      hint.textContent = '';
      return;
    }
    let wallFeed = cfg.printFeed;
    if (cfg.flowFeed.enabled && isPos(cfg.flowFeed.rate) && isPos(cfg.lineWidth) && isPos(cfg.layerHeight)) {
      wallFeed = (cfg.flowFeed.rate * 60) / window.GcodeGen.beadArea(cfg.lineWidth, cfg.layerHeight);
    }
    const rampDistStr = (v0) => {
      if (!isPos(v0) || wallFeed <= v0) return null;
      const v0mmps = v0 / 60;
      const v1mmps = wallFeed / 60;
      const dist = (v1mmps * v1mmps - v0mmps * v0mmps) / (2 * cfg.accelToWallFeed);
      return dist.toFixed(1);
    };
    const parts = [];
    if (cfg.pattern.type === 'spikes' && cfg.pattern.enabled) {
      const d = rampDistStr(cfg.pattern.spikeFeedIn);
      parts.push(
        d == null
          ? 'spike feedrate in (' + cfg.pattern.spikeFeedIn + ' mm/min) is already at or above the wall feed — no effect there'
          : 'ramps from spike feedrate in (' + cfg.pattern.spikeFeedIn + ' mm/min) over about ' + d + 'mm after each spike'
      );
    }
    if (cfg.hanger.enabled) {
      const d = rampDistStr(cfg.hanger.bridgeFeed);
      parts.push(
        d == null
          ? 'hanger bridge feed (' + cfg.hanger.bridgeFeed + ' mm/min) is already at or above the wall feed — no effect there'
          : 'ramps from the hanger\'s bridge feed (' + cfg.hanger.bridgeFeed + ' mm/min) over about ' + d +
            'mm right after its one bridging loop'
      );
    }
    if (parts.length === 0) {
      hint.textContent = 'No effect yet — enable the pattern\'s spikes or the wall hanger for this to have anything to ramp.';
      return;
    }
    hint.textContent =
      'Up to the wall\'s ' + wallFeed.toFixed(0) + ' mm/min: ' + parts.join('; ') +
      ' — shortened if another spike or the loop\'s own end is closer than that.';
  }

  function syncPatFlowLabels(cfg) {
    const unit = cfg.pattern.flowMode ? 'mm³/s' : 'mm/min';
    const relabel = (id, base) => {
      const el = $(id);
      if (el) el.textContent = base + ' (' + unit + ')';
    };
    relabel('patBumpFeedLabel', 'Bump feedrate');
    relabel('patSpikeFeedOutLabel', 'Feedrate out');
    relabel('patSpikeFeedTipLabel', 'Feedrate tip');
    relabel('patSpikeFeedInLabel', 'Feedrate in');
    const hint = $('patFlowHint');
    if (!hint) return;
    if (!isPos(cfg.lineWidth) || !isPos(cfg.layerHeight)) {
      hint.textContent = '';
      return;
    }
    const on = cfg.pattern.flowMode;
    const area = window.GcodeGen.beadArea(cfg.lineWidth, cfg.layerHeight);
    const hasSpikeOverride = cfg.pattern.spikeLineWidth > 0 || cfg.pattern.spikeLayerHeight > 0;
    const spikeArea = hasSpikeOverride
      ? window.GcodeGen.beadArea(
          cfg.pattern.spikeLineWidth > 0 ? cfg.pattern.spikeLineWidth : cfg.lineWidth,
          cfg.pattern.spikeLayerHeight > 0 ? cfg.pattern.spikeLayerHeight : cfg.layerHeight
        )
      : area;
    const parts = [];
    const add = (label, value, a) => {
      const other = feedFlowConvert(value, a, on);
      if (other == null) return;
      parts.push(
        label + ' ' + value + (on ? ' mm³/s' : ' mm/min') + ' → ' + other.toFixed(on ? 0 : 2) +
          (on ? ' mm/min' : ' mm³/s')
      );
    };
    if (cfg.pattern.type === 'weave') add('Bump', cfg.pattern.bumpFeed, area);
    if (cfg.pattern.type === 'spikes') {
      add('Spike out', cfg.pattern.spikeFeedOut, spikeArea);
      add('Spike tip', cfg.pattern.spikeFeedTip, spikeArea);
      add('Spike in', cfg.pattern.spikeFeedIn, spikeArea);
    }
    hint.textContent = parts.join(' · ');
  }

  function syncHangFlowLabels(cfg) {
    const unit = cfg.hanger.flowMode ? 'mm³/s' : 'mm/min';
    const relabel = (id, base) => {
      const el = $(id);
      if (el) el.textContent = base + ' (' + unit + ')';
    };
    relabel('hangBridgeFeedLabel', 'Bridge feedrate');
    relabel('hangOverhangFeedLabel', 'Overhang feedrate');
    const hint = $('hangFlowHint');
    if (!hint) return;
    if (!isPos(cfg.lineWidth) || !isPos(cfg.layerHeight)) {
      hint.textContent = '';
      return;
    }
    const on = cfg.hanger.flowMode;
    const area = window.GcodeGen.beadArea(cfg.lineWidth, cfg.layerHeight);
    const parts = [];
    const add = (label, value) => {
      const other = feedFlowConvert(value, area, on);
      if (other == null) return;
      parts.push(
        label + ' ' + value + (on ? ' mm³/s' : ' mm/min') + ' → ' + other.toFixed(on ? 0 : 2) +
          (on ? ' mm/min' : ' mm³/s')
      );
    };
    add('Bridge', cfg.hanger.bridgeFeed);
    add('Overhang', cfg.hanger.overhangFeed);
    hint.textContent = parts.join(' · ');
  }

  // Coat hanger only: the cross-section never varies (no dome, no radius
  // profile), so — unlike the bend stool's own version above — this is one
  // constant feed for one constant flow, not a range.
  function syncCordhangerFlowFeedHint(cfg) {
    const hint = $('flowFeedHint');
    if (!hint) return;
    if (!isPos(cfg.lineWidth) || !isPos(cfg.layerHeight)) {
      hint.textContent = '';
      return;
    }
    const area = window.GcodeGen.beadArea(cfg.lineWidth, cfg.layerHeight);
    if (cfg.flowFeed.enabled && isPos(cfg.flowFeed.rate)) {
      const feed = (cfg.flowFeed.rate * 60) / area;
      hint.textContent =
        'Wall print feed: ' + feed.toFixed(0) + ' mm/min (bead area ' + area.toFixed(2) +
        ' mm²) to hold ' + cfg.flowFeed.rate + ' mm³/s. A bump, spike, or hanger-bridge feed ' +
        'override still applies exactly as set, on top of this.';
    } else if (isPos(cfg.printFeed)) {
      const flow = (cfg.printFeed * area) / 60;
      hint.textContent =
        'At a constant ' + cfg.printFeed + ' mm/min: ' + flow.toFixed(2) + ' mm³/s (bead area ' +
        area.toFixed(2) + ' mm²).';
    } else {
      hint.textContent = '';
    }
  }

  // Same idea for the spoon: the spiral and (optionally) stick have their
  // OWN bead areas (the stick's line width/layer height override, if set),
  // so a single target flow resolves to two different feeds — shown here,
  // using the SAME areas generateSpoon derives, so the numbers always match.
  function syncSpoonFlowFeedHint(cfg) {
    if (!isPos(cfg.lineWidth) || !isPos(cfg.layerHeight)) {
      $('sp_flowFeedHint').textContent = '';
      return;
    }
    const sp = cfg.spoon || {};
    const areaSpiral = window.GcodeGen.beadArea(cfg.lineWidth, cfg.layerHeight);
    const hasStickOverride = sp.stickLineWidth > 0 || sp.stickLayerHeight > 0;
    const areaStick = hasStickOverride
      ? window.GcodeGen.beadArea(
          sp.stickLineWidth > 0 ? sp.stickLineWidth : cfg.lineWidth,
          sp.stickLayerHeight > 0 ? sp.stickLayerHeight : cfg.layerHeight
        )
      : areaSpiral;
    const ff = sp.flowFeed || {};
    if (ff.enabled && isPos(ff.rate)) {
      const feedSpiral = (ff.rate * 60) / areaSpiral;
      const feedStick = (ff.rate * 60) / areaStick;
      $('sp_flowFeedHint').textContent = hasStickOverride
        ? 'Spiral feed ' + feedSpiral.toFixed(0) + ' mm/min (area ' + areaSpiral.toFixed(2) +
          ' mm²) · stick feed ' + feedStick.toFixed(0) + ' mm/min (area ' + areaStick.toFixed(2) +
          ' mm²) — both hold ' + ff.rate + ' mm³/s.'
        : 'Feed ' + feedSpiral.toFixed(0) + ' mm/min (bead area ' + areaSpiral.toFixed(2) +
          ' mm²) to hold ' + ff.rate + ' mm³/s.';
    } else if (isPos(cfg.printFeed)) {
      const spiralFeed = cfg.printFeed;
      const stickFeed = sp.stickFeed > 0 ? sp.stickFeed : cfg.printFeed;
      const flowSpiral = (spiralFeed * areaSpiral) / 60;
      const flowStick = (stickFeed * areaStick) / 60;
      $('sp_flowFeedHint').textContent =
        hasStickOverride || sp.stickFeed > 0
          ? 'Spiral: ' + spiralFeed + ' mm/min → ' + flowSpiral.toFixed(2) + ' mm³/s · Stick: ' +
            stickFeed + ' mm/min → ' + flowStick.toFixed(2) + ' mm³/s.'
          : 'At a constant ' + spiralFeed + ' mm/min: ' + flowSpiral.toFixed(2) + ' mm³/s.';
    } else {
      $('sp_flowFeedHint').textContent = '';
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

    if (cfg.project === 'container') {
      // Both G-codes come out of one generate() call (they're geometrically
      // linked — the lid's radius depends on the base, the base's collar on
      // the lid) — store both, then render whichever the Base/Lid toggle
      // currently shows into the app's one shared output section.
      lastContainerResult = result;
      cnRenderOutput();
      return;
    }

    lastGcode = result.gcode;
    $('output').value = result.gcode;
    View3D.setPath(result.path || []);

    const s = result.stats;
    // materialVolume/actualTimeMin correct for the bend stool's own foam
    // mode (less raw material, faster print, during the foamed middle
    // layers than the nominal G-code numbers alone would suggest) — equal
    // to volume/timeMin whenever foam never applies, so this is always at
    // least as accurate as the plain G-code-implied numbers.
    let statsText =
      Math.round(s.loops) + ' loops · ' + s.moves + ' moves · ' +
      s.materialVolume.toFixed(0) + ' mm³ · ' + (s.pathLength / 1000).toFixed(1) + ' m path' +
      (s.actualTimeMin > 0 ? ' · ~' + fmtTime(s.actualTimeMin) : '');
    if (
      (cfg.project === 'cordhanger' || cfg.project === 'bendstool') &&
      isPos(cfg.materialDensity) &&
      isPos(cfg.materialPrice)
    ) {
      // mm^3 -> cm^3 (/1000) -> g (x density) -> kg (/1000): /1e6 combined.
      const massKg = (s.materialVolume * cfg.materialDensity) / 1e6;
      const cost = massKg * cfg.materialPrice;
      statsText += ' · ' + massKg.toFixed(3) + ' kg · ' + cost.toFixed(2) + ' material cost';
    }
    $('stats').textContent = statsText;

    showWarnings(result.warnings, false);
  }

  // A failed regenerate must not leave the PREVIOUS G-code exportable — on a
  // printing tool that ships the wrong file to the machine. Clear it all.
  function regenFailed(msgs) {
    showWarnings(msgs, true);
    $('stats').textContent = '';
    lastGcode = '';
    $('output').value = '';
    lastContainerResult = null;
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
        : p === 'spoon'
        ? 'spoon'
        : p === 'lamp'
        ? 'lampshade'
        : p === 'container'
        ? 'container_' + cnActivePart
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
    const dirSign = cfg.printDirection === 'cw' ? -1 : 1;
    let rawBase = window.Geo.adaptiveShape(cfg.shape, cfg.shapeParams, isPos(cfg.tolerance) ? cfg.tolerance : 0.05);
    if (dirSign < 0) rawBase = window.Geo.reverseWinding(rawBase);
    const base = window.Geo.rotateToSeam(rawBase, cfg.seamSide);
    const gapFrac = cfg.hanger.size / 100;
    const hangerLoop = window.Geo.buildHangerLoop(base, gapFrac, cfg.hanger.pocket / 100, cfg.lineWidth, dirSign);

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
    if (cfg.hanger.mode === 'double') {
      flash(btn, 'SVG export is single-hanger only for now');
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
    [
      'preview', 'previewBS', 've_preview', 've_profile', 've_topCurveCanvas', 've_botCurveCanvas',
      'sp_preview', 'ls_preview', 'preview3d', 'cn_profile',
    ].forEach((id) => {
      const c = $(id);
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const w = c.clientWidth || 600;
      // Cap the backing store so a canvas can never feed back into its own
      // layout size and grow without bound (belt-and-braces vs missing CSS).
      const px = Math.min(1600, Math.round(w * dpr));
      // Backing store must match the CSS aspect ratio or the drawing skews.
      const ratio = { ve_profile: 0.6, ls_preview: 0.75, cn_profile: 0.6 }[id] || 1;
      const py = Math.round(px * ratio);
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
    $('flowFeedFields').hidden = !$('flowFeedEnabled').checked;
    syncFanFields();
    $('patternFields').hidden = !$('patternEnabled').checked;
    $('hangFields').hidden = !$('hangEnabled').checked;
    $('hangFields2').hidden = !$('hangEnabled').checked;
    $('hangFields2b').hidden = !$('hangEnabled').checked;
    showHangerParams($('hangMode').value === 'double' ? 'double' : 'single');
    $('bs_brimFields').hidden = !$('bs_brimEnabled').checked;
    $('bs_legFields').hidden = !$('bs_legsEnabled').checked;
    $('bs_foamFields').hidden = !$('bs_foamEnabled').checked;
    $('bs_foamPrimerFields').hidden = !$('bs_foamEnabled').checked;
    $('bs_flowFeedFields').hidden = !$('bs_flowFeedEnabled').checked;
    $('ve_brimFields').hidden = !$('ve_brimEnabled').checked;
    $('sp_flowFeedFields').hidden = !$('sp_flowFeedEnabled').checked;
    $('ls_brimFields').hidden = !$('ls_brimEnabled').checked;
    $('ls_flowFeedFields').hidden = !$('ls_flowFeedEnabled').checked;
    showLampSocketParams($('ls_socket').value);
    showLampShapeParams($('ls_shape').value);
    showProfMidCount(num('ve_profMidCount'));
    showVesselBottomStyle($('ve_seamStyle').value);
    showVesselTopShape($('ve_topShape').value);
    showVeCurvePointCount('top', num('ve_topPtCount'));
    showVesselBottomShape($('ve_bottomShape').value);
    showVeCurvePointCount('bot', num('ve_botPtCount'));
    cnShowProfMidCount(num('cn_profMidCount'));
    cnSetPart(cnActivePart);
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
    materialDensity: 'bs_materialDensity', materialPrice: 'bs_materialPrice',
    startEndEnabled: 'bs_startEndEnabled', endLift: 'bs_endLift',
    filDiameter: 'bs_filDiameter', filNozzleTemp: 'bs_filNozzleTemp',
    filBedTemp: 'bs_filBedTemp', filFan: 'bs_filFan',
    pelUpTemp: 'bs_pelUpTemp', pelMidTemp: 'bs_pelMidTemp', pelDownTemp: 'bs_pelDownTemp',
    pelBedTemp: 'bs_pelBedTemp', pelPA: 'bs_pelPA', pelPurge: 'bs_pelPurge', pelFan: 'bs_pelFan',
    brimEnabled: 'bs_brimEnabled', brimOuterStyle: 'bs_brimOuterStyle',
    brimLinesOuter: 'bs_brimLinesOuter', brimLinesInner: 'bs_brimLinesInner',
    brimLineWidth: 'bs_brimLineWidth', brimLayerHeight: 'bs_brimLayerHeight', brimFeed: 'bs_brimFeed',
    brimMultiplier: 'bs_brimMultiplier',
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
    startEndEnabled: 've_startEndEnabled', endLift: 've_endLift',
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
    brimMultiplier: 've_brimMultiplier',
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

  // Same idea for the spoon: seed its generic print/printer settings from the
  // cord hanger the first time it appears, then it stays independent. No
  // shape fields to seed — the spiral has its own, unrelated params.
  const SEED_MAP_SP = {
    layerHeight: 'sp_layerHeight', lineWidth: 'sp_lineWidth',
    printFeed: 'sp_printFeed', travelFeed: 'sp_travelFeed',
    centerX: 'sp_centerX', centerY: 'sp_centerY',
    printerMode: 'sp_printerMode', extrusionMultiplier: 'sp_extrusionMultiplier',
    startEndEnabled: 'sp_startEndEnabled', endLift: 'sp_endLift',
    filDiameter: 'sp_filDiameter', filNozzleTemp: 'sp_filNozzleTemp',
    filBedTemp: 'sp_filBedTemp', filFan: 'sp_filFan',
    pelUpTemp: 'sp_pelUpTemp', pelMidTemp: 'sp_pelMidTemp', pelDownTemp: 'sp_pelDownTemp',
    pelBedTemp: 'sp_pelBedTemp', pelPA: 'sp_pelPA', pelPurge: 'sp_pelPurge', pelFan: 'sp_pelFan',
  };

  function seedSpoon() {
    Object.keys(SEED_MAP_SP).forEach((src) => {
      const a = $(src);
      const b = $(SEED_MAP_SP[src]);
      if (!a || !b) return;
      if (a.type === 'checkbox') b.checked = a.checked;
      else b.value = a.value;
    });
  }

  // Same again for the lampshade. Layer height is deliberately NOT seeded —
  // it's the socket's thread pitch, not a free setting on this project.
  const SEED_MAP_LS = {
    lineWidth: 'ls_lineWidth', printFeed: 'ls_printFeed', travelFeed: 'ls_travelFeed',
    tolerance: 'ls_tolerance', centerX: 'ls_centerX', centerY: 'ls_centerY',
    printerMode: 'ls_printerMode', extrusionMultiplier: 'ls_extrusionMultiplier',
    startEndEnabled: 'ls_startEndEnabled', endLift: 'ls_endLift',
    filDiameter: 'ls_filDiameter', filNozzleTemp: 'ls_filNozzleTemp',
    filBedTemp: 'ls_filBedTemp', filFan: 'ls_filFan',
    pelUpTemp: 'ls_pelUpTemp', pelMidTemp: 'ls_pelMidTemp', pelDownTemp: 'ls_pelDownTemp',
    pelBedTemp: 'ls_pelBedTemp', pelPA: 'ls_pelPA', pelPurge: 'ls_pelPurge', pelFan: 'ls_pelFan',
    brimEnabled: 'ls_brimEnabled', brimLinesOuter: 'ls_brimLinesOuter',
    brimLayerHeight: 'ls_brimLayerHeight', brimMultiplier: 'ls_brimMultiplier',
    bs_flowFeedEnabled: 'ls_flowFeedEnabled', bs_flowFeedRate: 'ls_flowFeedRate',
    brimLineWidth: 'ls_brimLineWidth', brimFeed: 'ls_brimFeed',
  };

  function seedLamp() {
    Object.keys(SEED_MAP_LS).forEach((src) => {
      const a = $(src);
      const b = $(SEED_MAP_LS[src]);
      if (!a || !b) return;
      if (a.type === 'checkbox') b.checked = a.checked;
      else b.value = a.value;
    });
    $('ls_brimFields').hidden = !$('ls_brimEnabled').checked;
    $('ls_flowFeedFields').hidden = !$('ls_flowFeedEnabled').checked;
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
    $('hangFields2').hidden = !$('hangEnabled').checked;
    $('hangFields2b').hidden = !$('hangEnabled').checked;
    updateShapeUI();
  });
  $('hangMode').addEventListener('change', () => {
    showHangerParams($('hangMode').value === 'double' ? 'double' : 'single');
    updateShapeUI();
  });
  $('hangExportSvgBtn').addEventListener('click', exportHangerSvg);

  ['top', 'bot'].forEach((kind) => {
    const pre = vePtPrefix(kind);
    $(pre + 'Count').addEventListener('change', () => {
      evenSpaceVeCurvePoints(kind, num(pre + 'Count'));
      showVeCurvePointCount(kind, num(pre + 'Count'));
      updateShapeUI();
    });
    $(pre + 'PrevBtn').addEventListener('click', () => selectVePoint(kind, vePtSelected(kind) - 1));
    $(pre + 'NextBtn').addEventListener('click', () => selectVePoint(kind, vePtSelected(kind) + 1));
    $(pre + 'ShuffleBtn').addEventListener('click', () => {
      shuffleVeCurvePositions(kind);
      updateShapeUI();
    });
    $(pre + 'RandRBtn').addEventListener('click', () => {
      randomizeVeCurveR(kind);
      updateShapeUI();
    });
    wireVesselCurveCanvas(kind);
  });
  $('ve_topPtRandZBtn').addEventListener('click', () => {
    randomizeVeCurveZ('top');
    updateShapeUI();
  });
  $('ve_topPtRandomizeAllBtn').addEventListener('click', () => {
    randomizeVeCurveAll('top');
    updateShapeUI();
  });

  $('ve_profMidCount').addEventListener('change', () => {
    showProfMidCount(num('ve_profMidCount'));
    updateShapeUI();
  });
  $('ve_profMidPrevBtn').addEventListener('click', () => selectProfMid(veProfMidSelected - 1));
  $('ve_profMidNextBtn').addEventListener('click', () => selectProfMid(veProfMidSelected + 1));
  $('ve_profRandomizeBtn').addEventListener('click', () => {
    randomizeProfileAll();
    updateShapeUI();
  });
  wireVesselProfileCanvas();

  $('ve_randomizeAllBtn').addEventListener('click', () => {
    veRandomizeEverything();
    updateShapeUI();
  });
  $('ve_seed').addEventListener('change', () => {
    veRandomizeAllFromSeed(Math.max(0, Math.round(num('ve_seed'))));
    updateShapeUI();
  });

  $('cn_profMidCount').addEventListener('change', () => {
    cnShowProfMidCount(num('cn_profMidCount'));
    updateShapeUI();
  });
  $('cn_profMidPrevBtn').addEventListener('click', () => cnSelectProfMid(cnProfMidSelected - 1));
  $('cn_profMidNextBtn').addEventListener('click', () => cnSelectProfMid(cnProfMidSelected + 1));
  cnWireProfileCanvas();
  $('cnPartBaseBtn').addEventListener('click', () => cnSetPart('base'));
  $('cnPartLidBtn').addEventListener('click', () => cnSetPart('lid'));

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

  $('sp_flowFeedEnabled').addEventListener('change', () => {
    $('sp_flowFeedFields').hidden = !$('sp_flowFeedEnabled').checked;
    updateShapeUI();
  });

  $('ls_brimEnabled').addEventListener('change', () => {
    $('ls_brimFields').hidden = !$('ls_brimEnabled').checked;
    updateShapeUI();
  });

  $('ls_flowFeedEnabled').addEventListener('change', () => {
    $('ls_flowFeedFields').hidden = !$('ls_flowFeedEnabled').checked;
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
  $('tabSpoon').addEventListener('click', () => switchProject('spoon'));
  $('tabLamp').addEventListener('click', () => switchProject('lamp'));
  $('tabContainer').addEventListener('click', () => switchProject('container'));

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
  if (restored && !('sp_layerHeight' in restored)) seedSpoon();
  if (restored && !('ls_lineWidth' in restored)) seedLamp();
  showProject(activeProject());
  fitCanvases();
  updateShapeUI();
  regenerate();
})();
