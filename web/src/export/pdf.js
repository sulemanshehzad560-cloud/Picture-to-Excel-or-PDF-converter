import pdfMake from "pdfmake/build/pdfmake.js";
import vfs from "pdfmake/build/vfs_fonts.js";

pdfMake.addVirtualFileSystem(vfs);

const UNC_BG = "#FFF2A8";
const txt = (text, uncertain, extra = {}) => ({ text: String(text ?? ""), ...(uncertain ? { background: UNC_BG } : {}), ...extra });

// Roboto (bundled, offline) covers Latin, Greek and Cyrillic; ballot-box glyphs are not in it.
const box = (checked) => (checked ? "[x]" : "[ ]");

export async function toPdf(doc) {
  const content = [];
  if (doc.title) content.push({ text: doc.title, style: "title" });
  doc.pages.forEach((page, pi) => {
    const start = content.length;
    for (const b of page.blocks) {
      switch (b.type) {
        case "heading":
          content.push({ ...txt(b.text, b.uncertain), style: `h${Math.min(3, Math.max(1, b.level || 1))}` });
          break;
        case "paragraph":
          content.push({ ...txt(b.text, b.uncertain), margin: [0, 0, 0, 6] });
          break;
        case "list":
          content.push({ [b.ordered ? "ol" : "ul"]: (b.items || []).map((i) => txt(i, b.uncertain)), margin: [0, 0, 0, 6] });
          break;
        case "table": {
          const hdr = b.header_rows || 0;
          content.push({
            table: {
              headerRows: hdr,
              dontBreakRows: false,
              widths: b.rows[0].map(() => "*"),
              body: b.rows.map((row, r) => row.map((c) => ({
                ...txt(c.text, c.uncertain),
                ...(c.struck ? { decoration: "lineThrough", color: "#7A7F8C" } : {}),
                ...(r < hdr ? { bold: true, color: "#FFFFFF", fillColor: "#1F2A44" } : {}),
              }))),
            },
            layout: { hLineColor: "#B7BDC9", vLineColor: "#B7BDC9", hLineWidth: () => 0.5, vLineWidth: () => 0.5 },
            fontSize: 9.5,
            margin: [0, 2, 0, 8],
          });
          break;
        }
        case "key_value":
          if (b.pairs?.length) content.push({
            table: { widths: ["30%", "*"], body: b.pairs.map((kv) => [{ ...txt(kv.key, kv.uncertain), bold: true, fillColor: "#EEF1F7" }, txt(kv.value, kv.uncertain)]) },
            layout: { hLineColor: "#B7BDC9", vLineColor: "#B7BDC9", hLineWidth: () => 0.5, vLineWidth: () => 0.5 },
            margin: [0, 2, 0, 8],
          });
          break;
        case "checkbox":
          content.push(txt(`${box(b.checked)} ${b.text || ""}`, b.uncertain, { margin: [0, 0, 0, 4] }));
          break;
        default:
          content.push({ text: (b.type === "signature" ? "Signature: " : "") + (b.text || ""), italics: true, color: "#6B7280" });
      }
    }
    if (page.notes) content.push({ text: `Scanner note: ${page.notes}`, italics: true, color: "#6B7280", fontSize: 9 });
    if (pi && content.length > start) content[start].pageBreak = "before";
  });
  if (!content.length) content.push({ text: "(no text found)", italics: true, color: "#6B7280" });

  const def = {
    info: { title: doc.title || "Scanned document", creator: "OmniScan" },
    pageSize: "A4",
    pageMargins: [50, 46, 50, 46],
    defaultStyle: { font: "Roboto", fontSize: 10.5, lineHeight: 1.2 },
    styles: {
      title: { fontSize: 20, bold: true, margin: [0, 0, 0, 10] },
      h1: { fontSize: 16, bold: true, margin: [0, 8, 0, 4] },
      h2: { fontSize: 13.5, bold: true, margin: [0, 6, 0, 3] },
      h3: { fontSize: 12, bold: true, margin: [0, 4, 0, 2] },
    },
    content,
  };
  return new Uint8Array(await pdfMake.createPdf(def).getBuffer());
}
