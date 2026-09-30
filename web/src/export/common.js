// Shared helpers for the exporters. Documents use the same JSON shape as app/schema.py.

/** Make every table rectangular and clamp header_rows, so exporters can rely on the grid. */
export function normalize(doc) {
  const copy = structuredClone(doc);
  for (const page of copy.pages) {
    for (const b of page.blocks) {
      if (b.type === "table" && b.rows?.length) {
        const width = Math.max(...b.rows.map((r) => r.length));
        b.rows = b.rows.map((r) => [...r, ...Array.from({ length: width - r.length }, () => ({ text: "", uncertain: false }))]);
        b.header_rows = Math.max(0, Math.min(b.header_rows || 0, b.rows.length));
      }
    }
  }
  return copy;
}

export function tables(doc) {
  const out = [];
  for (const page of doc.pages) {
    let n = 0;
    for (const b of page.blocks) if (b.type === "table" && b.rows?.length) out.push({ page: page.page_number, n: ++n, block: b });
  }
  return out;
}

export function blockText(b) {
  switch (b.type) {
    case "list": return (b.items || []).map((x, i) => (b.ordered ? `${i + 1}. ` : "• ") + x).join("\n");
    case "table": return (b.rows || []).map((r) => r.map((c) => (c.struck && c.text ? `~~${c.text}~~` : c.text)).join("\t")).join("\n");
    case "key_value": return (b.pairs || []).map((kv) => `${kv.key}: ${kv.value}`).join("\n");
    case "checkbox": return `[${b.checked ? "x" : " "}] ${b.text || ""}`;
    case "signature": return `(signature) ${b.text || ""}`.trim();
    case "figure": return `(figure) ${b.text || ""}`.trim();
    default: return b.text || "";
  }
}

export function plainText(doc) {
  return doc.pages.flatMap((p) => p.blocks.map(blockText)).join("\n\n").trim();
}

// Only unambiguous numbers become numeric cells; everything else stays text exactly as read.
const NUM_RE = /^(?<cur>[$€£¥₹])?\s?(?<neg>-)?(?<int>\d{1,3}(?:,\d{3})+|\d+)(?:\.(?<dec>\d+))?(?<pct>%)?$/;

/** -> {value, format} or null. Keeps leading zeros ("007") and long IDs as text. */
export function asNumber(text) {
  const m = NUM_RE.exec(String(text).trim());
  if (!m) return null;
  const { cur, neg, int, dec = "", pct } = m.groups;
  if (int.length > 1 && int.startsWith("0")) return null;
  if (int.replace(/,/g, "").length > 15) return null; // beyond spreadsheet precision (card/account numbers)
  let value = Number(int.replace(/,/g, "") + (dec ? `.${dec}` : ""));
  if (neg) value = -value;
  let format = (int.includes(",") ? "#,##0" : "0") + (dec ? `.${"0".repeat(dec.length)}` : "");
  if (pct) return { value: value / 100, format: `${format}%` };
  if (cur) format = `"${cur}"${format}`;
  return { value, format };
}

export function safeName(name, fallback = "scan") {
  return (String(name || "").replace(/[^\w\- ]+/g, "").trim().slice(0, 80)) || fallback;
}

/** What a block says (not how it looks): tells the page copy whether the user edited it. */
export function contentSig(b) {
  return JSON.stringify([b.type, b.text ?? null, b.items ?? null, (b.pairs || []).map((p) => [p.key, p.value]), b.checked ?? null]);
}
