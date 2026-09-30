// PDF page copy: each scanned page becomes one A4 page with every piece of text, shaded cell and
// ruled line drawn where it was on the paper.

import { drawList, pageModel, textEm } from "./replica.js";

const A4 = [595.28, 841.89];
const MARGIN = 18;
const NO_PAD = {
  hLineWidth: () => 0, vLineWidth: () => 0,
  paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0,
};

/** pdfmake nodes for one page, plus its orientation. */
export function pageNodes(page) {
  const d = drawList(pageModel(page));
  const landscape = d.w > d.h;
  const [PW, PH] = landscape ? [A4[1], A4[0]] : A4;
  const k = Math.min((PW - 2 * MARGIN) / d.w, (PH - 2 * MARGIN) / d.h);
  const ox = (PW - d.w * k) / 2, oy = MARGIN;
  const X = (x) => ox + x * k, Y = (y) => oy + y * k;

  const canvas = [
    ...d.fills.map((f) => ({ type: "rect", x: X(f.x0), y: Y(f.y0), w: (f.x1 - f.x0) * k, h: (f.y1 - f.y0) * k, color: `#${f.fill}` })),
    ...d.rules.map((r) => ({ type: "line", x1: X(r.x0), y1: Y(r.y0), x2: X(r.x1), y2: Y(r.y1), lineWidth: 0.6, lineColor: "#000000" })),
  ];
  const nodes = [];
  for (const t of d.texts) {
    if (!t.text.trim()) continue;
    // The bundled font has no ✓ or ①..⑳: draw them, sized like the handwriting around them.
    const sym = t.text.trim();
    const size = Math.max(6, (t.fontPx || t.lineH * 0.72) * k);
    const cx = X((t.x0 + t.x1) / 2), cyy = Y((t.y0 + t.y1) / 2);
    if (/^[✓✔√]$/.test(sym)) {
      const s2 = size * 0.9;
      canvas.push({ type: "polyline", lineWidth: Math.max(0.8, s2 / 9), lineColor: t.color ? `#${t.color}` : "#000000",
        points: [{ x: cx - s2 * 0.45, y: cyy }, { x: cx - s2 * 0.12, y: cyy + s2 * 0.35 }, { x: cx + s2 * 0.45, y: cyy - s2 * 0.45 }] });
      continue;
    }
    const circ = /^([\u2460-\u2473])(.*)$/.exec(sym);
    if (circ) {
      const n = circ[1].charCodeAt(0) - 0x245f;
      const r = size * 0.62;
      const x0 = X(t.x0) + r;
      canvas.push({ type: "ellipse", x: x0, y: cyy, r1: r, r2: r, lineWidth: Math.max(0.8, size / 12), lineColor: "#000000" });
      nodes.push({ absolutePosition: { x: x0 - r, y: cyy - size * 0.42 }, table: { widths: [2 * r], body: [[{ text: String(n), fontSize: size * 0.75, alignment: "center", lineHeight: 1 }]] }, layout: NO_PAD });
      if (!circ[2].trim()) continue;
      t.text = circ[2].trim();
      t.x0 += (2 * r + size * 0.3) / k;
    }
    const w0 = Math.max(4, (t.x1 - t.x0) * k);
    // Table text keeps clear of the ruling, as printed.
    const pad = t.inCell ? Math.min(0.25 * (t.fontPx || 10) * k, 0.1 * w0) : 0;
    const w = Math.max(4, w0 - 2 * pad);
    // Size from the page, shrunk if an edited text no longer fits its place.
    let fs = Math.max(4, (t.fontPx || t.lineH * 0.72) * k);
    const need = textEm(t.text) * fs * (t.bold ? 1.06 : 1);
    const room = t.align === "left" && !t.inCell ? w * 1.6 : w;
    if (need > room) fs = Math.max(4, (fs * room) / need);
    const cy = Y((t.y0 + t.y1) / 2);
    nodes.push({
      absolutePosition: { x: X(t.x0) + pad, y: cy - fs * 0.58 },
      table: {
        widths: [t.align === "left" ? Math.max(w, need * 1.02) : w],
        body: [[{
          text: t.text, fontSize: fs, bold: !!t.bold, noWrap: true, alignment: t.align,
          color: t.color ? `#${t.color}` : "#000000", lineHeight: 1,
          ...(t.struck ? { decoration: "lineThrough" } : {}),
        }]],
      },
      layout: NO_PAD,
    });
  }
  // Shading and lines first, text on top.
  if (canvas.length) nodes.unshift({ canvas, absolutePosition: { x: 0, y: 0 } });
  return { nodes, orientation: landscape ? "landscape" : "portrait" };
}

export function pagesDefinition(doc) {
  const content = [];
  let first = "portrait";
  doc.pages.forEach((page, i) => {
    const { nodes, orientation } = pageNodes(page);
    if (i === 0) first = orientation;
    else content.push({ text: "", pageBreak: "before", pageOrientation: orientation });
    if (!nodes.length) content.push({ text: "" });
    content.push(...nodes);
  });
  return {
    info: { title: doc.title || "Scanned document", creator: "OmniScan" },
    pageSize: "A4", pageOrientation: first, pageMargins: [0, 0, 0, 0],
    defaultStyle: { font: "Roboto" },
    content,
  };
}
