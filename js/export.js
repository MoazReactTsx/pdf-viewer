'use strict';

/* Writes annotations into a copy of the original PDF with pdf-lib. */
const Exporter = (() => {
  const color = (h) => {
    const n = parseInt(h.slice(1), 16);
    return PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  };

  // Used when the text contains characters Helvetica can't encode (Arabic, CJK, emoji...).
  async function drawTextAsImage(doc, page, a, X, Y) {
    const sc = 3;
    const lines = a.text.split('\n');
    const probe = document.createElement('canvas').getContext('2d');
    const font = `${a.size * sc}px sans-serif`;
    probe.font = font;
    const w = Math.ceil(Math.max(...lines.map((l) => probe.measureText(l).width))) + 4;
    const lh = a.size * 1.2 * sc;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = Math.ceil(lh * lines.length) + 4;
    const ctx = c.getContext('2d');
    ctx.font = font;
    ctx.fillStyle = a.color;
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, 2, 2 + i * lh));
    const png = await doc.embedPng(c.toDataURL('image/png'));
    page.drawImage(png, { x: X(a.x), y: Y(a.y) - c.height / sc, width: c.width / sc, height: c.height / sc });
  }

  /*
   * baked (optional): [{ w, h, dataUrl }] per page - pages already rendered with
   * the viewer's colors/filters. They replace the original pages.
   */
  async function build(bytes, items, baked) {
    const { PDFDocument, StandardFonts, LineCapStyle } = PDFLib;
    let doc;
    if (baked) {
      doc = await PDFDocument.create();
      for (const b of baked) {
        const page = doc.addPage([b.w, b.h]);
        const img = await doc.embedJpg(b.dataUrl);
        page.drawImage(img, { x: 0, y: 0, width: b.w, height: b.h });
      }
    } else {
      doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    }
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pages = doc.getPages();
    let skipped = 0;

    for (const a of items) {
      const page = pages[a.page - 1];
      if (!page) continue;
      if (page.getRotation().angle % 360 !== 0) { skipped++; continue; }
      const cb = page.getCropBox();
      const X = (x) => cb.x + x;
      const Y = (y) => cb.y + cb.height - y;
      const col = a.color ? color(a.color) : undefined;
      const line = (x1, y1, x2, y2) => page.drawLine({
        start: { x: X(x1), y: Y(y1) }, end: { x: X(x2), y: Y(y2) },
        thickness: a.width, color: col, opacity: a.opacity, lineCap: LineCapStyle.Round,
      });

      if (a.type === 'highlight' || a.type === 'rect') {
        const x = Math.min(a.x1, a.x2), y = Math.max(a.y1, a.y2);
        const w = Math.abs(a.x2 - a.x1), h = Math.abs(a.y2 - a.y1);
        if (a.type === 'highlight') page.drawRectangle({ x: X(x), y: Y(y), width: w, height: h, color: col, opacity: a.opacity });
        else page.drawRectangle({ x: X(x), y: Y(y), width: w, height: h, borderColor: col, borderWidth: a.width, borderOpacity: a.opacity });
      } else if (a.type === 'line' || a.type === 'underline') {
        line(a.x1, a.y1, a.x2, a.y2);
      } else if (a.type === 'pen') {
        for (let i = 1; i < a.points.length; i++) line(...a.points[i - 1], ...a.points[i]);
      } else if (a.type === 'text') {
        try {
          font.encodeText(a.text.replace(/\n/g, ' '));
          a.text.split('\n').forEach((l, i) => {
            page.drawText(l, { x: X(a.x), y: Y(a.y + a.size * 0.85 + i * a.size * 1.2), size: a.size, font, color: col });
          });
        } catch (e) {
          await drawTextAsImage(doc, page, a, X, Y);
        }
      }
    }
    return { bytes: await doc.save(), skipped };
  }

  return { build };
})();
