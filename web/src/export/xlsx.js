import ExcelJS from "exceljs";
import { asNumber, blockText, tables } from "./common.js";

const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2A44" } };
const UNCERTAIN_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2A8" } };
const THIN = { style: "thin", color: { argb: "FFB7BDC9" } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const NOTE = "Low-confidence reading - please verify against the original.";

function sheetName(name, used) {
  let base = name.replace(/[[\]:*?/\\]/g, "-").slice(0, 31) || "Sheet";
  let out = base, n = 2;
  while (used.has(out)) {
    const suffix = ` (${n++})`;
    out = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(out);
  return out;
}

function write(ws, r, c, text, { uncertain = false, header = false, struck = false } = {}) {
  const cell = ws.getCell(r, c);
  const num = header ? null : asNumber(text);
  if (num) {
    cell.value = num.value;
    cell.numFmt = num.format;
  } else {
    // Rich text so a handwritten "=5+3" is stored as text, never a live formula.
    cell.value = text.startsWith("=") ? { richText: [{ text }] } : text;
  }
  cell.border = BORDER;
  cell.alignment = { wrapText: true, vertical: "top" };
  if (header) {
    cell.fill = HEADER_FILL;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
  }
  if (uncertain) {
    cell.fill = UNCERTAIN_FILL;
    cell.note = NOTE;
  }
  if (struck) {
    // Crossed out on paper: kept (it may matter) but struck through, exactly as written.
    cell.font = { ...(cell.font || {}), strike: true, color: { argb: "FF7A7F8C" } };
    cell.note = cell.note ? `${cell.note}\nCrossed out on the original.` : "Crossed out on the original.";
  }
}

function autofit(ws) {
  ws.columns.forEach((col) => {
    let w = 8;
    col.eachCell({ includeEmpty: false }, (cell) => {
      const v = cell.value && cell.value.richText ? cell.value.richText.map((t) => t.text).join("") : cell.value;
      const longest = Math.max(...String(v ?? "").split("\n").map((l) => l.length));
      w = Math.max(w, longest + 2);
    });
    col.width = Math.min(60, w);
  });
}

export async function toXlsx(doc) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "OmniScan";
  const used = new Set();
  const tbls = tables(doc);

  for (const { page, n, block } of tbls) {
    const ws = wb.addWorksheet(sheetName(doc.pages.length === 1 ? `Table ${n}` : `P${page} Table ${n}`, used));
    const hdr = block.header_rows || 0;
    block.rows.forEach((row, r) => row.forEach((cell, c) => write(ws, r + 1, c + 1, cell.text, { uncertain: cell.uncertain, header: r < hdr, struck: cell.struck })));
    if (hdr) ws.views = [{ state: "frozen", ySplit: hdr }];
    autofit(ws);
  }

  // Everything that isn't a table: form fields get Field/Value columns, the rest one row per line.
  const rows = [];
  for (const page of doc.pages) for (const b of page.blocks) {
    if (b.type === "table") continue;
    if (b.type === "key_value") {
      for (const kv of b.pairs || []) rows.push([String(page.page_number), "field", kv.key, kv.value, kv.uncertain]);
    } else if (b.type === "checkbox") {
      rows.push([String(page.page_number), "checkbox", b.text || "", b.checked ? "☑ checked" : "☐ unchecked", b.uncertain]);
    } else {
      const lines = b.type === "list" ? b.items || [] : blockText(b).split("\n");
      for (const line of lines) rows.push([String(page.page_number), b.type, line, "", b.uncertain]);
    }
  }
  if (rows.length || !tbls.length) {
    const ws = wb.addWorksheet(sheetName("Content", used));
    ["Page", "Type", "Field / Text", "Value"].forEach((h, c) => write(ws, 1, c + 1, h, { header: true }));
    rows.forEach(([page, type, a, b, unc], i) => {
      write(ws, i + 2, 1, page);
      write(ws, i + 2, 2, type);
      write(ws, i + 2, 3, a, { uncertain: unc });
      if (b || type === "field") write(ws, i + 2, 4, b, { uncertain: unc });
    });
    ws.views = [{ state: "frozen", ySplit: 1 }];
    autofit(ws);
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
