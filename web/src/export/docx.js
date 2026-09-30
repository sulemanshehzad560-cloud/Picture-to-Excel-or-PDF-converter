import {
  AlignmentType, BorderStyle, Document, HeadingLevel, LevelFormat, Packer, PageBreak, Paragraph, ShadingType,
  Table, TableCell, TableRow, TextRun, WidthType,
} from "docx";
import { pageSection } from "./docx-page.js";
import { hasLayout } from "./replica.js";

const GRID = { style: BorderStyle.SINGLE, size: 4, color: "B7BDC9" };
const BORDERS = { top: GRID, bottom: GRID, left: GRID, right: GRID, insideHorizontal: GRID, insideVertical: GRID };

function runs(text, { uncertain = false, bold = false, italics = false, color, size, strike = false } = {}) {
  const lines = String(text ?? "").split("\n");
  return lines.map((line, i) => new TextRun({
    text: line, bold, italics, color, size, strike,
    highlight: uncertain ? "yellow" : undefined,
    break: i > 0 ? 1 : undefined,
  }));
}

function cell(text, { uncertain, header, shade, struck } = {}) {
  return new TableCell({
    children: [new Paragraph({ children: runs(text, { uncertain, bold: header, strike: struck }) })],
    shading: shade ? { type: ShadingType.CLEAR, color: "auto", fill: shade } : undefined,
  });
}

function table(rows) {
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE }, borders: BORDERS });
}

export async function toDocx(doc, { layout = "page" } = {}) {
  if (layout === "page" && doc.pages.length && doc.pages.every(hasLayout)) {
    // Page copy: one Word page per scanned page, laid out as scanned.
    const document = new Document({
      creator: "OmniScan", title: doc.title || "Scanned document",
      styles: { default: { document: { run: { font: "Arial", size: 20 } } } },
      sections: doc.pages.map(pageSection),
    });
    return new Uint8Array(await (await Packer.toBlob(document)).arrayBuffer());
  }
  const children = [];
  if (doc.title) children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: runs(doc.title) }));
  doc.pages.forEach((page, pi) => {
    if (pi) children.push(new Paragraph({ children: [new PageBreak()] }));
    for (const b of page.blocks) {
      switch (b.type) {
        case "heading":
          children.push(new Paragraph({
            heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][Math.min(2, Math.max(0, (b.level || 1) - 1))],
            children: runs(b.text, { uncertain: b.uncertain }),
          }));
          break;
        case "paragraph":
          children.push(new Paragraph({ children: runs(b.text, { uncertain: b.uncertain }) }));
          break;
        case "list":
          for (const item of b.items || []) {
            children.push(new Paragraph({
              children: runs(item, { uncertain: b.uncertain }),
              ...(b.ordered ? { numbering: { reference: "numbered", level: 0 } } : { bullet: { level: 0 } }),
            }));
          }
          break;
        case "table": {
          const hdr = b.header_rows || 0;
          children.push(table(b.rows.map((row, r) => new TableRow({
            tableHeader: r < hdr,
            children: row.map((c) => cell(c.text, { uncertain: c.uncertain, struck: c.struck, header: r < hdr, shade: r < hdr ? "DCE3F0" : undefined })),
          }))));
          children.push(new Paragraph({}));
          break;
        }
        case "key_value":
          if (b.pairs?.length) {
            children.push(table(b.pairs.map((kv) => new TableRow({
              children: [cell(kv.key, { uncertain: kv.uncertain, header: true, shade: "EEF1F7" }), cell(kv.value, { uncertain: kv.uncertain })],
            }))));
            children.push(new Paragraph({}));
          }
          break;
        case "checkbox":
          children.push(new Paragraph({ children: runs(`${b.checked ? "☑" : "☐"} ${b.text || ""}`, { uncertain: b.uncertain }) }));
          break;
        default: // signature, figure
          children.push(new Paragraph({
            children: runs((b.type === "signature" ? "Signature: " : "") + (b.text || ""), { italics: true, color: "666E80" }),
          }));
      }
    }
    if (page.notes) {
      children.push(new Paragraph({ children: runs(`Scanner note: ${page.notes}`, { italics: true, color: "888888", size: 18 }) }));
    }
  });
  if (!children.length) children.push(new Paragraph({ children: runs("(no text found)", { italics: true }) }));

  const document = new Document({
    creator: "OmniScan",
    title: doc.title || "Scanned document",
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    numbering: {
      config: [{
        reference: "numbered",
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START }],
      }],
    },
    sections: [{ children }],
  });
  const blob = await Packer.toBlob(document);
  return new Uint8Array(await blob.arrayBuffer());
}
