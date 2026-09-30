// Turn recognised text lines into document structure: ruled tables, borderless tables,
// form fields, lists, headings and paragraphs. Output matches the ExtractedDocument JSON
// used everywhere else in OmniScan (see app/schema.py).

export const UNCERTAIN_PROB = 0.85; // any character below this probability flags the reading

const KV_RE = /^\s*([^:=]{1,40}?)\s*[:=]\s*(.*)$/;
const BULLET_RE = /^\s*(?:[-•*·‣▪–]|\(?\d{1,3}[.)]|[a-zA-Z][.)])\s+/;
const ORDERED_RE = /^\s*\(?\d{1,3}[.)]\s+/;
const CHECK_RE = /^\s*(\[\s?[xX✓✔]?\s?\]|[☐☑☒□■])\s*/;

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[s.length >> 1];
};

/** Normalise a recognised line into an axis-aligned item with character positions. */
export function toItem(line) {
  const xs = line.pts.map((p) => p[0]), ys = line.pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const h = Math.hypot(line.pts[3][0] - line.pts[0][0], line.pts[3][1] - line.pts[0][1]);
  const chars = line.vertical ? [] : line.chars.map((c) => ({ ...c, px: x0 + c.x * (x1 - x0) }));
  return { text: line.text, score: line.score, x0, x1, y0, y1, h: Math.max(4, h), cy: (y0 + y1) / 2, chars };
}

const isUncertain = (chars) => chars.some((c) => c.p < UNCERTAIN_PROB);

/** Split one item where the gap between neighbouring characters is column-sized. */
function splitItem(it) {
  if (it.chars.length < 2) return [it];
  const parts = [];
  let cur = [it.chars[0]];
  for (let i = 1; i < it.chars.length; i++) {
    const a = it.chars[i - 1], b = it.chars[i];
    const bigGap = b.px - a.px > 2.2 * it.h && a.c !== " " && b.c !== " ";
    if (bigGap) { parts.push(cur); cur = []; }
    cur.push(b);
  }
  parts.push(cur);
  if (parts.length === 1) return [it];
  return parts.map((cs) => {
    const text = cs.map((c) => c.c).join("").trim();
    const half = it.h * 0.4;
    return { ...it, text, chars: cs, x0: Math.max(it.x0, cs[0].px - half), x1: Math.min(it.x1, cs[cs.length - 1].px + half) };
  }).filter((p) => p.text);
}

/** Group items into visual rows by vertical overlap. */
function groupRows(items) {
  const rows = [];
  for (const it of [...items].sort((a, b) => a.cy - b.cy)) {
    const row = rows.find((r) => {
      const overlap = Math.min(r.y1, it.y1) - Math.max(r.y0, it.y0);
      return overlap > 0.5 * Math.min(it.y1 - it.y0, r.h);
    });
    if (row) {
      row.items.push(it);
      row.y0 = Math.min(row.y0, it.y0);
      row.y1 = Math.max(row.y1, it.y1);
    } else {
      rows.push({ items: [it], y0: it.y0, y1: it.y1, h: it.y1 - it.y0 });
    }
  }
  for (const r of rows) {
    r.items.sort((a, b) => a.x0 - b.x0);
    r.h = median(r.items.map((i) => i.h));
    r.segments = segments(r);
  }
  return rows.sort((a, b) => a.y0 - b.y0);
}

/** Segments = column-separated pieces of a row. Nearby items (same phrase) are merged. */
function segments(row) {
  const pieces = row.items.flatMap(splitItem).sort((a, b) => a.x0 - b.x0);
  const out = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (last && p.x0 - last.x1 < 0.5 * row.h) {
      last.text = `${last.text} ${p.text}`;
      last.x1 = Math.max(last.x1, p.x1);
      last.chars = [...last.chars, ...p.chars];
      last.uncertain = last.uncertain || isUncertain(p.chars);
      last.scores.push(p.score);
    } else {
      out.push({ text: p.text, x0: p.x0, x1: p.x1, chars: [...p.chars], uncertain: isUncertain(p.chars), scores: [p.score] });
    }
  }
  return out;
}

const rowText = (r) => r.segments.map((s) => s.text).join(" ");
const rowUncertain = (r) => r.segments.some((s) => s.uncertain);
const rowConf = (r) => Math.min(...r.segments.flatMap((s) => s.scores));

