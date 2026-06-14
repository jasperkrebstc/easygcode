/*
 * app.js — UI wiring. Reads inputs, regenerates G-code live, draws the preview,
 * and handles copy / download / share.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const num = (id) => parseFloat($(id).value);

  let lastGcode = '';

  function readConfig() {
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
      shape,
      shapeParams,
      layerHeight: num('layerHeight'),
      lineWidth: num('lineWidth'),
      totalHeight: num('totalHeight'),
      printFeed: num('printFeed'),
      travelFeed: num('travelFeed'),
      points: Math.max(8, Math.round(num('points'))),
      centerX: num('centerX'),
      centerY: num('centerY'),
      brim: {
        enabled: $('brimEnabled').checked,
        outer: $('brimOuter').value === 'outer',
        lines: Math.max(0, Math.round(num('brimLines'))),
        lineWidth: num('brimLineWidth'),
        layerHeight: num('brimLayerHeight'),
      },
    };
  }

  function showShapeParams(shape) {
    document.querySelectorAll('.shape-params').forEach((el) => {
      el.hidden = el.getAttribute('data-shape') !== shape;
    });
  }

  function drawPreview(cfg) {
    const canvas = $('preview');
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    let dense, base;
    try {
      dense = window.Geo.makeShape(cfg.shape, cfg.shapeParams);
      base = window.Geo.resampleClosed(dense, cfg.points);
    } catch (e) {
      return;
    }

    // Collect all loops (base + brim) to compute bounds for auto-fit.
    const loops = [base];
    if (cfg.brim.enabled && cfg.brim.lines > 0) {
      const dir = cfg.brim.outer ? 1 : -1;
      for (let k = 1; k <= cfg.brim.lines; k++) {
        const d = cfg.brim.lineWidth / 2 + cfg.lineWidth / 2 + (k - 1) * cfg.brim.lineWidth;
        loops.push(window.Geo.offsetClosed(base, dir * d));
      }
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    loops.forEach((loop) =>
      loop.forEach((p) => {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      })
    );

    const pad = 30;
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
    const ox = (minX + maxX) / 2;
    const oy = (minY + maxY) / 2;
    // y is flipped so the preview matches printer orientation (Y up).
    const tx = (p) => W / 2 + (p.x - ox) * scale;
    const ty = (p) => H / 2 - (p.y - oy) * scale;

    function stroke(loop, color, width) {
      ctx.beginPath();
      loop.forEach((p, i) => {
        const X = tx(p), Y = ty(p);
        if (i === 0) ctx.moveTo(X, Y);
        else ctx.lineTo(X, Y);
      });
      ctx.closePath();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    }

    // brim loops first (dimmer)
    for (let k = 1; k < loops.length; k++) stroke(loops[k], '#2bd9a0', 1.5);
    stroke(base, '#4f9dff', 2.5);
  }

  function regenerate() {
    const cfg = readConfig();
    showShapeParams(cfg.shape);
    drawPreview(cfg);

    let result;
    try {
      result = window.GcodeGen.generate(cfg);
    } catch (e) {
      $('output').value = '; error: ' + e.message;
      return;
    }

    lastGcode = result.gcode;
    $('output').value = result.gcode;

    const s = result.stats;
    $('stats').textContent =
      Math.round(s.loops) +
      ' loops · ' +
      s.moves +
      ' moves · ' +
      s.volume.toFixed(0) +
      ' mm³ · ' +
      (s.pathLength / 1000).toFixed(1) +
      ' m path';

    const warn = $('warnings');
    warn.innerHTML = '';
    result.warnings.forEach((w) => {
      const d = document.createElement('div');
      d.textContent = '⚠ ' + w;
      warn.appendChild(d);
    });
  }

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
        /* user cancelled or unsupported — fall back */
      }
    }
    download();
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(lastGcode);
      flash($('copyBtn'), 'Copied!');
    } catch (e) {
      $('output').select();
      document.execCommand('copy');
      flash($('copyBtn'), 'Copied!');
    }
  }

  function flash(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(() => (btn.textContent = old), 1200);
  }

  // ---- wire up ----
  document.querySelectorAll('input, select').forEach((el) => {
    el.addEventListener('input', regenerate);
    el.addEventListener('change', regenerate);
  });

  $('brimEnabled').addEventListener('change', () => {
    $('brimFields').hidden = !$('brimEnabled').checked;
  });

  $('copyBtn').addEventListener('click', copy);
  $('downloadBtn').addEventListener('click', download);
  $('shareBtn').addEventListener('click', share);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  regenerate();
})();
