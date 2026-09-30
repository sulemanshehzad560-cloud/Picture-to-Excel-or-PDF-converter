import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { asNumber, normalize } from "../src/export/common.js";
import { exportDocument, toMarkdown } from "../src/export/index.js";

export function sampleDoc() {
  return {
    title: "Order 7",
    pages: [{
      page_number: 1,
      notes: "corner torn",
      blocks: [
        { type: "heading", text: "Stationery order", level: 1 },
        { type: "paragraph", text: "Deliver by Friday.\nGate 2", uncertain: true },
        { type: "list", items: ["pens", "tape"], ordered: true },
        { type: "key_value", pairs: [{ key: "Phone", value: "0301-555-0192" }, { key: "Code", value: "007", uncertain: true }] },
        { type: "checkbox", text: "Paid", checked: true },
        {
          type: "table", header_rows: 1, rows: [
            [{ text: "Item" }, { text: "Qty" }, { text: "Price" }],
            [{ text: "Pencils" }, { text: "12" }, { text: "0.750" }],
            [{ text: "Ink" }, { text: "1,200" }, { text: "$3.10", uncertain: true }],
            [{ text: "=SUM(A1)" }, { text: "-4" }, { text: "12.5%" }],
            [{ text: "short row" }],
          ],
        },
        { type: "signature", text: "J. Carter" },
      ],
    }],
  };
}

test("number detection keeps every character meaningful", () => {
  assert.deepEqual(asNumber("12"), { value: 12, format: "0" });
  assert.deepEqual(asNumber("0.750"), { value: 0.75, format: "0.000" }); // trailing zero kept via format
  assert.deepEqual(asNumber("1,200"), { value: 1200, format: "#,##0" });
  assert.deepEqual(asNumber("-4"), { value: -4, format: "0" });
  assert.deepEqual(asNumber("$3.10"), { value: 3.1, format: '"$"0.00' });
  assert.equal(asNumber("12.5%").format, "0.0%");
  for (const s of ["007", "4111111111111111", "12 kg", "3:30", "INV-2291"]) assert.equal(asNumber(s), null, s);
});

test("normalize pads ragged tables", () => {
  const d = normalize(sampleDoc());
  const t = d.pages[0].blocks.find((b) => b.type === "table");
  assert.ok(t.rows.every((r) => r.length === 3));
});

test("xlsx: typed numbers, exact formats, flagged cells, no formula injection", async () => {
  const { bytes, filename } = await exportDocument(sampleDoc(), "xlsx");
  assert.equal(filename, "Order 7.xlsx");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes);
  const ws = wb.getWorksheet("Table 1");
  assert.equal(ws.getCell("A1").value, "Item");
  assert.equal(ws.getCell("A1").font.bold, true);
  assert.equal(ws.getCell("C2").value, 0.75);
  assert.equal(ws.getCell("C2").numFmt, "0.000");
  assert.equal(ws.getCell("B3").value, 1200);
  assert.equal(ws.getCell("C3").fill.fgColor.argb, "FFFFF2A8");
  assert.ok(ws.getCell("C3").note);
  assert.equal(ws.getCell("A4").formula, undefined);
  assert.equal(ws.getCell("A4").text, "=SUM(A1)");
  const content = wb.getWorksheet("Content");
  const values = [];
  content.eachRow((row) => row.eachCell((c) => values.push(c.text)));
  for (const v of ["0301-555-0192", "007", "Deliver by Friday.", "Gate 2"]) assert.ok(values.includes(v), v);
});

test("docx contains every block", async () => {
  const { bytes } = await exportDocument(sampleDoc(), "docx");
  const xml = await (await JSZip.loadAsync(bytes)).file("word/document.xml").async("string");
  for (const s of ["Stationery order", "Gate 2", "☑ Paid", "0.750", "0301-555-0192", "Scanner note: corner torn"]) assert.ok(xml.includes(s), s);
  assert.ok(xml.includes('w:highlight w:val="yellow"'));
});

test("pdf renders, including a cell longer than a page", async () => {
  const doc = sampleDoc();
  doc.pages[0].blocks.push({ type: "table", rows: [[{ text: "word ".repeat(3000) }, { text: "x" }]] });
  const { bytes, mime } = await exportDocument(doc, "pdf");
  assert.equal(mime, "application/pdf");
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
});

test("csv, zip of csvs, markdown, text, json", async () => {
  const doc = sampleDoc();
  const csv = new TextDecoder().decode((await exportDocument(doc, "csv")).bytes);
  assert.ok(csv.includes("Pencils,12,0.750"));
  assert.ok(csv.includes('"1,200"'));
  doc.pages[0].blocks.push({ type: "table", rows: [[{ text: "a" }]] });
  const zip = await exportDocument(doc, "csv");
  assert.equal(zip.ext, "zip");
  assert.equal(Object.keys((await JSZip.loadAsync(zip.bytes)).files).length, 2);
  const md = toMarkdown(normalize(doc));
  assert.ok(md.includes("| Item | Qty | Price |") && md.includes("$3.10 ⚠"));
  assert.ok(new TextDecoder().decode((await exportDocument(doc, "txt")).bytes).includes("Gate 2"));
  assert.equal(JSON.parse(new TextDecoder().decode((await exportDocument(doc, "json")).bytes)).title, "Order 7");
  await assert.rejects(exportDocument(doc, "exe"));
  assert.equal((await exportDocument(doc, "txt", "inv/../x")).filename, "invx.txt");
});