/** Column boundaries from the union of segment spans across rows. */
function columnize(rows) {
  const spans = rows.flatMap((r) => r.segments.map((s) => [s.x0, s.x1])).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of spans) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const cuts = merged.slice(1).map((m, i) => (merged[i][1] + m[0]) / 2);
  return rows.map((r) => {
    const cells = Array.from({ length: cuts.length + 1 }, () => ({ text: "", uncertain: false }));
    for (const s of r.segments) {
      const cx = (s.x0 + s.x1) / 2;
      let idx = cuts.findIndex((c) => cx < c);
      if (idx === -1) idx = cuts.length;
      const cell = cells[idx];
      cell.text = cell.text ? `${cell.text} ${s.text}` : s.text;
      cell.uncertain = cell.uncertain || s.uncertain;
    }
    return cells;
  });
}

/** Detect a table drawn with ruled lines. Returns {ys, xs, bbox} or null. */
export function ruledGrid(cv, gray) {
  const bin = new cv.Mat(), horiz = new cv.Mat(), vert = new cv.Mat(), both = new cv.Mat();
  const contours = new cv.MatVector(), hier = new cv.Mat();
  const h = gray.rows, w = gray.cols;
  try {
    cv.adaptiveThreshold(gray, bin, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV,
      Math.max(15, (Math.floor(Math.min(h, w) / 60)) | 1), 15);
    const hk = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(40, Math.floor(w / 25)), 1));
    const vk = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, Math.max(40, Math.floor(h / 25))));
    cv.morphologyEx(bin, horiz, cv.MORPH_OPEN, hk);
    cv.morphologyEx(bin, vert, cv.MORPH_OPEN, vk);
    hk.delete(); vk.delete();
    cv.bitwise_or(horiz, vert, both);
    const k5 = cv.Mat.ones(5, 5, cv.CV_8U);
    cv.dilate(both, both, k5);
    k5.delete();
    cv.findContours(both, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let best = null, bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const a = cv.contourArea(c);
      if (a > bestArea) { bestArea = a; best = cv.boundingRect(c); }
      c.delete();
    }
    if (!best) return null;
    const positions = (mask, alongRows, minLen) => {
      const out = [];
      const n = alongRows ? best.height : best.width;
      let run = null;
      for (let i = 0; i < n; i++) {
        let count = 0;
        if (alongRows) {
          const y = best.y + i;
          for (let x = best.x; x < best.x + best.width; x++) if (mask.ucharAt(y, x)) count++;
        } else {
          const x = best.x + i;
          for (let y = best.y; y < best.y + best.height; y++) if (mask.ucharAt(y, x)) count++;
        }
        if (count > minLen) {
          if (run && i - run[run.length - 1] <= 4) run.push(i);
          else { if (run) out.push(run); run = [i]; }
        }
      }
      if (run) out.push(run);
      const base = alongRows ? best.y : best.x;
      return out.map((r) => base + r.reduce((s, v) => s + v, 0) / r.length);
    };
    const ys = positions(horiz, true, best.width / 2);
    const xs = positions(vert, false, best.height / 2);
    if (ys.length < 3 || xs.length < 3) return null;
    return { ys, xs, bbox: best };
  } finally {
    bin.delete(); horiz.delete(); vert.delete(); both.delete(); contours.delete(); hier.delete();
  }
}

function gridTable(grid, items) {
  const { ys, xs } = grid;
  const rows = ys.slice(1).map(() => xs.slice(1).map(() => ({ text: "", uncertain: false, parts: [] })));
  const used = new Set();
  for (const it of items) {
    const cx = (it.x0 + it.x1) / 2;
    const r = ys.findIndex((y, i) => i < ys.length - 1 && it.cy >= y && it.cy < ys[i + 1]);
    const c = xs.findIndex((x, i) => i < xs.length - 1 && cx >= x && cx < xs[i + 1]);
    if (r < 0 || c < 0) continue;
    rows[r][c].parts.push(it);
    used.add(it);
  }
  for (const row of rows) for (const cell of row) {
    // Reading order inside a cell: top-to-bottom lines, left-to-right within a line.
    const lines = groupRows(cell.parts);
    cell.text = lines.map(rowText).join("\n");
    cell.uncertain = lines.some(rowUncertain);
    delete cell.parts;
  }
  const confs = [...used].map((i) => i.score);
  return {
    used,
    block: {
      type: "table",
      rows,
      header_rows: 1,
      uncertain: rows.some((r) => r.some((c) => c.uncertain)),
      confidence: confs.length ? round2(Math.min(...confs)) : null,
    },
  };
}

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * lines: [{pts, text, score, chars:[{c,p,x}], vertical}] in `gray` coordinates.
 * Returns an array of blocks in reading order.
 */
