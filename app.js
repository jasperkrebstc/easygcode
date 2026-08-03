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
    return v === 'bendstool' || v === 'vessel' || v === 'spoon' || v === 'lamp' ? v : 'cordhanger';
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
          seamStyle: ['alternating', 'spiral'].indexOf($('ve_seamStyle').value) >= 0 ? $('ve_seamStyle').value : 'staircase',
          topStyle: $('ve_topStyle').value === 'spiral' ? 'spiral' : 'flat',
          bottom: num('ve_profBottom'),
          profileCount: Math.max(2, Math.min(5, Math.round(num('ve_profileCount')))),
          midPoints: [
            { h: num('ve_profMidH1'), s: num('ve_profMid1') },
            { h: num('ve_profMidH2'), s: num('ve_profMid2') },
            { h: num('ve_profMidH3'), s: num('ve_profMid3') },
          ].slice(0, Math.max(0, Math.min(5, Math.round(num('ve_profileCount'))) - 2)),
          top: num('ve_profTop'),
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
      printFeed: num('printFeed'),
      travelFeed: num('travelFeed'),
      tolerance: num('tolerance'),
      seamSide: $('seamSide').value,
      printDirection: $('printDirection').value === 'cw' ? 'cw' : 'ccw',
      centerX: num('centerX'),
      centerY: num('centerY'),
      fanMode: $('fanMode').value === 'bumps' ? 'bumps' : 'always',
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
        spikeDensity: Math.max(0, num('patSpikeDensity')),
        spikeVar: Math.max(0, num('patSpikeVar')),
        seed: Math.max(0, Math.round(num('patSeed'))),
        spikeBalance: $('patSpikeBalance').value === 'on',
        spikeDwell: Math.max(0, num('patSpikeDwell')),
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
      if (!(pr.profileCount >= 2 && pr.profileCount <= 5))
        return 'Profile points must be between 2 and 5.';
      for (const m of pr.midPoints) {
        if (!Number.isFinite(m.h) || m.h < 0 || m.h > 1) return 'Middle height must be between 0 and 1.';
        if (!isPos(m.s)) return 'Middle scale must be greater than 0.';
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
      if (!Number.isFinite(cfg.pattern.coverage)) return 'Enter a valid pattern coverage %.';
      if (!(cfg.pattern.plBottom >= 0) || !(cfg.pattern.plTop >= 0))
        return 'Enter valid patternless layer counts.';
      if (!Number.isFinite(cfg.pattern.bottomFeed) || cfg.pattern.bottomFeed < 0)
        return 'Enter a valid bottom feedrate (0 to use the normal print feed).';
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
    $('tabSpoon').classList.toggle('active', p === 'spoon');
    $('tabLamp').classList.toggle('active', p === 'lamp');
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

  // Show exactly (profileCount - 2) of the vessel's 3 pre-built middle-point
  // field pairs — 2 points means none at all (a plain bottom-to-top loft).
  function showVesselMidPoints(count) {
    const n = Math.max(0, Math.min(3, Math.round(count || 3) - 2));
    document.querySelectorAll('.ve-mid-point').forEach((el) => {
      el.hidden = Number(el.getAttribute('data-mid')) > n;
    });
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
      showHangerParams(cfg.hanger.mode === 'double' ? 'double' : 'single');
    } else if (cfg.project === 'vessel') {
      showShapeParams(cfg.shape, 've-shape-params');
      showVesselMidPoints(cfg.vessel.profileCount);
    } else if (cfg.project === 'bendstool') {
      syncFoamHint(cfg);
      syncFlowFeedHint(cfg);
    } else if (cfg.project === 'spoon') {
      syncSpoonFlowFeedHint(cfg);
    } else if (cfg.project === 'lamp') {
      showLampSocketParams(cfg.lamp.socket);
      showLampShapeParams(cfg.lamp.shape);
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
    ['preview', 'previewBS', 've_preview', 've_profile', 'sp_preview', 'ls_preview', 'preview3d'].forEach((id) => {
      const c = $(id);
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const w = c.clientWidth || 600;
      // Cap the backing store so a canvas can never feed back into its own
      // layout size and grow without bound (belt-and-braces vs missing CSS).
      const px = Math.min(1600, Math.round(w * dpr));
      // Backing store must match the CSS aspect ratio or the drawing skews.
      const ratio = { ve_profile: 0.6, ls_preview: 0.75 }[id] || 1;
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
    $('patternFields').hidden = !$('patternEnabled').checked;
    $('hangFields').hidden = !$('hangEnabled').checked;
    $('hangFields2').hidden = !$('hangEnabled').checked;
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
    updateShapeUI();
  });
  $('hangMode').addEventListener('change', () => {
    showHangerParams($('hangMode').value === 'double' ? 'double' : 'single');
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
