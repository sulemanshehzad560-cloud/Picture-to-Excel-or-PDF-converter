// Page copy: where everything sits on the scanned page, so Excel, Word and PDF can reproduce the
// page itself (same places, sizes, shading and ruling, one page per page) instead of a list of
// extracted tables. All coordinates are pixels of the recognised page image.

import { contentSig } from "./common.js";

/** A page can be copied when the engine recorded where its text sits. */
export const hasLayout = (page) => page.width > 0 && page.height > 0 && page.blocks.some((b) => b.geo);

/** A table whose ruling or shading is printed (a grid), as opposed to text in columns. */
const drawnTable = (b) => b.geo.h || b.geo.v.some(Boolean) || b.rows.some((r) => r.some((c) => c.style?.fill));

function align(box, x0, x1) {
  if (box[2] > x1 || box[0] < x0) return "left"; // runs past its column: it starts where it starts
  const left = box[0] - x0, right = x1 - box[2], w = x1 - x0;
  if (right < 0.35 * left && left > 0.08 * w) return "right";
  if (Math.abs(left - right) < 0.2 * w && left > 0.15 * w) return "center";
  return "left";
}

/** Text lines of a block as written now (after the user's edits). */
function blockLines(b) {
  switch (b.type) {
    case "list": return (b.items || []).map((x, i) => (b.ordered ? `${i + 1}. ` : "• ") + x);
    case "key_value": return (b.pairs || []).map((kv) => `${kv.key}: ${kv.value}`);
    case "checkbox": return [`${b.checked ? "☑" : "☐"} ${b.text || ""}`];
    default: return String(b.text || "").split("\n");
  }
}

/** One text item per line of `text`, stacked inside `box`. */
function stack(text, box, extra) {
  const lines = String(text).split("\n");
  const lh = (box[3] - box[1]) / lines.length;
  return lines.map((t, i) => ({ ...extra, text: t, x0: box[0], x1: box[2], y0: box[1] + i * lh, y1: box[1] + (i + 1) * lh, lineH: lh }));
}

/**
 * -> {w, h, tables: [{xs, ys, v, h, header, cells: [{r, c, x0, y0, x1, y1, text, fill, ...}]}],
 *     texts: [{x0, y0, x1, y1, text, lineH, bold, color, align, struck, uncertain}]}
 */
