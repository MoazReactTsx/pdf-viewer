'use strict';

/*
 * Annotation layer. Every page gets an SVG whose viewBox is the page size in
 * PDF units (scale 1), so annotations stay put when zooming and map directly
 * onto PDF coordinates when saving.
 */
const Annot = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const S = {
    items: [], undo: [], redo: [], nextId: 1,
    tool: 'none', color: '#ffe600', width: 3, opacity: 0.4, size: 16,
    scale: 1, key: null, layers: new Map(),
    onChange: () => {},
  };

  const el = (name, attrs = {}) => {
    const n = document.createElementNS(NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };

  const rectOf = (a) => ({
    x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2),
    w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1),
  });

  function build(a) {
    const g = el('g', { 'data-id': a.id });
    const stroke = { stroke: a.color, 'stroke-width': a.width, 'stroke-opacity': a.opacity, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', fill: 'none' };
    const withHit = (shape) => {
      g.appendChild(shape);
      const hit = shape.cloneNode();
      hit.setAttribute('stroke', 'transparent');
      hit.setAttribute('stroke-opacity', 1);
      hit.setAttribute('stroke-width', Math.max(a.width, 12));
      hit.setAttribute('fill', 'none');
      g.appendChild(hit);
    };

    if (a.type === 'highlight') {
      const r = rectOf(a);
      g.appendChild(el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: a.color, 'fill-opacity': a.opacity }));
    } else if (a.type === 'rect') {
      const r = rectOf(a);
      withHit(el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, ...stroke }));
    } else if (a.type === 'line' || a.type === 'underline') {
      withHit(el('line', { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, ...stroke }));
    } else if (a.type === 'pen') {
      withHit(el('polyline', { points: a.points.map((p) => p.join(',')).join(' '), ...stroke }));
    } else if (a.type === 'text') {
      const t = el('text', { fill: a.color, 'font-size': a.size });
      a.text.split('\n').forEach((line, i) => {
        const s = el('tspan', { x: a.x, y: a.y + a.size * 0.85 + i * a.size * 1.2 });
        s.textContent = line;
        t.appendChild(s);
      });
      g.appendChild(t);
    }
    return g;
  }

  function renderPage(n) {
    const layer = S.layers.get(n);
    if (!layer) return;
    layer.svg.querySelectorAll('[data-id]').forEach((g) => g.remove());
    for (const a of S.items) if (a.page === n) layer.svg.appendChild(build(a));
  }

  // ---- history ----
  function apply(ops, dir) {
    const list = dir > 0 ? ops : [...ops].reverse();
    const touched = new Set();
    for (const o of list) {
      const add = (o.op === 'add') === (dir > 0);
      if (add) S.items.push(o.a);
      else S.items = S.items.filter((x) => x.id !== o.a.id);
      touched.add(o.a.page);
    }
    touched.forEach(renderPage);
  }

  function changed() {
    try { if (S.key) localStorage.setItem('pdfv:ann:' + S.key, JSON.stringify(S.items)); } catch (e) { /* storage unavailable */ }
    S.onChange();
  }

  function commit(ops) {
    for (const o of ops) if (o.op === 'add' && !o.a.id) o.a.id = S.nextId++;
    apply(ops, 1);
    S.undo.push(ops);
    S.redo = [];
    changed();
  }

  const undo = () => { const ops = S.undo.pop(); if (!ops) return; apply(ops, -1); S.redo.push(ops); changed(); };
  const redo = () => { const ops = S.redo.pop(); if (!ops) return; apply(ops, 1); S.undo.push(ops); changed(); };
  const clearAll = () => { if (S.items.length) commit(S.items.map((a) => ({ op: 'del', a }))); };

  // ---- pointer interaction ----
  function toPt(layer, e) {
    const r = layer.svg.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width * layer.pw, (e.clientY - r.top) / r.height * layer.ph];
  }

  function bind(layer) {
    const svg = layer.svg;
    let draft = null, draftEl = null;

    const redraft = () => {
      if (draftEl) draftEl.remove();
      draftEl = build(draft);
      draftEl.removeAttribute('data-id');
      svg.appendChild(draftEl);
    };

    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || S.tool === 'none') return;
      const t = S.tool;
      const [x, y] = toPt(layer, e);

      if (t === 'eraser') {
        const g = e.target.closest('[data-id]');
        if (g) {
          const a = S.items.find((i) => i.id === +g.dataset.id);
          if (a) commit([{ op: 'del', a }]);
        }
        return;
      }
      if (t === 'text') {
        e.preventDefault();
        const g = e.target.closest('[data-id]');
        const ex = g && S.items.find((i) => i.id === +g.dataset.id && i.type === 'text');
        editText(layer, x, y, ex || null);
        return;
      }

      svg.setPointerCapture(e.pointerId);
      draft = {
        id: 0, type: t, page: layer.n, color: S.color, width: S.width,
        opacity: t === 'highlight' ? S.opacity : Math.max(S.opacity, 0.1),
        x1: x, y1: y, x2: x, y2: y, points: [[x, y]],
      };
      redraft();
    });

    svg.addEventListener('pointermove', (e) => {
      if (!draft) return;
      const [x, y] = toPt(layer, e);
      draft.x2 = x;
      draft.y2 = draft.type === 'underline' ? draft.y1 : y;
      if (draft.type === 'pen') draft.points.push([+x.toFixed(1), +y.toFixed(1)]);
      redraft();
    });

    const end = () => {
      if (!draft) return;
      const a = draft;
      draft = null;
      draftEl.remove();
      draftEl = null;
      const w = Math.abs(a.x2 - a.x1), h = Math.abs(a.y2 - a.y1);
      const ok = a.type === 'pen' ? true
        : a.type === 'highlight' || a.type === 'rect' ? w > 2 && h > 2
        : Math.hypot(w, h) > 2;
      if (!ok) return;
      if (a.type === 'pen' && a.points.length < 2) a.points.push([...a.points[0]]);
      if (a.type !== 'pen') delete a.points;
      commit([{ op: 'add', a }]);
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', () => { draft = null; if (draftEl) draftEl.remove(); draftEl = null; });
  }

  function editText(layer, x, y, existing) {
    const pageEl = layer.svg.parentElement;
    const size = existing ? existing.size : S.size;
    const color = existing ? existing.color : S.color;
    if (existing) { x = existing.x; y = existing.y; }

    const ta = document.createElement('textarea');
    ta.className = 'ann-text-edit';
    ta.value = existing ? existing.text : '';
    Object.assign(ta.style, {
      left: (x / layer.pw * 100) + '%', top: (y / layer.ph * 100) + '%',
      fontSize: (size * S.scale) + 'px', color, lineHeight: '1.2',
    });
    pageEl.appendChild(ta);
    const orig = existing && layer.svg.querySelector(`[data-id="${existing.id}"]`);
    if (orig) orig.style.display = 'none';
    ta.focus();

    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const v = ta.value.replace(/\s+$/, '');
      ta.remove();
      if (orig) orig.style.display = '';
      if (!save) return;
      if (!v.trim()) { if (existing) commit([{ op: 'del', a: existing }]); return; }
      if (existing && v === existing.text) return;
      const a = { id: 0, type: 'text', page: layer.n, x, y, size, color, width: 1, opacity: 1, text: v };
      commit(existing ? [{ op: 'del', a: existing }, { op: 'add', a }] : [{ op: 'add', a }]);
    };
    ta.addEventListener('blur', () => finish(true));
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') finish(false);
    });
  }

  // ---- public ----
  function attach(pageEl, n, pw, ph) {
    const svg = el('svg', { class: 'ann', viewBox: `0 0 ${pw} ${ph}`, preserveAspectRatio: 'none' });
    pageEl.appendChild(svg);
    const layer = { svg, n, pw, ph };
    S.layers.set(n, layer);
    bind(layer);
    renderPage(n);
    return svg;
  }

  function load(key) {
    S.key = key;
    S.layers.clear();
    S.undo = []; S.redo = [];
    try { S.items = JSON.parse(localStorage.getItem('pdfv:ann:' + key)) || []; } catch (e) { S.items = []; }
    S.nextId = S.items.reduce((m, a) => Math.max(m, a.id), 0) + 1;
    S.onChange();
  }

  return {
    attach, load, undo, redo, clearAll,
    notify: () => S.onChange(),
    get items() { return S.items; },
    get canUndo() { return S.undo.length > 0; },
    get canRedo() { return S.redo.length > 0; },
    set onChange(fn) { S.onChange = fn; },
    setTool(t) { S.tool = t; },
    setStyle(o) { Object.assign(S, o); },
    setScale(s) { S.scale = s; },
  };
})();
