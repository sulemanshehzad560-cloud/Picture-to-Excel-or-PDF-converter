// Excel page copy: one sheet laid out like the scanned page. Column widths and row heights are
// cut at the page's own edges (table rules, where text starts and ends), tables keep their cells,
// shading and ruling, and the sheet prints on exactly one page.

import { asNumber } from "./common.js";
import { pageModel } from "./replica.js";

const NOTE = "Low-confidence reading - please verify against the original.";
const LINE = { style: "thin", color: { argb: "FF000000" } };

function colName(n) {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Sorted cut positions: fixed ones always kept, others only if clear of every existing cut. */
function cuts(fixed, loose, tol) {
  const out = [...new Set(fixed.map((v) => Math.round(v * 10) / 10))].sort((a, b) => a - b);
  for (const v of [...loose].sort((a, b) => a - b)) {
    if (out.every((c) => Math.abs(c - v) > tol)) out.push(v);
  }
  return out.sort((a, b) => a - b);
}
const nearest = (arr, v) => arr.reduce((best, x, i) => (Math.abs(x - v) < Math.abs(arr[best] - v) ? i : best), 0);

export function addPageSheet(wb, page, name) {
  const m = pageModel(page);
  const landscape = m.w > m.h;
  // Printable area in screen pixels (96 dpi) of an A4 sheet with narrow margins.
  const [pw, ph] = landscape ? [1060, 740] : [740, 1060];
  const s = Math.min(pw / m.w, ph / m.h);
  const tol = 4 / s;

  const tx = m.tables.flatMap((t) => t.xs), ty = m.tables.flatMap((t) => t.ys);
  const texts = m.texts; // never table cells: those are drawn with their table
  // Free text: one sheet row per printed line (lines clustered by their centre), so lines on a
  // tilted page never compete for the same cells; columns start where text starts.
  const lh = texts.map((t) => t.y1 - t.y0).sort((a, b) => a - b)[texts.length >> 1] || 20;
  const centres = [];
  for (const cy of texts.map((t) => (t.y0 + t.y1) / 2).sort((a, b) => a - b)) {
    const last = centres[centres.length - 1];
    if (last && cy - last.at(-1) < 0.4 * lh) last.push(cy); else centres.push([cy]);
  }
  const mids = centres.map((g) => g.reduce((a, b) => a + b, 0) / g.length);
  const rowCuts = mids.slice(1).map((m, i) => (mids[i] + m) / 2);
  if (mids.length) rowCuts.push(mids[0] - 0.6 * lh, mids[mids.length - 1] + 0.6 * lh);
  const X = cuts([0, m.w, ...tx], texts.map((t) => t.x0), tol);
  const Y = cuts([0, m.h, ...ty], rowCuts, tol);
  const ws = wb.addWorksheet(name, {
    views: [{ showGridLines: false }],
    pageSetup: {
      paperSize: 9, orientation: landscape ? "landscape" : "portrait",
      fitToPage: true, fitToWidth: 1, fitToHeight: 1, horizontalCentered: true,
      margins: { left: 0.25, right: 0.25, top: 0.25, bottom: 0.25, header: 0, footer: 0 },
    },
  });
  ws.properties.defaultRowHeight = 12;
  for (let c = 0; c + 1 < X.length; c++) ws.getColumn(c + 1).width = Math.max(0.1, ((X[c + 1] - X[c]) * s - 5) / 7);
  for (let r = 0; r + 1 < Y.length; r++) ws.getRow(r + 1).height = Math.max(1, (Y[r + 1] - Y[r]) * s * 0.75);
  ws.pageSetup.printArea = `A1:${colName(X.length - 1)}${Y.length - 1}`;

  const taken = new Set();
  const free = (r0, c0, r1, c1) => {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (taken.has(`${r},${c}`)) return false;
    return true;
  };
  const take = (r0, c0, r1, c1) => {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) taken.add(`${r},${c}`);
    if (r1 > r0 || c1 > c0) ws.mergeCells(r0 + 1, c0 + 1, r1 + 1, c1 + 1);
  };
  const pt = (fontPx) => Math.max(5, Math.min(48, Math.round(fontPx * s * 0.75 * 2) / 2));
  const put = (r, c, text, st, numeric) => {
    const cell = ws.getCell(r + 1, c + 1);
    const num = numeric ? asNumber(text) : null;
    if (num) { cell.value = num.value; cell.numFmt = num.format; }
    else cell.value = text.startsWith("=") ? { richText: [{ text }] } : text;
    cell.font = { name: "Arial", size: pt(st.fontPx), bold: !!st.bold, strike: !!st.struck, ...(st.color ? { color: { argb: `FF${st.color}` } } : {}) };
    cell.alignment = { horizontal: st.align || "left", vertical: "middle", wrapText: text.includes("\n"), shrinkToFit: !text.includes("\n") };
    if (st.uncertain) cell.note = NOTE;
    if (st.struck) cell.note = cell.note ? `${cell.note}\nCrossed out on the original.` : "Crossed out on the original.";
    return cell;
  };

  for (const t of m.tables) {
    const cx = t.xs.map((x) => nearest(X, x)), ry = t.ys.map((y) => nearest(Y, y));
    for (const c of t.cells) {
      if (c.covered) continue;
      const r0 = ry[c.r], r1 = Math.max(r0, ry[c.r + 1] - 1), c0 = cx[c.c], c1 = Math.max(c0, cx[c.c + c.span] - 1);
      if (!free(r0, c0, r1, c1)) continue;
      take(r0, c0, r1, c1);
      if (c.text && r0 === r1) {
        const need = pt(c.fontPx) * 1.2 * String(c.text).split("\n").length;
        if (ws.getRow(r0 + 1).height < need) ws.getRow(r0 + 1).height = need;
      }
      const cell = put(r0, c0, c.text, c, !c.header);
      // Written further in: Excel indents in steps of about three character widths.
      if (c.indent) cell.alignment = { ...cell.alignment, indent: Math.min(15, Math.round((c.indent * s) / 21)) };
      if (c.fill) {
        for (let r = r0; r <= r1; r++) for (let k = c0; k <= c1; k++) {
          ws.getCell(r + 1, k + 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${c.fill}` } };
        }
      }
      // Ruling as on paper, on every edge cell of a merged range.
      const edges = { left: t.v[c.c], right: t.v[c.c + c.span], top: t.h, bottom: t.h };
      for (let r = r0; r <= r1; r++) for (let k = c0; k <= c1; k++) {
        const b = {};
        if (edges.left && k === c0) b.left = LINE;
        if (edges.right && k === c1) b.right = LINE;
        if (edges.top && r === r0) b.top = LINE;
        if (edges.bottom && r === r1) b.bottom = LINE;
        if (Object.keys(b).length) ws.getCell(r + 1, k + 1).border = { ...(ws.getCell(r + 1, k + 1).border || {}), ...b };
      }
    }
  }

  const band = (arr, v) => Math.max(0, Math.min(arr.length - 2, arr.findIndex((x, i) => i + 1 < arr.length && v >= x && v < arr[i + 1])));
  for (const t of texts) {
    let c = nearest(X, t.x0);
    if (X[c] > t.x0 + tol && c > 0) c--;
    // The row of the line's centre, or the nearest free row within the line's own height (a
    // tilted line's box overlaps its neighbours').
    const cy = (t.y0 + t.y1) / 2;
    const options = [...new Set([band(Y, cy), band(Y, cy + 0.25 * (t.y1 - t.y0)), band(Y, cy - 0.25 * (t.y1 - t.y0)), band(Y, t.y1 - 1), band(Y, t.y0 + 1)])];
    const r = options.find((k) => !taken.has(`${k},${c}`)) ?? options[0];
    // Never lose text: take the next free cell to the right, or share the cell.
    while (taken.has(`${r},${c}`) && c + 2 < X.length && X[c + 1] < t.x1) c++;
    if (taken.has(`${r},${c}`)) {
      const cell = ws.getCell(r + 1, c + 1);
      cell.value = `${cell.text} ${t.text}`;
      continue;
    }
    taken.add(`${r},${c}`);
    // A row is at least as tall as its type (a tilted page packs its line centres closer).
    const need = pt(t.fontPx) * 1.2;
    if (ws.getRow(r + 1).height < need) ws.getRow(r + 1).height = need;
    // Left-aligned text runs on into the empty cells to its right, as on paper.
    const cell = put(r, c, t.text, t, true);
    cell.alignment = { ...cell.alignment, shrinkToFit: false, wrapText: false };
  }
  return ws;
}
