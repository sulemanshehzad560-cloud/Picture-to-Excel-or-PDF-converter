// Page copy: Excel, Word and PDF reproduce the scanned page (places, sizes, shading, ruling) on
// one page per scanned page.

import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { exportDocument } from "../src/export/index.js";
import { contentSig } from "../src/export/common.js";
import { drawList, pageModel } from "../src/export/replica.js";
import { buildLayout } from "../src/ocr/layout.js";

function scanned() {
  const para = { type: "paragraph", text: "Stock count 21/09/26", uncertain: false };
  para.geo = { lines: [{ box: [100, 40, 520, 80], h: 40, text: "Stock count 21/09/26", style: { bold: true, color: "000000" } }] };
  para.geo.sig = contentSig(para);
  const cell = (text, box, style = {}) => ({ text, uncertain: false, box, lineH: 36, style });
  const table = {
    type: "table", header_rows: 1,
    rows: [
      [cell("Item", [110, 110, 200, 150], { fill: "7F7F7F", color: "FFFFFF", bold: true }), cell("Qty", [420, 110, 480, 150], { fill: "7F7F7F", color: "FFFFFF", bold: true })],
      [cell("TGP", [110, 160, 180, 200]), cell("-81.00", [500, 160, 590, 200])],
      [cell("KIC", [110, 210, 180, 250], { fill: "F2F2F2" }), cell("-309.00", [480, 210, 590, 250], { fill: "F2F2F2" })],
    ],
    geo: { xs: [100, 400, 600], ys: [100, 155, 205, 255], v: [true, true, true], h: true },
  };
  return { title: "Stock", pages: [{ page_number: 1, width: 700, height: 500, blocks: [para, table] }] };
}

test("page model: text where it was printed, table cells in their grid, numbers right-aligned", () => {
  const m = pageModel(scanned().pages[0]);
  assert.deepEqual([m.texts[0].x0, m.texts[0].y0, m.texts[0].bold], [100, 40, true]);
  const qty = m.tables[0].cells.find((c) => c.text === "-81.00");
  assert.equal(qty.align, "right");
  assert.equal(new Set(m.tables[0].cells.map((c) => c.fontPx)).size, 1, "a ruled grid prints in one size");
  const d = drawList(m);
  assert.ok(d.fills.some((f) => f.fill === "7F7F7F") && d.rules.length === 3 + 4);
});

test("xlsx page copy: one sheet, merged cells, fills, ruling, typed numbers, prints on one page", async () => {
  const { bytes } = await exportDocument(scanned(), "xlsx");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ["Page 1"]);
  const ws = wb.worksheets[0];
  const all = [];
  ws.eachRow((row) => row.eachCell((c) => { if (!c.isMerged || c.master === c) all.push(c); }));
  const find = (v) => all.find((c) => c.value === v);
  assert.ok(find("Stock count 21/09/26").font.bold);
  const hdr = find("Item");
  assert.equal(hdr.fill.fgColor.argb, "FF7F7F7F");
  assert.equal(hdr.font.color.argb, "FFFFFFFF");
  assert.ok(hdr.border.top && hdr.border.left);
  const qty = find(-81);
  assert.equal(qty.numFmt, "0.00");
  assert.equal(qty.alignment.horizontal, "right");
  assert.equal(ws.pageSetup.fitToPage, true);
  assert.equal(ws.pageSetup.fitToHeight, 1);
  assert.equal(ws.views[0].showGridLines, false);
});

test("an edited line takes the place of the original", async () => {
  const doc = scanned();
  doc.pages[0].blocks[0].text = "Stock count 22/09/26";
  const { bytes } = await exportDocument(doc, "xlsx");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes);
  const vals = [];
  wb.worksheets[0].eachRow((r) => r.eachCell((c) => vals.push(c.value)));
  assert.ok(vals.includes("Stock count 22/09/26") && !vals.includes("Stock count 21/09/26"));
});

test("pdf page copy is one page; word page copy positions frames and a floating table", async () => {
  const pdf = new TextDecoder("latin1").decode((await exportDocument(scanned(), "pdf")).bytes);
  assert.match(pdf, /\/Count 1\b/);
  const docx = (await exportDocument(scanned(), "docx")).bytes;
  const xml = await (await JSZip.loadAsync(docx)).file("word/document.xml").async("string");
  assert.ok(xml.includes("w:framePr") && xml.includes("w:tblpPr"));
  assert.ok(xml.includes("Stock count 21/09/26") && xml.includes("-309.00"));
  assert.ok(xml.includes('w:fill="7F7F7F"'));
});

test("data layout still gives one sheet per table", async () => {
  const { bytes } = await exportDocument(scanned(), "xlsx", "x", { layout: "data" });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ["Table 1", "Content"]);
});

test("layout records where each block's text sits", () => {
  const line = (text, x0, y0, w, h = 30) => ({
    text, score: 0.99, vertical: false, minProb: 0.99,
    pts: [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]],
    chars: [...text].map((c, i) => ({ c, p: 0.99, x: (i + 0.5) / text.length })),
  });
  const blocks = buildLayout(null, null, [
    line("Delivery note", 100, 40, 300),
    line("Item", 100, 150, 80), line("Qty", 500, 150, 60),
    line("Pens", 100, 200, 80), line("12", 500, 200, 40),
    line("Ink", 100, 250, 60), line("3", 500, 250, 20),
  ], null);
  const para = blocks.find((b) => b.type !== "table"), table = blocks.find((b) => b.type === "table");
  assert.deepEqual(para.geo.lines[0].box.map(Math.round), [100, 40, 400, 70]);
  assert.equal(para.geo.sig, contentSig(para));
  assert.equal(table.geo.xs.length, 3);
  assert.ok(table.rows[1][1].box[0] === 500);
});
