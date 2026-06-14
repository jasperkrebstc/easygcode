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
      points: Math.max(8, Math.round(num('resolution'))),
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

  // Returns an error string if the config can't be generated, else null.
  function validate(cfg) {
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
    if (!Number.isFinite(num('resolution')) || num('resolution') < 8)
      return 'Resolution must be at least 8 points.';
    for (const k in cfg.shapeParams) {
      const v = cfg.shapeParams[k];
      if (!Number.isFinite(v)) return 'Enter a valid value for ' + k + '.';
      if (k !== 'fillet' && v <= 0) return 'Shape value "' + k + '" must be greater than 0.';
    }
    if (cfg.brim.enabled) {
      if (cfg.brim.lines < 1) return 'Brim needs at least 1 line.';
      if (!isPos(cfg.brim.lineWidth)) return 'Enter a valid brim line width.';
      if (!isPos(cfg.brim.layerHeight)) return 'Enter a valid brim layer height.';
    }
    return null;
  }

  function showShapeParams(shape) {
    document.querySelectorAll('.shape-params').forEach((el) => {
      el.hidden = el.getAttribute('data-shape') !== shape;
    });
  }

  // --- Live 2D cross-section preview ---
  function drawPreview(cfg) {
    const canvas = $('preview');
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    let base;
    try {
      base = window.Geo.resampleClosed(window.Geo.makeShape(cfg.shape, cfg.shapeParams), cfg.points);
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

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    loops.forEach((loop) =>
      loop.forEach((p) => {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      })
    );
    if (!Number.isFinite(minX)) return;

    const pad = 30;
    const scale = Math.min((W - 2 * pad) / (maxX - minX || 1), (H - 2 * pad) / (maxY - minY || 1));
    const ox = (minX + maxX) / 2;
    const oy = (minY + maxY) / 2;
    const tx = (p) => W / 2 + (p.x - ox) * scale;
    const ty = (p) => H / 2 - (p.y - oy) * scale;

    function stroke(loop, color, width) {
      ctx.beginPath();
      loop.forEach((p, i) => (i === 0 ? ctx.moveTo(tx(p), ty(p)) : ctx.lineTo(tx(p), ty(p))));
      ctx.closePath();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    }
    for (let k = 1; k < loops.length; k++) stroke(loops[k], '#2bd9a0', 1.5);
    stroke(base, '#4f9dff', 2.5);
  }

  // --- Simple 3D toolpath viewer (orbit by drag, orthographic) ---
  const View3D = (function () {
    let canvas, ctx;
    let pts = [];
    let az = -0.7;
    let el = 1.15;
    let dragging = false;
    let lastX = 0, lastY = 0;

    function init() {
      canvas = $('preview3d');
      ctx = canvas.getContext('2d');
      canvas.addEventListener('pointerdown', (e) => {
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        canvas.setPointerCapture(e.pointerId);
      });
      canvas.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        az += (e.clientX - lastX) * 0.01;
        el += (e.clientY - lastY) * 0.01;
        el = Math.max(0.05, Math.min(Math.PI - 0.05, el));
        lastX = e.clientX;
        lastY = e.clientY;
        e.preventDefault();
        render();
      });
      const stop = () => (dragging = false);
      canvas.addEventListener('pointerup', stop);
      canvas.addEventListener('pointercancel', stop);
    }

    function setPath(path) {
      // Downsample for a smooth, lightweight orbit.
      const max = 4000;
      const step = Math.max(1, Math.ceil(path.length / max));
      pts = [];
      for (let i = 0; i < path.length; i += step) pts.push(path[i]);
      if (path.length && pts[pts.length - 1] !== path[path.length - 1])
        pts.push(path[path.length - 1]);
      render();
    }

    function project(p, c) {
      const x = p.x - c.x, y = p.y - c.y, z = p.z - c.z;
      const ca = Math.cos(az), sa = Math.sin(az);
      const rx = x * ca - y * sa;
      const ry = x * sa + y * ca;
      const ce = Math.cos(el), se = Math.sin(el);
      return { x: rx, y: ry * ce - z * se };
    }

    function render() {
      if (!ctx) return;
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      if (pts.length < 2) return;

      let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
      for (const p of pts) {
        if (p.x < mnx) mnx = p.x; if (p.x > mxx) mxx = p.x;
        if (p.y < mny) mny = p.y; if (p.y > mxy) mxy = p.y;
        if (p.z < mnz) mnz = p.z; if (p.z > mxz) mxz = p.z;
      }
      const c = { x: (mnx + mxx) / 2, y: (mny + mxy) / 2, z: (mnz + mxz) / 2 };
      const proj = pts.map((p) => project(p, c));

      let p2mnx = Infinity, p2mny = Infinity, p2mxx = -Infinity, p2mxy = -Infinity;
      for (const q of proj) {
        if (q.x < p2mnx) p2mnx = q.x; if (q.x > p2mxx) p2mxx = q.x;
        if (q.y < p2mny) p2mny = q.y; if (q.y > p2mxy) p2mxy = q.y;
      }
      const pad = 24;
      const s = Math.min((W - 2 * pad) / ((p2mxx - p2mnx) || 1), (H - 2 * pad) / ((p2mxy - p2mny) || 1));
      const ox = W / 2 - ((p2mnx + p2mxx) / 2) * s;
      const oy = H / 2 + ((p2mny + p2mxy) / 2) * s;
      const sx = (q) => ox + q.x * s;
      const sy = (q) => oy - q.y * s;

      // Two batched passes: travels faint, extrusions accent.
      function pass(travel, color) {
        ctx.beginPath();
        for (let i = 1; i < pts.length; i++) {
          if (!!pts[i].travel !== travel) continue;
          ctx.moveTo(sx(proj[i - 1]), sy(proj[i - 1]));
          ctx.lineTo(sx(proj[i]), sy(proj[i]));
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      pass(true, 'rgba(154,163,178,0.25)');
      pass(false, '#4f9dff');
    }

    return { init, setPath, render };
  })();

  // --- Live update (cheap) ---
  function updateShapeUI() {
    const cfg = readConfig();
    showShapeParams(cfg.shape);
    drawPreview(cfg);
  }

  // --- Generate (button / Enter) ---
  function regenerate() {
    const cfg = readConfig();
    showShapeParams(cfg.shape);
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
      s.volume.toFixed(0) + ' mm³ · ' + (s.pathLength / 1000).toFixed(1) + ' m path';

    showWarnings(result.warnings, false);
  }

  function showWarnings(list, isError) {
    const warn = $('warnings');
    warn.innerHTML = '';
    (list || []).forEach((w) => {
      const d = document.createElement('div');
      d.textContent = (isError ? '⚠ ' : '⚠ ') + w;
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

  $('regenBtn').addEventListener('click', regenerate);
  $('copyBtn').addEventListener('click', copy);
  $('downloadBtn').addEventListener('click', download);
  $('shareBtn').addEventListener('click', share);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  // Initial render.
  updateShapeUI();
  regenerate();
})();
