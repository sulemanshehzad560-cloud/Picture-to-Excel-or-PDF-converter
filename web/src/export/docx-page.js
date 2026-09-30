// Word page copy: each scanned page becomes one page of the document. Tables are real Word
// tables (editable, same column widths, row heights, shading and ruling) floating at their place
// on the page, and every other line of text is a frame positioned where it was printed.

import {
  AlignmentType, BorderStyle, FrameAnchorType, FrameWrap, HeightRule, PageOrientation, Paragraph,
  Table, TableAnchorType, TableCell, TableLayoutType, TableRow, TextRun, VerticalAlign, OverlapType, WidthType,
} from "docx";
import { pageModel, textEm } from "./replica.js";

const A4 = [11906, 16838]; // twips
const MARGIN = 360;
const LINE = { style: BorderStyle.SINGLE, size: 6, color: "000000" };
const NONE = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const ALIGN = { left: AlignmentType.LEFT, right: AlignmentType.RIGHT, center: AlignmentType.CENTER };

const run = (t, halfPts) => new TextRun({
  text: t.text, size: halfPts, bold: !!t.bold, strike: !!t.struck, font: "Arial",
  color: t.color || "000000",
});

/** -> {properties, children} for one docx section (one scanned page). */
export function pageSection(page) {
  const m = pageModel(page);
  const landscape = m.w > m.h;
  const [PW, PH] = landscape ? [A4[1], A4[0]] : A4;
  const k = Math.min((PW - 2 * MARGIN) / m.w, (PH - 2 * MARGIN) / m.h); // page px -> twips
  const ox = (PW - m.w * k) / 2, oy = MARGIN;
  const half = (px) => Math.max(8, Math.round((px * k) / 10)); // twips -> half-points
  const children = [];

  for (const t of m.tables) {
    const widths = t.xs.slice(1).map((x, i) => Math.max(20, Math.round((x - t.xs[i]) * k)));
    const rows = [];
    for (let r = 0; r < t.rows; r++) {
      const cells = [];
      for (let c = 0; c < t.cols; c++) {
        const cell = t.cells.find((q) => q.r === r && q.c === c) || { text: "", align: "left", span: 1 };
        if (cell.covered) continue;
        const span = cell.span || 1;
        cells.push(new TableCell({
          columnSpan: span > 1 ? span : undefined,
          width: { size: widths.slice(c, c + span).reduce((a, b) => a + b, 0), type: WidthType.DXA },
          verticalAlign: VerticalAlign.CENTER,
          margins: { top: 0, bottom: 0, left: 40, right: 40 },
          shading: cell.fill ? { fill: cell.fill, color: "auto", type: "clear" } : undefined,
          borders: {
            left: t.v[c] ? LINE : NONE, right: t.v[c + span] ? LINE : NONE,
            top: t.h ? LINE : NONE, bottom: t.h ? LINE : NONE,
          },
          children: String(cell.text).split("\n").map((line) => new Paragraph({
            alignment: ALIGN[cell.align] || AlignmentType.LEFT,
            indent: cell.indent ? { left: Math.round(cell.indent * k) } : undefined,
            spacing: { before: 0, after: 0, line: 240 },
            children: line ? [run({ ...cell, text: line }, half(cell.fontPx || 12))] : [],
          })),
        }));
      }
      // As tall as on paper, and never shorter than its text.
      const lines = Math.max(1, ...t.cells.filter((q) => q.r === r).map((q) => String(q.text).split("\n").length));
      const font = Math.max(0, ...t.cells.filter((q) => q.r === r && q.text).map((q) => half(q.fontPx || 12) * 10));
      rows.push(new TableRow({
        height: { value: Math.max(60, Math.round((t.ys[r + 1] - t.ys[r]) * k), Math.round(font * 1.2 * lines)), rule: HeightRule.EXACT },
        children: cells,
      }));
    }
    children.push(new Table({
      rows, columnWidths: widths, layout: TableLayoutType.FIXED,
      width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
      float: {
        horizontalAnchor: TableAnchorType.PAGE, verticalAnchor: TableAnchorType.PAGE,
        absoluteHorizontalPosition: Math.round(ox + t.xs[0] * k), absoluteVerticalPosition: Math.round(oy + t.ys[0] * k),
        overlap: OverlapType.OVERLAP,
      },
    }));
  }

  for (const t of m.texts) {
    if (!t.text.trim()) continue;
    const size = half(t.fontPx || 12);
    const pt = size / 2;
    const w = Math.max((t.x1 - t.x0) * k, textEm(t.text) * pt * 20 * 1.12);
    const h = Math.round(pt * 20 * 1.25);
    const cy = oy + ((t.y0 + t.y1) / 2) * k;
    children.push(new Paragraph({
      frame: {
        type: "absolute", position: { x: Math.round(ox + t.x0 * k), y: Math.round(cy - h / 2) },
        width: Math.round(w), height: h, wrap: FrameWrap.NONE,
        anchor: { horizontal: FrameAnchorType.PAGE, vertical: FrameAnchorType.PAGE },
      },
      spacing: { before: 0, after: 0, line: 240 },
      children: [run(t, size)],
    }));
  }
  children.push(new Paragraph({ children: [] }));
  return {
    properties: {
      page: {
        size: { width: A4[0], height: A4[1], orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT },
        margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
      },
    },
    children,
  };
}