export function pageModel(page) {
  const tables = [], texts = [];
  let bottom = 0;
  for (const b of page.blocks) {
    if (b.type === "table" && b.geo && b.rows?.length && !drawnTable(b)) {
      // Nothing drawn on paper (no ruling, no shading): the cells are text printed at fixed
      // places, and the copy puts each exactly there.
      for (const row of b.rows) for (const cell of row) {
        if (!cell.text || !cell.box) continue;
        const st = cell.style || {};
        const n = cell.text.split("\n").length;
        texts.push(...stack(cell.text, cell.box, {
          align: "left", bold: !!st.bold, color: st.color, struck: !!cell.struck, uncertain: !!cell.uncertain,
        }).map((t) => ({ ...t, lineH: cell.lineH || st.lineH || (cell.box[3] - cell.box[1]) / n })));
      }
      bottom = Math.max(bottom, b.geo.ys[b.geo.ys.length - 1]);
      continue;
    }
    if (b.type === "table" && b.geo && b.rows?.length) {
      const { xs, ys } = b.geo;
      const cells = [];
      b.rows.forEach((row, r) => row.forEach((cell, c) => {
        if (r + 1 >= ys.length || c + 1 >= xs.length) return;
        const x0 = xs[c], x1 = xs[c + 1], y0 = ys[r], y1 = ys[r + 1];
        const st = cell.style || {};
        const box = cell.box || [x0, y0, x1, y1];
        const n = Math.max(1, String(cell.text || "").split("\n").length);
        cells.push({
          r, c, x0, y0, x1, y1, fontPx: 0, text: cell.text || "", fill: st.fill, color: st.color, bold: !!st.bold,
          header: r < (b.header_rows || 0), struck: !!cell.struck, uncertain: !!cell.uncertain,
          // A printed grid aligns text in its cells; on a hand-ruled sheet each entry sits where it
          // was written.
          align: cell.box && b.geo.h ? align(cell.box, x0, x1) : "left",
          indent: cell.box && !b.geo.h ? Math.max(0, cell.box[0] - x0) : 0,
          lineH: cell.lineH || st.lineH || Math.min((box[3] - box[1]) / n, (y1 - y0) / n),
          boxW: cell.box ? cell.box[2] - cell.box[0] : 0,
        });
      }));
      for (const c of cells) c.fontPx = c.text && c.boxW ? fontFor(c.text.split("\n")[0], c.boxW, c.lineH) : 0;
      if (b.geo.h) {
        // A ruled grid is printed in one type size: what fits its cells' text.
        const sizes = cells.filter((c) => c.fontPx).map((c) => c.fontPx).sort((p, q) => p - q);
        const fontPx = sizes.length ? sizes[sizes.length >> 1] : 12;
        for (const c of cells) c.fontPx = fontPx;
      }
      // Text wider than its column runs on into the empty cells to its right, as it did on paper.
      for (const c of cells) {
        c.span = 1;
        if (!c.text || c.align !== "left") continue;
        const need = Math.max(...c.text.split("\n").map(textEm)) * c.fontPx * 1.08 + 0.5 * c.fontPx;
        while (c.x0 + need > xs[c.c + c.span] && c.c + c.span < xs.length - 1) {
          const next = cells.find((q) => q.r === c.r && q.c === c.c + c.span);
          if (!next || next.text) break;
          next.covered = true;
          c.span++;
        }
        c.x1 = xs[c.c + c.span];
      }
      tables.push({ ...b.geo, cells, rows: b.rows.length, cols: xs.length - 1 });
      bottom = Math.max(bottom, ys[ys.length - 1]);
      continue;
    }
    const geo = b.geo;
    if (!geo?.lines?.length) {
      // No position known (added or restored without layout): continue below what came before.
      const lines = blockLines(b).filter((l) => l.trim());
      const lh = 0.018 * page.height;
      lines.forEach((t, i) => texts.push({ text: t, x0: 0.05 * page.width, x1: 0.95 * page.width, y0: bottom + i * lh * 1.3, y1: bottom + i * lh * 1.3 + lh, lineH: lh, align: "left", uncertain: !!b.uncertain }));
      bottom += lines.length * lh * 1.3;
      continue;
    }
    const style = (l) => ({ bold: !!l.style?.bold || b.type === "heading", color: l.style?.color, struck: !!l.struck, uncertain: !!l.uncertain });
    if (contentSig(b) === geo.sig) {
      // As scanned: every piece exactly where it was.
      // lineH: the text's own height (a tilted line's bounding box is taller than its letters).
      for (const l of geo.lines) texts.push({ text: l.text, x0: l.box[0], y0: l.box[1], x1: l.box[2], y1: l.box[3], lineH: l.h || l.box[3] - l.box[1], align: "left", ...style(l) });
    } else {
      // Edited: the new lines take the old lines' places (or share the block's area).
      const now = blockLines(b).filter((l) => l.trim());
      const rows = [];
      for (const l of [...geo.lines].sort((p, q) => p.box[1] - q.box[1])) {
        const row = rows.find((r) => Math.abs((r.box[1] + r.box[3]) / 2 - (l.box[1] + l.box[3]) / 2) < 0.5 * (l.box[3] - l.box[1]));
        if (row) row.box = [Math.min(row.box[0], l.box[0]), Math.min(row.box[1], l.box[1]), Math.max(row.box[2], l.box[2]), Math.max(row.box[3], l.box[3])];
        else rows.push({ box: [...l.box], l });
      }
      if (now.length === rows.length) {
        now.forEach((t, i) => texts.push({ text: t, x0: rows[i].box[0], y0: rows[i].box[1], x1: rows[i].box[2], y1: rows[i].box[3], lineH: rows[i].l.h || rows[i].box[3] - rows[i].box[1], align: "left", ...style(rows[i].l) }));
      } else {
        const all = [Math.min(...rows.map((r) => r.box[0])), Math.min(...rows.map((r) => r.box[1])), Math.max(...rows.map((r) => r.box[2])), Math.max(...rows.map((r) => r.box[3]))];
        texts.push(...stack(now.join("\n"), all, { align: "left", ...style(rows[0].l) }));
      }
    }
    for (const l of geo.lines) bottom = Math.max(bottom, l.box[3]);
  }
  // Free text: size from each line's own box, then lines of nearly the same size share one size
  // (a page is printed in a few sizes, not one per line).
  for (const t of texts) t.fontPx = fontFor(t.text, t.x1 - t.x0, t.lineH);
  const sized = [...texts, ...tables.filter((tb) => !tb.h).flatMap((tb) => tb.cells.filter((c) => c.fontPx))];
  const sorted = sized.map((t) => t.fontPx).sort((p, q) => p - q);
  const groups = [];
  for (const v of sorted) {
    const g = groups[groups.length - 1];
    if (g && v <= g[0] * 1.3) g.push(v); else groups.push([v]);
  }
  for (const t of sized) {
    const g = groups.find((gr) => t.fontPx >= gr[0] && t.fontPx <= gr[gr.length - 1]);
    if (g) t.fontPx = g[g.length >> 1];
  }
  // Readable on its fill: dark shading gets white text.
  for (const tb of tables) for (const c of tb.cells) if (c.fill && luminance(c.fill) < 120 && (!c.color || c.color === "000000")) c.color = "FFFFFF";
  return { w: page.width, h: page.height, tables, texts };
}

