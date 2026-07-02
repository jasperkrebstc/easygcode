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
      tolerance: num('tolerance'),
      seamSide: $('seamSide').value,
      centerX: num('centerX'),
      centerY: num('centerY'),
      brim: {
        enabled: $('brimEnabled').checked,
        outer: $('brimOuter').value === 'outer',
        lines: Math.max(0, Math.round(num('brimLines'))),
        lineWidth: num('brimLineWidth'),
        layerHeight: num('brimLayerHeight'),
        feed: num('brimFeed'),
      },
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
    if (!isPos(cfg.tolerance)) return 'Chord tolerance must be greater than 0.';
    for (const k in cfg.shapeParams) {
      const v = cfg.shapeParams[k];
      if (!Number.isFinite(v)) return 'Enter a valid value for ' + k + '.';
      if (k !== 'fillet' && v <= 0) return 'Shape value "' + k + '" must be greater than 0.';
    }
    if (cfg.brim.enabled) {
      if (cfg.brim.lines < 1) return 'Brim needs at least 1 line.';
      if (!isPos(cfg.brim.lineWidth)) return 'Enter a valid brim line width.';
      if (!isPos(cfg.brim.layerHeight)) return 'Enter a valid brim layer height.';
      if (!isPos(cfg.brim.feed)) return 'Enter a valid brim feedrate.';
    }
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

  function showPatternParams(type) {
    document.querySelectorAll('.pattern-params').forEach((el) => {
      el.hidden = el.getAttribute('data-pattern') !== type;
    });
    $('patternHint').textContent =
      type === 'spikes'
        ? 'Spikes: blue-noise outward pokes, base width = line width. Change seed to re-roll.'
        : 'Weave: even bumps/rev = flutes · odd = woven';
  }

  // --- Live 2D cross-section preview ---
  function drawPreview(cfg) {
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

  // --- 3D toolpath viewer: orbit by drag, fixed zoom, Z-up, colored by feed ---
  const View3D = (function () {
    let canvas, ctx;
    let pts = [];
    let az = -0.6;
    let el = 0.5; // 0 = side view, PI/2 = top view
    let dragging = false;
    let lastX = 0, lastY = 0;
    let center = { x: 0, y: 0, z: 0 };
    let radius = 1; // bounding radius; zoom-to-fit is derived from it per render
    let feedMin = 0, feedMax = 1;
    const NB = 18; // color buckets for batched stroking

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
        el = Math.max(0, Math.min(Math.PI / 2, el));
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

    // Z-up orthographic projection at a fixed zoom-to-fit scale.
    function project(p, scale) {
      const X = p.x - center.x, Y = p.y - center.y, Z = p.z - center.z;
      const ca = Math.cos(az), sa = Math.sin(az);
      const x1 = X * ca - Y * sa;
      const y1 = X * sa + Y * ca; // depth toward camera
      const ce = Math.cos(el), se = Math.sin(el);
      const sxp = x1;
      const syp = Z * ce - y1 * se; // +Z up; tilt mixes in depth
      return { x: canvas.width / 2 + sxp * scale, y: canvas.height / 2 - syp * scale };
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
      const scale = (Math.min(W, H) / 2 - 18 * sf) / (radius || 1);
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
  function updateShapeUI() {
    const cfg = readConfig();
    showShapeParams(cfg.shape);
    showPatternParams(cfg.pattern.type);
    drawPreview(cfg);
    saveLocal();
  }

  // --- Generate (button / Enter) ---
  function regenerate() {
    const cfg = readConfig();
    showShapeParams(cfg.shape);
    showPatternParams(cfg.pattern.type);
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

  function fmtTime(min) {
    if (min < 60) return Math.max(1, Math.round(min)) + ' min';
    const h = Math.floor(min / 60);
    return h + 'h ' + Math.round(min - h * 60) + 'm';
  }

  // Size canvas backing stores to the displayed size × devicePixelRatio so
  // lines are crisp on retina screens (drawing code scales strokes via W/600).
  function fitCanvases() {
    ['preview', 'preview3d'].forEach((id) => {
      const c = $(id);
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const w = c.clientWidth || 600;
      const px = Math.round(w * dpr);
      if (px > 0 && c.width !== px) {
        c.width = px;
        c.height = px;
      }
    });
  }

  // --- Settings preset: save/load JSON + auto-persist to localStorage ---
  const STORAGE_KEY = 'easygcode-settings';

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
  }

  function saveLocal() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(collectSettings()));
    } catch (e) {
      /* storage unavailable/full — ignore */
    }
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

  // Restore last-used settings, then initial render.
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) applySettings(JSON.parse(stored));
  } catch (e) {
    /* ignore */
  }
  fitCanvases();
  updateShapeUI();
  regenerate();
})();
