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
  return {
    text: line.text, score: line.score, x0, x1, y0, y1, h: Math.max(4, h), cy: (y0 + y1) / 2, cx: (x0 + x1) / 2, chars,
    conf: line.minProb ?? 1, struck: !!line.struck, marker: !!line.marker, tick: !!line.tick,
  };
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

/**
 * Group items into visual rows by their vertical centres. Each item joins the nearest row whose
 * centre is within half a line height; rows never grow, so tightly written lines (handwritten
 * lists are often packed closer than one line height) stay separate.
 */
function groupRows(items) {
  const bodyH = median(items.map((i) => i.y1 - i.y0)) || 20;
  const rows = [];
  for (const it of [...items].sort((a, b) => a.cy - b.cy)) {
    const itH = it.y1 - it.y0;
    let best = null, bestD = Infinity;
    for (const r of rows) {
      const d = Math.abs(r.cy - it.cy);
      if (d < bestD) { bestD = d; best = r; }
    }
    // Section markers (②) sit on their own line: they only join a row they clearly share.
    const markerInvolved = it.marker || (best && best.items.some((o) => o.marker));
    const lim = markerInvolved ? 0.3 * bodyH : Math.max(0.3 * bodyH, 0.5 * Math.min(itH, best ? best.hMed : itH));
    if (best && bestD <= lim && !best.items.some((o) => Math.min(o.x1, it.x1) - Math.max(o.x0, it.x0) > 0.5 * Math.min(o.x1 - o.x0, it.x1 - it.x0))) {
      best.items.push(it);
      best.cy = best.items.reduce((s, o) => s + o.cy, 0) / best.items.length;
      best.hMed = median(best.items.map((o) => o.y1 - o.y0));
    } else {
      rows.push({ items: [it], cy: it.cy, hMed: itH });
    }
  }
  for (const r of rows) {
    r.items.sort((a, b) => a.x0 - b.x0);
    r.y0 = Math.min(...r.items.map((i) => i.y0));
    r.y1 = Math.max(...r.items.map((i) => i.y1));
    r.h = median(r.items.map((i) => i.h));
    r.segments = segments(r);
  }
  return rows.sort((a, b) => a.cy - b.cy);
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
      last.struck = last.struck && p.struck;
    } else {
      out.push({ text: p.text, x0: p.x0, x1: p.x1, chars: [...p.chars], uncertain: isUncertain(p.chars), scores: [p.score], struck: p.struck });
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

// Single glyphs that PP-OCR returns for a handwritten tick mark.
const TICK_GLYPHS = /^[VvLl√✓✔レﾚJjUu/\\]$/;
const TICK_TRAIL = /[√✓✔]$/;

/**
 * A page divided by hand-drawn vertical rules (ledger / stock sheet): the rules define the
 * columns for every row, whatever each row contains. Also finds a tick-mark column, puts circled
 * section markers at the start of their row, and marks struck-through cells.
 * `rules`: [{xAt(y), y0, y1}] ; `tickInk(x0, y0, x1, y1)` -> ink blob or null (pen marks only).
 */
/** Column rules that have text on both sides somewhere along their length (not page edges). */
export function mainRules(items, rules) {
  const bodyH = median(items.map((i) => i.y1 - i.y0)) || 20;
  return rules.filter((r) => {
    const near = items.filter((it) => it.cy >= r.y0 - bodyH && it.cy <= r.y1 + bodyH);
    const left = near.filter((it) => it.x1 < r.xAt(it.cy) + 0.2 * bodyH).length;
    const right = near.filter((it) => it.x0 > r.xAt(it.cy) - 0.2 * bodyH).length;
    return left >= 2 && right >= 2;
  });
}

/** Visual rows of a set of items: [{cy, h, items}] top to bottom. */
export function rowBands(items) {
  return groupRows(items).map((r) => ({ cy: r.cy, h: r.hMed, items: r.items }));
}

function ruledColumnsTable(items, rules, tickInk) {
  const bodyH = median(items.map((i) => i.y1 - i.y0)) || 20;
  const main = mainRules(items, rules);
  if (!main.length) return null;
  const top = Math.min(...main.map((r) => r.y0)) - bodyH, bottom = Math.max(...main.map((r) => r.y1)) + bodyH;
  const inside = items.filter((it) => it.cy >= top && it.cy <= bottom);
  if (inside.length < 4) return null;
  const colOf = (it) => main.filter((r) => r.xAt(it.cy) < it.cx).length;

  // --- tick column: where do single tick-like glyphs sit?
  const tickLike = inside.filter((it) => !it.marker && (it.tick || TICK_GLYPHS.test(it.text.trim())) && it.x1 - it.x0 < 1.6 * bodyH);
  let tick = null;
  if (tickLike.length >= 3) {
    const xs = tickLike.map((t) => t.cx);
    const mx = median(xs);
    const close = tickLike.filter((t) => Math.abs(t.cx - mx) < 1.3 * bodyH);
    if (close.length >= 3) {
      // What a tick looks like on this page: size of the recognised ticks' ink.
      const shapes = tickInk ? close.map((t) => tickInk(t.x0, t.y0, t.x1, t.y1)).filter(Boolean) : [];
      tick = {
        x: mx, col: colOf(close[0]),
        w: shapes.length ? median(shapes.map((b) => b.w)) : 0.6 * bodyH,
        h: shapes.length ? median(shapes.map((b) => b.h)) : 0.6 * bodyH,
        area: shapes.length ? median(shapes.map((b) => b.area)) : 0,
      };
    }
  }
  // Fewer than 3 ticks recognised (they are often merged into the text, "TC500368-083 L"):
  // find tick-shaped pen marks between each entry's text and the first column line instead.
  const lastTextX = (it) => {
    const cs = it.chars.filter((ch) => ch.c.trim());
    let k = cs.length - 1;
    while (k > 0 && TICK_GLYPHS.test(cs[k].c) && cs[k].px - cs[k - 1].px > 0.45 * bodyH) k--;
    return cs.length ? cs[k].px + 0.35 * bodyH : it.x1;
  };
  if (!tick && tickInk) {
    const found = [];
    for (const it of inside) {
      if (it.marker || colOf(it) !== 0 || it.text.trim().length < 3) continue;
      const x0 = lastTextX(it) + 2, x1 = main[0].xAt(it.cy) - 3;
      if (x1 - x0 < 0.5 * bodyH) continue;
      const b = tickInk(x0, it.cy - 0.45 * bodyH, x1, it.cy + 0.45 * bodyH);
      if (b && b.h > 0.28 * bodyH && b.h < 1.25 * bodyH && b.w > 0.28 * bodyH && b.w < 2.5 * bodyH) found.push({ x: b.x + b.w / 2, b });
    }
    if (found.length >= 3) {
      const mx = median(found.map((f) => f.x));
      const close = found.filter((f) => Math.abs(f.x - mx) < 1.3 * bodyH);
      if (close.length >= 3) {
        tick = { x: mx, col: 0, w: median(close.map((f) => f.b.w)), h: median(close.map((f) => f.b.h)), area: median(close.map((f) => f.b.area)) };
      }
    }
  }
  const markers = inside.filter((it) => it.marker);

  const rowsRaw = groupRows(inside);
  const nCols = main.length + 1;
  const table = [];
  for (const row of rowsRaw) {
    const cells = Array.from({ length: nCols }, () => ({ parts: [], uncertain: false }));
    let hasTick = false, tickUnc = false, marker = null;
    for (const it of row.items) {
      if (it.marker) { marker = it; continue; }
      let text = it.text.trim(), item = it;
      if (tick) {
        const inBand = Math.abs(it.cx - tick.x) < 1.3 * bodyH && it.x1 - it.x0 < 1.6 * bodyH && text.length <= 2
          && colOf(it) === tick.col; // a mark across a column line is that column's value, not a tick
        if (inBand && (it.tick || TICK_GLYPHS.test(text) || text.length === 1)) {
          hasTick = true;
          tickUnc = tickUnc || !(it.tick || TICK_GLYPHS.test(text));
          continue;
        }
        // "TC500259)√", "TC500368-083 L": a tick written right after the text, recognised as
        // part of it. Split it off when that last glyph sits in the tick column.
        const cs = it.chars;
        const last = cs[cs.length - 1];
        const gap = cs.length > 1 ? last.px - cs[cs.length - 2].px : 0;
        const trailingTick = text.length > 3 && last
          && (TICK_TRAIL.test(text) || (TICK_GLYPHS.test(last.c) && (gap > 0.45 * bodyH || cs[cs.length - 2].c === " ")))
          && Math.abs(last.px - tick.x) < 1.0 * bodyH;
        if (trailingTick) {
          hasTick = true;
          const keep = cs.slice(0, -1);
          text = keep.map((ch) => ch.c).join("").trim();
          item = { ...it, chars: keep, text };
        }
      }
      cells[colOf(it)].parts.push({ ...item, text });
    }
    const nearMarker = markers.some((m) => Math.abs(m.cy - row.cy) < 0.35 * bodyH);
    // An entry row has text in the first column; the first row only counts if it has a digit
    // (otherwise it is the header, e.g. "PART-NO").
    const isEntry = row.items.some((it) => colOf(it) === 0 && !it.marker && it.text.trim().length >= 3
      && (row !== rowsRaw[0] || /\d/.test(it.text)));
    if (tick && isEntry && !hasTick && !marker && !nearMarker && tickInk) {
      // No tick recognised: look for a pen mark in the tick band of this row.
      const occupied = row.items.filter((it) => it.x1 > tick.x - 1.2 * bodyH && it.x0 < tick.x + 1.2 * bodyH);
      // Text running into the band ends at its last character, not at its (padded) box edge.
      const endOf = (o) => (o.chars.length ? o.chars[o.chars.length - 1].px + 0.35 * bodyH : o.x1) + 2;
      const bx0 = Math.max(tick.x - 1.1 * bodyH, ...occupied.filter((o) => o.cx < tick.x).map(endOf));
      const ruleRight = tick.col < main.length ? main[tick.col].xAt(row.cy) - 3 : Infinity;
      const bx1 = Math.min(tick.x + 1.1 * bodyH, ruleRight, ...occupied.filter((o) => o.cx >= tick.x).map((o) => o.x0 - 2));
      const blob = bx1 - bx0 > 0.5 * bodyH ? tickInk(bx0, row.cy - 0.45 * bodyH, bx1, row.cy + 0.45 * bodyH) : null;
      // Accept a pen mark shaped like the page's other ticks and centred on this row.
      // Tick sizes vary on one page (small ✓ early on, big "L" later), and ticks often run on into
      // a stroke towards the quantity ("✓——16"): judge by pen-mark size relative to the text
      // height, and ink comparable to the recognised ticks.
      const likeTick = blob && blob.h > 0.28 * bodyH && blob.h < 1.25 * bodyH && blob.w > 0.28 * bodyH
        && (!tick.area || blob.area > 0.35 * tick.area)
        && blob.area / (blob.w * blob.h) > 0.06
        && Math.abs(blob.y + blob.h / 2 - row.cy) < 0.4 * bodyH;
      if (likeTick) hasTick = true; // shaped like this page's other ticks: no need to flag
    }
    const out = cells.map((c) => {
      const lines = c.parts.length ? groupRowsFlat(c.parts) : [];
      return {
        text: lines.join(" ").trim(),
        uncertain: c.parts.some((p) => isUncertain(p.chars)),
        struck: c.parts.length > 0 && c.parts.every((p) => p.struck),
        conf: c.parts.length ? Math.min(...c.parts.map((p) => p.conf)) : 1,
      };
    });
    if (marker) {
      const m = { text: marker.text, uncertain: isUncertain(marker.chars), struck: false, conf: marker.conf };
      out[0] = out[0].text ? { ...out[0], text: `${m.text} ${out[0].text}`, uncertain: out[0].uncertain || m.uncertain, struck: false } : m;
    }
    // A struck-out entry (its first column) strikes out the whole row, quantities included.
    if (out[0].struck) for (const c of out) if (c.text) c.struck = true;
    if (tick) out.splice(tick.col + 1, 0, { text: hasTick ? "✓" : "", uncertain: hasTick && tickUnc, struck: false, conf: 1 });
    table.push(out);
  }
  repairSectionSequence(table);
  // Drop columns that are empty on every row; detect a text-only header row.
  const keep = table[0].map((_, c) => table.some((r) => r[c].text));
  const rows = table.map((r) => r.filter((_, c) => keep[c])).filter((r) => r.some((c) => c.text));
  if (!rows.length) return null;
  const first = rows[0];
  const header = first.every((c) => !/\d/.test(c.text)) && first.some((c) => /[A-Za-z]{2}/.test(c.text));
  if (header && tick) {
    // Name the tick column in the header row (it has no heading on paper).
    const tickIdx = table[0].slice(0, tick.col + 2).filter((_, c) => keep[c]).length - 1;
    if (first[tickIdx] && !first[tickIdx].text) first[tickIdx] = { ...first[tickIdx], text: "✓" };
  }
  return {
    used: new Set(inside),
    y: top,
    block: {
      type: "table", rows, header_rows: header ? 1 : 0,
      uncertain: rows.some((r) => r.some((c) => c.uncertain)),
      confidence: round2(Math.min(...inside.map((i) => i.score))),
    },
  };
}

const CIRCLED_RE = /^([\u2460-\u2473])/;
const circledValue = (ch) => ch.charCodeAt(0) - 0x245f;

/**
 * Circled section numbers normally count up (②③④⑤⑥). If all but one fit a +1 run, the odd one
 * is a misread: replace it with the value the run implies and flag it.
 */
function repairSectionSequence(table) {
  const marks = table.map((r) => r[0]).filter((c) => CIRCLED_RE.test(c.text));
  if (marks.length < 3) return;
  const vals = marks.map((c) => circledValue(c.text[0]));
  // Best offset: value = index + start, chosen by majority.
  const counts = new Map();
  vals.forEach((v, i) => counts.set(v - i, (counts.get(v - i) || 0) + 1));
  const [start, votes] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (votes < marks.length - 1 || votes === marks.length) return;
  marks.forEach((c, i) => {
    const want = start + i;
    if (vals[i] !== want && want >= 1 && want <= 20) {
      c.text = String.fromCharCode(0x245f + want) + c.text.slice(1);
      c.uncertain = true;
    }
  });
}

/** Text of several items that share one cell, in reading order. */
function groupRowsFlat(parts) {
  return groupRows(parts).map((r) => r.items.map((i) => i.text).join(" "));
}

// Pairs of characters that handwriting recognisers confuse.
const CONFUSABLE = new Set(["4Y", "4H", "4A", "4U", "1I", "1l", "17", "0O", "0D", "0Q", "5S", "2Z", "8B", "6G", "6b", "9g", "EF", "UV", "MN", "CG", "PR"]
  .flatMap((p) => [p, p[1] + p[0]]));

/**
 * Lists repeat the same codes (part numbers, SKUs). When two cells differ only by commonly
 * confused characters, the clearly more confident reading wins and the corrected cell is flagged;
 * if neither is clearly better, both are flagged for review.
 */
export function harmonizeCodes(blocks) {
  const cells = [];
  for (const b of blocks) if (b.type === "table") for (const r of b.rows) for (const c of r) {
    if (/^[A-Za-z0-9().-]{6,}$/.test(c.text)) cells.push(c);
  }
  for (const a of cells) {
    for (const b of cells) {
      if (a === b || a.text === b.text || a.text.length !== b.text.length) continue;
      if (!/\d/.test(a.text + b.text)) continue; // codes, not ordinary words
      const diffs = [...a.text].map((ch, i) => [ch, b.text[i]]).filter(([x, y]) => x !== y);
      if (!diffs.length || diffs.length > 2 || diffs.length > a.text.length / 4) continue;
      if (!diffs.every(([x, y]) => CONFUSABLE.has(x + y))) continue;
      const ca = a.conf ?? 1, cb = b.conf ?? 1;
      if (cb > ca + 0.05) {
        a.text = b.text;
        a.uncertain = true;
      } else if (Math.abs(ca - cb) <= 0.05) {
        a.uncertain = true;
        b.uncertain = true;
      }
    }
  }
  return blocks;
}

/**
 * lines: [{pts, text, score, chars:[{c,p,x}], vertical}] in `gray` coordinates.
 * Returns an array of blocks in reading order.
 */
export function buildLayout(cv, gray, lines, grid = gray ? ruledGrid(cv, gray) : null, { rules = [], tickInk = null } = {}) {
  let items = lines.filter((l) => l.text.trim()).map(toItem);
  const blocks = [];

  if (!grid && rules.length) {
    const t = ruledColumnsTable(items, rules, tickInk);
    if (t) {
      blocks.push({ y: t.y, block: t.block });
      items = items.filter((it) => !t.used.has(it));
    }
  }

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
  return harmonizeCodes(blocks.sort((a, b) => a.y - b.y).map((b) => b.block));
}
