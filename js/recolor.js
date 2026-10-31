'use strict';

/*
 * Dark mode / custom colors that leave images alone.
 *
 * PDF.js paints text, vector shapes and image masks through the canvas
 * fillStyle / strokeStyle properties, while bitmap images go through
 * drawImage / putImageData. We intercept only the two style properties on the
 * page's 2D context and re-map each colour:
 *   - greys (black text, white paper, grey rules) are interpolated between the
 *     chosen text colour (black) and background colour (white);
 *   - coloured fills keep their hue and are only lightened on dark backgrounds.
 * Images never touch these properties, so they render exactly as authored.
 */
const Recolor = (() => {
  const cfg = { enabled: false, bg: '#121212', fg: '#e6e6e6' };
  let bgRGB = [18, 18, 18];
  let fgRGB = [230, 230, 230];
  let bgDark = true;
  const cache = new Map();

  const hexToRgb = (h) => {
    h = h.replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return [0, 2, 4].map((i) => parseInt(h.substr(i, 2), 16));
  };
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const toHex = (c) => '#' + c.map((v) => clamp(v).toString(16).padStart(2, '0')).join('');

  function parse(s) {
    s = s.trim().toLowerCase();
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(s)) return { c: hexToRgb(s), a: 1 };
    const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?/.exec(s);
    if (m) return { c: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] };
    if (s === 'white') return { c: [255, 255, 255], a: 1 };
    if (s === 'black') return { c: [0, 0, 0], a: 1 };
    return null;
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h / 6, s, l];
  }

  function hslToRgb(h, s, l) {
    if (s === 0) return [l * 255, l * 255, l * 255];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = (t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
  }

  function mapRGB([r, g, b]) {
    const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    if (chroma < 0.14) {
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      return fgRGB.map((f, i) => f * (1 - lum) + bgRGB[i] * lum);
    }
    if (!bgDark) return [r, g, b];
    const [h, s, l] = rgbToHsl(r, g, b);
    return hslToRgb(h, s, 0.42 + 0.5 * l);
  }

  function mapStyle(v) {
    if (typeof v !== 'string') return v; // gradients / patterns pass through
    let out = cache.get(v);
    if (out !== undefined) return out;
    const p = parse(v);
    if (!p) out = v;
    else {
      const c = mapRGB(p.c);
      out = p.a >= 1 ? toHex(c) : `rgba(${clamp(c[0])}, ${clamp(c[1])}, ${clamp(c[2])}, ${p.a})`;
    }
    cache.set(v, out);
    return out;
  }

  function configure(opts) {
    Object.assign(cfg, opts);
    bgRGB = hexToRgb(cfg.bg);
    fgRGB = hexToRgb(cfg.fg);
    bgDark = (0.2126 * bgRGB[0] + 0.7152 * bgRGB[1] + 0.0722 * bgRGB[2]) / 255 < 0.5;
    cache.clear();
  }

  function install(ctx) {
    for (const prop of ['fillStyle', 'strokeStyle']) {
      const d = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, prop);
      Object.defineProperty(ctx, prop, {
        configurable: true,
        get() { return d.get.call(this); },
        set(v) { d.set.call(this, mapStyle(v)); },
      });
    }
  }

  configure({});
  return { configure, install, get enabled() { return cfg.enabled; }, get bg() { return cfg.bg; }, get fg() { return cfg.fg; } };
})();
