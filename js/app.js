'use strict';

(() => {
  const $ = (s) => document.querySelector(s);
  const viewer = $('#viewer');
  const pagesEl = $('#pages');

  if (typeof pdfjsLib === 'undefined' || typeof PDFLib === 'undefined') {
    $('#empty').innerHTML = '<h1>Libraries failed to load</h1><p>PDF.js and pdf-lib are loaded from cdnjs.cloudflare.com. Check your internet connection and reload.</p>';
    return;
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  // ---------- settings ----------
  const readJSON = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const DEFAULT_FILTERS = { brightness: 100, contrast: 100, saturate: 100, grayscale: 0, sepia: 0, hue: 0 };
  const settings = Object.assign({
    mode: 'original', bg: '#121212', fg: '#e6e6e6', scale: 1.25,
    readerSize: 20, readerFont: 'serif', panel: true,
  }, readJSON('pdfv:settings'));
  settings.filters = Object.assign({}, DEFAULT_FILTERS, settings.filters);
  const saveSettings = () => { try { localStorage.setItem('pdfv:settings', JSON.stringify(settings)); } catch (e) { /* ignore */ } };

  const THEMES = {
    dark: { bg: '#121212', fg: '#e6e6e6' },
    midnight: { bg: '#0d1b2a', fg: '#d6e6ff' },
    amoled: { bg: '#000000', fg: '#ffffff' },
    sepia: { bg: '#f4ecd8', fg: '#3b2f1e' },
  };
  const FILTER_PRESETS = {
    none: {},
    grayscale: { grayscale: 100 },
    sepia: { sepia: 70 },
    contrast: { contrast: 150, brightness: 100 },
    warm: { sepia: 25, brightness: 95, saturate: 110 },
    soft: { brightness: 92, contrast: 88 },
  };
  const FILTER_DEFS = [
    ['brightness', 'Brightness', 40, 160, '%'],
    ['contrast', 'Contrast', 40, 200, '%'],
    ['saturate', 'Saturation', 0, 200, '%'],
    ['grayscale', 'Grayscale', 0, 100, '%'],
    ['sepia', 'Sepia', 0, 100, '%'],
    ['hue', 'Hue', 0, 360, '°'],
  ];

  // ---------- state ----------
  const state = {
    pdf: null, bytes: null, name: '', pages: [], io: null, current: 1,
    scale: settings.scale, readerBuilt: false, readerOn: false,
  };

  let toastTimer;
  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  // ---------- rendering ----------
  async function renderPage(p) {
    const token = ++p.token;
    if (p.task) { p.task.cancel(); p.task = null; }
    let page;
    try { page = await state.pdf.getPage(p.n); } catch (e) { return; }
    if (token !== p.token) return;

    const vp = page.getViewport({ scale: state.scale });
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (vp.width * vp.height * dpr * dpr > 16e6) dpr = 1;

    const cv = document.createElement('canvas');
    cv.width = Math.floor(vp.width * dpr);
    cv.height = Math.floor(vp.height * dpr);
    const ctx = cv.getContext('2d');
    if (Recolor.enabled) {
      Recolor.install(ctx);
      cv.style.background = Recolor.bg;
    }

    const task = page.render({
      canvasContext: ctx,
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
      background: '#ffffff',
    });
    p.task = task;
    try { await task.promise; } catch (e) { return; }
    if (token !== p.token) return;
    p.task = null;

    if (p.canvas) p.canvas.remove();
    p.canvas = cv;
    p.el.insertBefore(cv, p.svg);
    p.rendered = true;
  }

  function unloadPage(p) {
    p.token++;
    if (p.task) { p.task.cancel(); p.task = null; }
    if (p.canvas) { p.canvas.remove(); p.canvas = null; }
    p.rendered = false;
  }

  function invalidateAll() {
    for (const p of state.pages) {
      p.rendered = false;
      if (p.visible) renderPage(p);
    }
  }

  function layout() {
    for (const p of state.pages) {
      p.el.style.width = (p.w * state.scale) + 'px';
      p.el.style.height = (p.h * state.scale) + 'px';
    }
    Annot.setScale(state.scale);
    const pct = Math.round(state.scale * 100);
    $('#zoomLabel').textContent = pct + '%';
    $('#zoomRange').value = pct;
  }

  function setScale(s) {
    s = Math.max(0.25, Math.min(5, s));
    if (Math.abs(s - state.scale) < 0.001) return;
    const ratio = viewer.scrollHeight ? viewer.scrollTop / viewer.scrollHeight : 0;
    state.scale = s;
    settings.scale = s;
    saveSettings();
    layout();
    viewer.scrollTop = ratio * viewer.scrollHeight;
    invalidateAll();
  }

  const fitWidth = () => {
    if (state.pages.length) setScale((viewer.clientWidth - 48) / state.pages[0].w);
  };

  // ---------- opening documents ----------
  async function openBytes(buf, name) {
    toast('Opening…');
    try {
      if (state.pdf) { state.pdf.destroy(); state.pdf = null; }
      state.bytes = new Uint8Array(buf);
      const task = pdfjsLib.getDocument({ data: state.bytes.slice() });
      task.onPassword = (cb, reason) => {
        const pw = prompt(reason === 2 ? 'Wrong password, try again:' : 'This PDF is password protected:');
        if (pw === null) task.destroy(); else cb(pw);
      };
      state.pdf = await task.promise;
    } catch (e) {
      console.error(e);
      toast('Could not open this file: ' + (e && e.message ? e.message : e), 5000);
      return;
    }

    state.name = name;
    $('#fileName').textContent = name;
    $('#fileName').title = name;
    document.title = name + ' – PDF Viewer';
    $('#empty').hidden = true;
    state.readerBuilt = false;
    if (state.readerOn) toggleReader(false);

    if (state.io) state.io.disconnect();
    pagesEl.textContent = '';
    state.pages = [];
    Annot.load(name + ':' + state.bytes.length);

    const n = state.pdf.numPages;
    const sizes = await Promise.all(Array.from({ length: n }, async (_, i) => {
      const pg = await state.pdf.getPage(i + 1);
      const v = pg.getViewport({ scale: 1 });
      return [v.width, v.height];
    }));

    state.io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const p = state.pages[+en.target.dataset.n - 1];
        p.visible = en.isIntersecting;
        if (en.isIntersecting) { if (!p.rendered) renderPage(p); } else unloadPage(p);
      }
    }, { root: viewer, rootMargin: '1200px 0px' });

    sizes.forEach(([w, h], i) => {
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.n = i + 1;
      pagesEl.appendChild(el);
      const svg = Annot.attach(el, i + 1, w, h);
      state.pages.push({ n: i + 1, w, h, el, svg, canvas: null, task: null, token: 0, rendered: false, visible: false });
    });
    layout();
    state.pages.forEach((p) => state.io.observe(p.el));

    $('#pageCount').textContent = '/ ' + n;
    $('#pageNum').max = n;
    state.current = 1;
    $('#pageNum').value = 1;
    viewer.scrollTop = 0;
    if (state.scale === 1.25 && sizes[0][0] * 1.25 > viewer.clientWidth - 40) fitWidth();
    toast(`${name} — ${n} page${n === 1 ? '' : 's'}`);
  }

  async function openFile(file) {
    if (!file) return;
    openBytes(await file.arrayBuffer(), file.name);
  }

  // ---------- navigation ----------
  function goTo(n) {
    n = Math.max(1, Math.min(state.pages.length, n | 0));
    const p = state.pages[n - 1];
    if (!p) return;
    const top = p.el.getBoundingClientRect().top - viewer.getBoundingClientRect().top + viewer.scrollTop;
    viewer.scrollTop = top - 14;
  }

  let ticking = false;
  viewer.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const line = viewer.getBoundingClientRect().top + viewer.clientHeight * 0.35;
      let cur = 1;
      for (const p of state.pages) {
        if (p.el.getBoundingClientRect().top <= line) cur = p.n; else break;
      }
      if (cur !== state.current) {
        state.current = cur;
        $('#pageNum').value = cur;
      }
    });
  });

  // ---------- colors / dark mode ----------
  function applyColors(rerender = true) {
    Recolor.configure({ enabled: settings.mode !== 'original', bg: settings.bg, fg: settings.fg });
    $('#bgColor').value = settings.bg;
    $('#fgColor').value = settings.fg;
    document.querySelectorAll('#themeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === settings.mode));
    const r = $('#reader');
    const on = Recolor.enabled;
    r.style.setProperty('--rbg', on ? settings.bg : '#ffffff');
    r.style.setProperty('--rfg', on ? settings.fg : '#111111');
    saveSettings();
    if (rerender) invalidateAll();
  }

  document.querySelectorAll('#themeSeg button').forEach((b) => b.addEventListener('click', () => {
    const m = b.dataset.mode;
    settings.mode = m;
    if (THEMES[m]) Object.assign(settings, THEMES[m]);
    else if (m === 'custom' && !Recolor.enabled) Object.assign(settings, THEMES.dark);
    applyColors();
  }));

  let colorTimer;
  const onColorInput = () => {
    settings.bg = $('#bgColor').value;
    settings.fg = $('#fgColor').value;
    settings.mode = 'custom';
    clearTimeout(colorTimer);
    colorTimer = setTimeout(applyColors, 120);
  };
  $('#bgColor').addEventListener('input', onColorInput);
  $('#fgColor').addEventListener('input', onColorInput);

  // ---------- filters ----------
  const filterRows = $('#filterRows');
  for (const [key, label, min, max, unit] of FILTER_DEFS) {
    const row = document.createElement('label');
    row.className = 'row';
    row.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" data-f="${key}"><span class="val"></span>`;
    filterRows.appendChild(row);
    row.querySelector('input').addEventListener('input', (e) => {
      settings.filters[key] = +e.target.value;
      $('#filterPreset').value = 'none';
      applyFilters();
    });
    row.dataset.unit = unit;
  }

  function applyFilters() {
    const f = settings.filters;
    pagesEl.style.setProperty('--pdf-filter',
      `brightness(${f.brightness}%) contrast(${f.contrast}%) saturate(${f.saturate}%) grayscale(${f.grayscale}%) sepia(${f.sepia}%) hue-rotate(${f.hue}deg)`);
    filterRows.querySelectorAll('.row').forEach((row) => {
      const input = row.querySelector('input');
      input.value = f[input.dataset.f];
      row.querySelector('.val').textContent = f[input.dataset.f] + row.dataset.unit;
    });
    saveSettings();
  }

  $('#filterPreset').addEventListener('change', (e) => {
    settings.filters = Object.assign({}, DEFAULT_FILTERS, FILTER_PRESETS[e.target.value]);
    applyFilters();
  });
  $('#filterReset').addEventListener('click', () => {
    settings.filters = Object.assign({}, DEFAULT_FILTERS);
    $('#filterPreset').value = 'none';
    applyFilters();
  });

  // ---------- reader mode ----------
  async function buildReader() {
    const body = $('#readerBody');
    body.textContent = 'Loading text…';
    const sections = [];
    const heights = [];
    for (let n = 1; n <= state.pdf.numPages; n++) {
      const page = await state.pdf.getPage(n);
      const tc = await page.getTextContent();
      const paras = [];
      let cur = null, lastY = null, lastH = 0;
      for (const it of tc.items) {
        if (typeof it.str !== 'string') continue;
        const h = Math.abs(it.transform[3]) || it.height || 10;
        const y = it.transform[5];
        if (!it.str && !it.hasEOL) continue;
        if (cur && Math.abs(lastY - y) > lastH * 1.9) { paras.push(cur); cur = null; }
        if (!cur) cur = { text: '', h };
        else if (Math.abs(lastY - y) > lastH * 0.5) {
          cur.text = /\w-$/.test(cur.text) ? cur.text.slice(0, -1) : cur.text + ' ';
        }
        cur.text += it.str;
        if (h > cur.h) cur.h = h;
        lastY = y; lastH = h;
      }
      if (cur) paras.push(cur);
      paras.forEach((p) => heights.push(p.h));
      sections.push(paras);
    }
    heights.sort((a, b) => a - b);
    const median = heights[heights.length >> 1] || 10;

    body.textContent = '';
    sections.forEach((paras, i) => {
      const mark = document.createElement('div');
      mark.className = 'pmark';
      mark.textContent = 'Page ' + (i + 1);
      body.appendChild(mark);
      if (!paras.length) {
        const p = document.createElement('p');
        p.textContent = '(no selectable text on this page)';
        p.style.opacity = .5;
        body.appendChild(p);
      }
      for (const p of paras) {
        const node = document.createElement(p.h >= median * 1.25 && p.text.length < 140 ? 'h3' : 'p');
        node.dir = 'auto';
        node.textContent = p.text.trim();
        body.appendChild(node);
      }
    });
    state.readerBuilt = true;
  }

  async function toggleReader(force) {
    const on = typeof force === 'boolean' ? force : !state.readerOn;
    if (on && !state.pdf) { toast('Open a PDF first'); return; }
    state.readerOn = on;
    $('#reader').hidden = !on;
    viewer.hidden = on;
    $('#btnReader').classList.toggle('active', on);
    if (on && !state.readerBuilt) await buildReader();
  }
  $('#btnReader').addEventListener('click', () => toggleReader());

  const FONTS = {
    serif: 'Georgia, "Times New Roman", serif',
    sans: 'system-ui, "Segoe UI", Roboto, Arial, sans-serif',
    mono: 'Consolas, "Courier New", monospace',
  };
  function applyReaderStyle() {
    const r = $('#reader');
    r.style.setProperty('--rsize', settings.readerSize + 'px');
    r.style.setProperty('--rfont', FONTS[settings.readerFont] || FONTS.serif);
    $('#readerSize').value = settings.readerSize;
    $('#readerFont').value = settings.readerFont;
    saveSettings();
  }
  $('#readerSize').addEventListener('input', (e) => { settings.readerSize = +e.target.value; applyReaderStyle(); });
  $('#readerFont').addEventListener('change', (e) => { settings.readerFont = e.target.value; applyReaderStyle(); });

  // ---------- annotations UI ----------
  function setTool(t) {
    Annot.setTool(t);
    viewer.dataset.tool = t;
    document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    if (t === 'highlight') { $('#annOpacity').value = 40; syncStyle(); }
    else if (t !== 'none' && t !== 'eraser' && +$('#annOpacity').value < 100) { $('#annOpacity').value = 100; syncStyle(); }
    if (t !== 'none' && state.readerOn) toggleReader(false);
  }
  document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

  function syncStyle() {
    Annot.setStyle({
      color: $('#annColor').value,
      width: +$('#annWidth').value,
      opacity: +$('#annOpacity').value / 100,
      size: +$('#annSize').value || 16,
    });
  }
  ['#annColor', '#annWidth', '#annOpacity', '#annSize'].forEach((s) => $(s).addEventListener('input', syncStyle));

  Annot.onChange = () => {
    $('#undo').disabled = !Annot.canUndo;
    $('#redo').disabled = !Annot.canRedo;
    const n = Annot.items.length;
    $('#clearAll').disabled = n === 0;
    $('#annCount').textContent = n + (n === 1 ? ' mark' : ' marks');
  };
  $('#undo').addEventListener('click', () => Annot.undo());
  $('#redo').addEventListener('click', () => Annot.redo());
  $('#clearAll').addEventListener('click', () => { if (confirm('Remove all marks from this document?')) Annot.clearAll(); });

  // ---------- saving ----------
  const filterCss = () => {
    const f = settings.filters;
    return `brightness(${f.brightness}%) contrast(${f.contrast}%) saturate(${f.saturate}%) grayscale(${f.grayscale}%) sepia(${f.sepia}%) hue-rotate(${f.hue}deg)`;
  };
  const filtersChanged = () => Object.keys(DEFAULT_FILTERS).some((k) => settings.filters[k] !== DEFAULT_FILTERS[k]);

  // Renders every page with the current colors/filters (images keep their colors).
  async function bakePages() {
    const out = [];
    for (let n = 1; n <= state.pdf.numPages; n++) {
      toast(`Applying appearance… page ${n}/${state.pdf.numPages}`, 60000);
      const page = await state.pdf.getPage(n);
      const v1 = page.getViewport({ scale: 1 });
      const s = Math.min(2, Math.sqrt(12e6 / (v1.width * v1.height)));
      const vp = page.getViewport({ scale: s });
      const cv = document.createElement('canvas');
      cv.width = Math.floor(vp.width);
      cv.height = Math.floor(vp.height);
      const ctx = cv.getContext('2d');
      if (Recolor.enabled) { Recolor.install(ctx); cv.style.background = Recolor.bg; }
      await page.render({ canvasContext: ctx, viewport: vp, background: '#ffffff' }).promise;

      let final = cv;
      if (Recolor.enabled || filtersChanged()) {
        final = document.createElement('canvas');
        final.width = cv.width;
        final.height = cv.height;
        const f = final.getContext('2d');
        f.fillStyle = Recolor.enabled ? Recolor.bg : '#ffffff';
        f.fillRect(0, 0, final.width, final.height);
        if (filtersChanged()) f.filter = filterCss();
        f.drawImage(cv, 0, 0);
      }
      out.push({ w: v1.width, h: v1.height, dataUrl: final.toDataURL('image/jpeg', 0.92) });
    }
    return out;
  }

  async function save() {
    if (!state.bytes) { toast('Open a PDF first'); return; }
    let baked = null;
    if (Recolor.enabled || filtersChanged()) {
      const ok = confirm('Your dark mode / colors / filters will be saved into the PDF.\n\nThis turns each page into an image (text will no longer be selectable).\n\nOK = save with appearance\nCancel = save original pages with marks only');
      if (ok) {
        try { baked = await bakePages(); } catch (e) { console.error(e); toast('Could not apply appearance: ' + e.message, 5000); return; }
      }
    }
    toast('Saving…', 8000);
    try {
      const { bytes, skipped } = await Exporter.build(state.bytes, Annot.items, baked);
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = state.name.replace(/\.pdf$/i, '') + '-edited.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      toast(skipped ? `Saved (${skipped} mark(s) on rotated pages were skipped)` : 'Saved ' + a.download, 4000);
    } catch (e) {
      console.error(e);
      toast('Save failed: ' + (e && e.message ? e.message : e), 6000);
    }
  }
  $('#btnSave').addEventListener('click', save);

  // ---------- sample document ----------
  async function makeSample() {
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const page = doc.addPage([595, 842]);
    page.drawText('Sample document', { x: 50, y: 780, size: 30, font: bold, color: rgb(0, 0, 0) });
    const lines = [
      'Dark mode recolors text and vector shapes only.',
      'The picture below keeps its original colors.',
      'Try highlighting, drawing, adding text, then Save PDF.',
    ];
    lines.forEach((l, i) => page.drawText(l, { x: 50, y: 740 - i * 22, size: 14, font, color: rgb(0.1, 0.1, 0.1) }));

    const c = document.createElement('canvas');
    c.width = 360; c.height = 200;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 360, 200);
    grad.addColorStop(0, '#ff5f6d'); grad.addColorStop(0.5, '#ffc371'); grad.addColorStop(1, '#2193b0');
    g.fillStyle = grad; g.fillRect(0, 0, 360, 200);
    g.fillStyle = '#ffffff'; g.beginPath(); g.arc(250, 70, 40, 0, 7); g.fill();
    g.fillStyle = '#111111'; g.fillRect(40, 120, 120, 50);
    const png = await doc.embedPng(c.toDataURL('image/png'));
    page.drawImage(png, { x: 50, y: 480, width: 360, height: 200 });

    page.drawRectangle({ x: 50, y: 400, width: 260, height: 50, color: rgb(0.15, 0.35, 0.8) });
    page.drawText('White text on blue box', { x: 62, y: 420, size: 16, font: bold, color: rgb(1, 1, 1) });
    page.drawLine({ start: { x: 50, y: 380 }, end: { x: 545, y: 380 }, thickness: 1, color: rgb(0.5, 0.5, 0.5) });
    for (let i = 0; i < 12; i++) {
      page.drawText('Body text line ' + (i + 1) + ' — the quick brown fox jumps over the lazy dog.', { x: 50, y: 355 - i * 20, size: 12, font, color: rgb(0, 0, 0) });
    }
    return doc.save();
  }
  $('#btnSample').addEventListener('click', async () => openBytes(await makeSample(), 'sample.pdf'));

  // ---------- wiring ----------
  const pick = () => $('#fileInput').click();
  $('#btnOpen').addEventListener('click', pick);
  $('#emptyOpen').addEventListener('click', pick);
  $('#fileInput').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });

  $('#prevPage').addEventListener('click', () => goTo(state.current - 1));
  $('#nextPage').addEventListener('click', () => goTo(state.current + 1));
  $('#pageNum').addEventListener('change', (e) => goTo(+e.target.value));
  $('#zoomIn').addEventListener('click', () => setScale(state.scale * 1.15));
  $('#zoomOut').addEventListener('click', () => setScale(state.scale / 1.15));
  $('#zoomFit').addEventListener('click', fitWidth);
  $('#zoomRange').addEventListener('input', (e) => setScale(+e.target.value / 100));

  viewer.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setScale(state.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });

  function applyChrome() {
    $('#panel').classList.toggle('closed', !settings.panel);
    document.body.classList.toggle('hide-top', !!settings.hideTop);
    $('#showTop').hidden = !settings.hideTop;
    $('#showPanel').hidden = settings.panel || !settings.hideTop;
    saveSettings();
  }
  const setPanel = (open) => { settings.panel = open; applyChrome(); };
  $('#btnPanel').addEventListener('click', () => setPanel(!settings.panel));
  $('#btnClosePanel').addEventListener('click', () => setPanel(false));
  $('#showPanel').addEventListener('click', () => setPanel(true));
  $('#btnHideTop').addEventListener('click', () => { settings.hideTop = true; applyChrome(); });
  $('#showTop').addEventListener('click', () => { settings.hideTop = false; applyChrome(); });

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    else if (mod && !typing && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? Annot.redo() : Annot.undo(); }
    else if (mod && !typing && e.key.toLowerCase() === 'y') { e.preventDefault(); Annot.redo(); }
  });

  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); viewer.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); viewer.classList.remove('dragging'); }));
  document.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f && /pdf$/i.test(f.type || f.name)) openFile(f); else if (f) toast('That is not a PDF file');
  });

  // ---------- init ----------
  applyChrome();
  applyColors(false);
  applyFilters();
  applyReaderStyle();
  syncStyle();
  Annot.notify();
  $('#zoomLabel').textContent = Math.round(state.scale * 100) + '%';
})();