export function buildLayout(cv, gray, lines, grid = gray ? ruledGrid(cv, gray) : null) {
  let items = lines.filter((l) => l.text.trim()).map(toItem);
  const blocks = [];

  if (grid) {
    const inside = items.filter((it) => {
      const cx = (it.x0 + it.x1) / 2;
      return cx >= grid.xs[0] && cx <= grid.xs[grid.xs.length - 1] && it.cy >= grid.ys[0] && it.cy <= grid.ys[grid.ys.length - 1];
    });
    const { used, block } = gridTable(grid, inside);
    if (used.size) {
      blocks.push({ y: grid.ys[0], block });
      items = items.filter((it) => !used.has(it));
    }
  }

  const rows = groupRows(items);
  const bodyH = median(rows.map((r) => r.h)) || 20;
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];

    // Borderless table: >= 2 consecutive rows that each split into >= 2 columns.
    // Rows of "Label:  value" (form fields) and rows of data columns are kept apart.
    const kvRow = (r) => r.segments.length === 2 && /[:=]\s*$/.test(r.segments[0].text);
    let j = i;
    while (j < rows.length && rows[j].segments.length >= 2 && kvRow(rows[j]) === kvRow(row)
      && (j === i || rows[j].y0 - rows[j - 1].y1 < 3 * bodyH)) j++;
    if (j - i >= 2) {
      const chunk = rows.slice(i, j);
      const kvLike = kvRow(row);
      if (kvLike) {
        blocks.push({ y: row.y0, block: {
          type: "key_value",
          pairs: chunk.map((r) => ({ key: r.segments[0].text.replace(/\s*[:=]\s*$/, ""), value: r.segments[1].text, uncertain: rowUncertain(r) })),
          uncertain: chunk.some(rowUncertain),
        } });
      } else {
        const grid2 = columnize(chunk);
        blocks.push({ y: row.y0, block: {
          type: "table", rows: grid2, header_rows: 1,
          uncertain: chunk.some(rowUncertain), confidence: round2(Math.min(...chunk.map(rowConf))),
        } });
      }
      i = j;
      continue;
    }

    const text = rowText(row);
    if (CHECK_RE.test(text)) {
      const mark = text.match(CHECK_RE)[1];
      blocks.push({ y: row.y0, block: {
        type: "checkbox", text: text.replace(CHECK_RE, ""), checked: /[xX✓✔☑☒■]/.test(mark), uncertain: rowUncertain(row),
      } });
      i++;
      continue;
    }
    if (BULLET_RE.test(text)) {
      const items2 = [];
      const ordered = ORDERED_RE.test(text);
      let unc = false;
      while (i < rows.length && BULLET_RE.test(rowText(rows[i]))) {
        items2.push(rowText(rows[i]).replace(BULLET_RE, ""));
        unc = unc || rowUncertain(rows[i]);
        i++;
      }
      blocks.push({ y: row.y0, block: { type: "list", items: items2, ordered, uncertain: unc } });
      continue;
    }
    // Form fields: at least two consecutive "Label: value" rows. A lone colon inside running text
    // ("Budget approved: $12,450") stays part of the paragraph.
    const isKv = (r) => {
      const m = rowText(r).match(KV_RE);
      return m && m[1].trim() && !/\d$/.test(m[1]) && r.segments.length === 1 ? m : null;
    };
    if (isKv(row) && i + 1 < rows.length && isKv(rows[i + 1])) {
      const pairs = [];
      let m;
      while (i < rows.length && (m = isKv(rows[i]))) {
        pairs.push({ key: m[1].trim(), value: m[2].trim(), uncertain: rowUncertain(rows[i]) });
        i++;
      }
      blocks.push({ y: row.y0, block: { type: "key_value", pairs, uncertain: pairs.some((p) => p.uncertain) } });
      continue;
    }
    if (row.h > 1.35 * bodyH && text.length < 80) {
      blocks.push({ y: row.y0, block: {
        type: "heading", text, level: row.h > 1.8 * bodyH ? 1 : 2, uncertain: rowUncertain(row), confidence: round2(rowConf(row)),
      } });
      i++;
      continue;
    }
    // Paragraph: following single-column rows that sit close below and start near the same x.
    const para = [row];
    i++;
    while (i < rows.length) {
      const nxt = rows[i], prev = para[para.length - 1];
      const t = rowText(nxt);
      if (nxt.segments.length >= 2 || BULLET_RE.test(t) || CHECK_RE.test(t) || nxt.h > 1.35 * bodyH) break;
      if (isKv(nxt) && i + 1 < rows.length && isKv(rows[i + 1])) break;
      if (nxt.y0 - prev.y1 > 1.2 * bodyH || Math.abs(nxt.segments[0].x0 - row.segments[0].x0) > 4 * bodyH) break;
      para.push(nxt);
      i++;
    }
    blocks.push({ y: row.y0, block: {
      type: "paragraph", text: para.map(rowText).join("\n"),
      uncertain: para.some(rowUncertain), confidence: round2(Math.min(...para.map(rowConf))),
    } });
  }
  return blocks.sort((a, b) => a.y - b.y).map((b) => b.block);
}
