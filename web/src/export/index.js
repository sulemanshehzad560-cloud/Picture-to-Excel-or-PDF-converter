// Turn an ExtractedDocument into the file format the user picked. Runs fully on-device.
// Heavy libraries (ExcelJS, docx, pdfmake) are loaded on demand to keep app start-up fast.

import JSZip from "jszip";
import { blockText, normalize, plainText, safeName, tables } from "./common.js";

export const FORMATS = {
  xlsx: { label: "Excel", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  docx: { label: "Word", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  pdf: { label: "PDF", mime: "application/pdf" },
  csv: { label: "CSV", mime: "text/csv" },
  md: { label: "Markdown", mime: "text/markdown" },
  txt: { label: "Text", mime: "text/plain" },
  json: { label: "JSON", mime: "application/json" },
};

const enc = (s) => new TextEncoder().encode(s);

function csvOf(rows) {
  const esc = (v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return "﻿" + rows.map((r) => r.map((v) => esc(String(v ?? ""))).join(",")).join("\r\n") + "\r\n"; // BOM: Excel opens UTF-8
}

export function toMarkdown(doc) {
  const out = [];
  if (doc.title) out.push(`# ${doc.title}`, "");
  for (const page of doc.pages) {
    if (doc.pages.length > 1) out.push(`<!-- page ${page.page_number} -->`);
    for (const b of page.blocks) {
      if (b.type === "heading") out.push(`${"#".repeat(Math.min(6, (b.level || 1) + (doc.title ? 1 : 0)))} ${b.text || ""}`);
      else if (b.type === "table" && b.rows?.length) {
        const esc = (s) => s.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
        const rows = b.rows.map((r) => r.map((c) => (c.struck && c.text ? `~~${esc(c.text)}~~` : esc(c.text)) + (c.uncertain ? " ⚠" : "")));
        out.push(`| ${rows[0].join(" | ")} |`, `|${"---|".repeat(rows[0].length)}`);
        for (const r of (b.header_rows ? rows.slice(1) : rows)) out.push(`| ${r.join(" | ")} |`);
      } else if (b.type === "key_value") out.push(...(b.pairs || []).map((kv) => `- **${kv.key}:** ${kv.value}`));
      else out.push(blockText(b));
      out.push("");
    }
  }
  return out.join("\n").trim() + "\n";
}

/**
 * -> {bytes: Uint8Array, mime, ext, filename}. `opts.layout`: "page" (default) copies each scanned page's
 * layout in Excel, Word and PDF; "data" gives one sheet per table and a plain document flow.
 */
export async function exportDocument(rawDoc, fmt, name, opts = {}) {
  const doc = normalize(rawDoc);
  const stem = safeName(name || doc.title);
  let bytes, mime = FORMATS[fmt]?.mime, ext = fmt;
  switch (fmt) {
    case "xlsx": bytes = await (await import("./xlsx.js")).toXlsx(doc, opts); break;
    case "docx": bytes = await (await import("./docx.js")).toDocx(doc, opts); break;
    case "pdf": bytes = await (await import("./pdf.js")).toPdf(doc, opts); break;
    case "json": bytes = enc(JSON.stringify(doc, null, 2)); break;
    case "txt": bytes = enc(plainText(doc)); break;
    case "md": bytes = enc(toMarkdown(doc)); break;
    case "csv": {
      const t = tables(doc);
      if (!t.length) bytes = enc(csvOf(plainText(doc).split("\n").map((l) => [l])));
      else if (t.length === 1) bytes = enc(csvOf(t[0].block.rows.map((r) => r.map((c) => c.text))));
      else {
        const zip = new JSZip();
        for (const { page, n, block } of t) zip.file(`page${page}_table${n}.csv`, csvOf(block.rows.map((r) => r.map((c) => c.text))));
        bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
        mime = "application/zip";
        ext = "zip";
      }
      break;
    }
    default:
      throw new Error(`Unknown format: ${fmt}`);
  }
  return { bytes, mime, ext, filename: `${stem}.${ext}` };
}