const luminance = (hex) => 0.299 * parseInt(hex.slice(0, 2), 16) + 0.587 * parseInt(hex.slice(2, 4), 16) + 0.114 * parseInt(hex.slice(4, 6), 16);

/** Width of text in em for a plain sans-serif font (Arial / Roboto metrics, approximately). */
export function textEm(text) {
  let w = 0;
  for (const ch of String(text)) {
    if (/[A-Z]/.test(ch)) w += /[MW]/.test(ch) ? 0.85 : /[IJ]/.test(ch) ? 0.3 : 0.67;
    else if (/[a-z]/.test(ch)) w += /[mw]/.test(ch) ? 0.8 : /[ijlft]/.test(ch) ? 0.25 : 0.52;
    else if (/\d/.test(ch)) w += 0.556;
    else if (ch === " ") w += 0.278;
    else w += 0.33;
  }
  return w;
}

/** Font size (page pixels) for text that filled a box `w` wide on a line `lineH` tall. */
export function fontFor(text, w, lineH) {
  const byHeight = FONT_OF_BOX * lineH;
  const em = textEm(text);
  return em > 0 && w > 0 ? Math.min(byHeight, (w * 0.97) / em) : byHeight;
}

/** Flat drawing list: filled rectangles, ruled lines and text boxes (tables included). */
export function drawList(model) {
  const fills = [], rules = [], texts = [...model.texts];
  for (const t of model.tables) {
    const { xs, ys } = t;
    for (const c of t.cells) {
      if (c.fill) fills.push({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, fill: c.fill });
      if (c.text) texts.push(...stack(c.text, [c.x0 + (c.indent || 0), c.y0, c.x1, c.y1], {
        align: c.align, bold: c.bold, color: c.color, struck: c.struck, uncertain: c.uncertain, fontPx: c.fontPx, inCell: true,
      }));
    }
    const y0 = ys[0], y1 = ys[ys.length - 1], x0 = xs[0], x1 = xs[xs.length - 1];
    xs.forEach((x, i) => { if (t.v[i]) rules.push({ x0: x, y0, x1: x, y1 }); });
    if (t.h) ys.forEach((y) => rules.push({ x0, y0: y, x1, y1: y }));
  }
  return { w: model.w, h: model.h, fills, rules, texts };
}

// Detected text boxes are padded around the letters: the font's size is about this share of a
// text line's box height.
export const FONT_OF_BOX = 0.72;
