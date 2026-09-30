// Page recognition pipeline. Runs identically in a browser Web Worker, the Android WebView and Node.
//
// fast : flatten page -> detect -> recognise
// high : + deskew from text-line angles, upside-down correction, and a second opinion on every
//          doubtful line from a contrast-enhanced copy (the more confident reading wins)
// max  : + zoomed tile detection so tiny text and lone marks are found, and extra re-reads of
//          doubtful lines at a different scale

import { buildLayout, mainRules, rowBands, ruledGrid, splitLinesAtGrid, toItem } from "./layout.js";
import { circled, circles, inkBlob, inkMask, isStruck, lineFreeMask, verticalRules } from "./marks.js";
import { cropBox, fixNumericTokens } from "./ppocr.js";
import { enhance, prepare, rotate, rotate90, toImageData } from "./preprocess.js";

const REREAD_BELOW = 0.93; // re-read lines whose weakest character is below this probability
// Detection resolution per mode (long side, px). Detection cost grows with pixels; text boxes are
// already stable at 1280-1600 for a phone photo of a full page, and "max" adds zoomed tiles.
const DET_SIDE = { fast: 1280, high: 1600, max: 2048 };

function lineAngle(pts) {
  return (Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]) * 180) / Math.PI;
}

/** Angle of long horizontal ruled lines (table borders, form lines), or null if there are none. */
function ruledLineAngle(cv, rgb) {
  const gray = new cv.Mat(), bin = new cv.Mat(), lines = new cv.Mat();
  const contours = new cv.MatVector(), hier = new cv.Mat();
  try {
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    cv.adaptiveThreshold(gray, bin, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 25, 15);
    // A short-ish horizontal kernel keeps slightly tilted rules intact.
    const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(30, Math.floor(rgb.cols / 40)), 1));
    cv.morphologyEx(bin, lines, cv.MORPH_OPEN, k);
    k.delete();
    const k3 = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.dilate(lines, lines, k3);
    k3.delete();
    cv.findContours(lines, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const angles = [];
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const r = cv.minAreaRect(c);
      c.delete();
      let { width: w, height: h } = r.size, a = r.angle;
      if (w < h) { [w, h] = [h, w]; a += 90; }
      a = ((a + 90) % 180 + 180) % 180 - 90;
      if (w > rgb.cols / 4 && h < 12 && Math.abs(a) < 20) angles.push(a);
    }
    return angles.length >= 2 ? median(angles) : null;
  } finally {
    gray.delete(); bin.delete(); lines.delete(); contours.delete(); hier.delete();
  }
}

function boxDims(pts) {
  return {
    w: Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]),
    h: Math.hypot(pts[3][0] - pts[0][0], pts[3][1] - pts[0][1]),
  };
}

const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0);

function iou(a, b) {
  const box = (p) => [Math.min(...p.map((q) => q[0])), Math.min(...p.map((q) => q[1])), Math.max(...p.map((q) => q[0])), Math.max(...p.map((q) => q[1]))];
  const [ax0, ay0, ax1, ay1] = box(a.pts), [bx0, by0, bx1, by1] = box(b.pts);
  const iw = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0)), ih = Math.max(0, Math.min(ay1, by1) - Math.max(ay0, by0));
  const inter = iw * ih;
  const small = Math.min((ax1 - ax0) * (ay1 - ay0), (bx1 - bx0) * (by1 - by0));
  return small > 0 ? inter / small : 0;
}

/** Detect on overlapping zoomed tiles and add boxes the full-page pass missed. */
async function tileDetect(cv, ocr, rgb, existing) {
  const out = [...existing];
  const grid = 2, overlap = 0.15;
  const th = rgb.rows / grid, tw = rgb.cols / grid;
  for (let r = 0; r < grid; r++) for (let c = 0; c < grid; c++) {
    const y0 = Math.max(0, Math.floor(r * th - th * overlap)), y1 = Math.min(rgb.rows, Math.ceil((r + 1) * th + th * overlap));
    const x0 = Math.max(0, Math.floor(c * tw - tw * overlap)), x1 = Math.min(rgb.cols, Math.ceil((c + 1) * tw + tw * overlap));
    const tile = rgb.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0));
    const boxes = await ocr.detect(cv, tile, { limitSide: 960 });
    tile.delete();
    for (const b of boxes) {
      const moved = { ...b, pts: b.pts.map(([x, y]) => [x + x0, y + y0]) };
      // Keep only boxes not already covered, and not cut by the tile border.
      const touchesEdge = moved.pts.some(([x, y]) => (x0 > 0 && x < x0 + 3) || (y0 > 0 && y < y0 + 3) || (x1 < rgb.cols && x > x1 - 3) || (y1 < rgb.rows && y > y1 - 3));
      // Only fill gaps: a tile box whose centre lies inside (or next to) an existing box is a
      // fragment of text already found, and would duplicate characters ("16" -> "116").
      const [mx, my] = [moved.pts.reduce((s, p) => s + p[0], 0) / 4, moved.pts.reduce((s, p) => s + p[1], 0) / 4];
      const nearExisting = out.some((e) => {
        const xs = e.pts.map((p) => p[0]), ys = e.pts.map((p) => p[1]);
        const pad = 0.3 * (Math.max(...ys) - Math.min(...ys));
        return mx > Math.min(...xs) - pad && mx < Math.max(...xs) + pad && my > Math.min(...ys) - pad && my < Math.max(...ys) + pad;
      });
      if (!touchesEdge && !nearExisting && !out.some((e) => iou(e, moved) > 0.3)) out.push(moved);
    }
  }
  return out;
}

async function readInkInEmptyCells(cv, ocr, rgb, gray, grid, lines) {
  const { ys, xs } = grid;
  const centres = lines.map((l) => [
    (Math.min(...l.pts.map((p) => p[0])) + Math.max(...l.pts.map((p) => p[0]))) / 2,
    (Math.min(...l.pts.map((p) => p[1])) + Math.max(...l.pts.map((p) => p[1]))) / 2,
  ]);
  const found = [];
  for (let r = 0; r < ys.length - 1; r++) for (let c = 0; c < xs.length - 1; c++) {
    const [x0, x1, y0, y1] = [xs[c], xs[c + 1], ys[r], ys[r + 1]];
    if (centres.some(([cx, cy]) => cx >= x0 && cx < x1 && cy >= y0 && cy < y1)) continue;
    // Inset past the ruling so the cell border itself never counts as ink.
    const inX = Math.max(6, (x1 - x0) * 0.06), inY = Math.max(6, (y1 - y0) * 0.1);
    const rx = Math.round(x0 + inX), ry = Math.round(y0 + inY);
    const rw = Math.round(x1 - x0 - 2 * inX), rh = Math.round(y1 - y0 - 2 * inY);
    if (rw < 8 || rh < 8) continue;
    const roi = gray.roi(new cv.Rect(rx, ry, rw, rh));
    const bin = new cv.Mat();
    cv.threshold(roi, bin, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
    const mean = cv.mean(roi)[0];
    roi.delete();
    const ink = cv.countNonZero(bin);
    // Otsu on a blank cell splits paper noise; require real contrast and a meaningful blob.
    const bb = ink ? cv.boundingRect(bin) : null; // on an 8-bit mask: box around the non-zero pixels
    bin.delete();
    if (!bb || ink < 12 || ink > rw * rh * 0.5 || mean < 60) continue;
    const pad = Math.max(8, bb.height * 0.4);
    const bx0 = Math.max(0, rx + bb.x - pad), by0 = Math.max(0, ry + bb.y - pad);
    const bx1 = Math.min(rgb.cols - 1, rx + bb.x + bb.width + pad), by1 = Math.min(rgb.rows - 1, ry + bb.y + bb.height + pad);
    found.push({ pts: [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]], numericCol: false });
  }
  if (!found.length) return [];
  const mats = found.map((f) => cropBox(cv, rgb, f.pts).mat);
  const res = (await ocr.recognize(cv, mats)).map(fixNumericTokens);
  mats.forEach((m) => m.delete());
  return found
    .map((f, i) => {
      // In a column of numbers, a lone stroke is a digit ("l" / "|" -> "1") when the digit reading
      // is plausible at all.
      const r = res[i];
      if (f.numericCol && r.chars.length && r.chars.length <= 3 && !/^\d+$/.test(r.text)
        && r.chars.every((ch) => /\d/.test(ch.c) || ch.altP > 0.01)) {
        const chars = r.chars.map((ch) => (/\d/.test(ch.c) ? ch : { ...ch, c: ch.alt, p: Math.min(ch.p, 0.6) }));
        return { ...r, chars, text: chars.map((ch) => ch.c).join(""), score: Math.max(r.score, 0.5), pts: f.pts, vertical: false };
      }
      return { ...r, pts: f.pts, vertical: false };
    })
    .filter((l) => l.text.trim())
    .map((l) => ({ ...l, chars: l.chars.map((ch) => ({ ...ch, p: Math.min(ch.p, 0.84) })) })); // always flag for review
}

const OTHER_SCRIPT = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/;
const LATIN = /[A-Za-z0-9]/;

/**
 * On a page written in Latin script, a stray low-confidence CJK character is noise (a smudge or
 * scribble), not text: remove it. Pages that really are in those scripts are left alone.
 */
function dropStrayScript(results) {
  let latin = 0, other = 0;
  for (const r of results) for (const ch of r.chars) {
    if (LATIN.test(ch.c)) latin++;
    else if (OTHER_SCRIPT.test(ch.c)) other++;
  }
  if (latin < 20 || other > 0.05 * latin) return results;
  return results.map((r) => {
    if (!r.chars.some((ch) => OTHER_SCRIPT.test(ch.c) && ch.p < 0.95)) return r;
    const chars = r.chars.filter((ch) => !(OTHER_SCRIPT.test(ch.c) && ch.p < 0.95));
    return { ...r, chars, text: chars.map((ch) => ch.c).join("").trim(), minProb: chars.length ? Math.min(...chars.map((c) => c.p)) : 0 };
  });
}

/**
 * Circled section numbers (②). Candidates come from the page-wide detector, plus a local check
 * around low-confidence one-character readings (a circle touching a neighbouring tick or line
 * is missed page-wide). The number inside is read with the ring masked out.
 */
async function readCircledNumbers(cv, ocr, rgb, gray, clean, bodyH, allLines) {
  const boxOf = (l) => {
    const xs = l.pts.map((p) => p[0]), ys = l.pts.map((p) => p[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  };
  const words = allLines.filter((l) => l.text.trim().length >= 2 && l.score > 0.6).map(boxOf);
  const insideWord = (c) => words.some((w) => c.cx > w.x0 && c.cx < w.x1 && c.cy > w.y0 && c.cy < w.y1);
  const margin = 0.02 * Math.max(gray.cols, gray.rows);
  const found = circles(cv, clean, bodyH).filter((c) => !insideWord(c)
    && c.cx > margin && c.cy > margin && c.cx < gray.cols - margin && c.cy < gray.rows - margin);
  for (const l of allLines) {
    if (l.text.trim().length > 1 && l.score > 0.5) continue;
    const b = boxOf(l);
    if (found.some((c) => Math.abs(c.cx - (b.x0 + b.x1) / 2) < c.rx && Math.abs(c.cy - (b.y0 + b.y1) / 2) < c.ry)) continue;
    const pad = 0.5 * bodyH;
    const x0 = Math.max(0, Math.round(b.x0 - pad)), y0 = Math.max(0, Math.round(b.y0 - pad));
    const x1 = Math.min(gray.cols, Math.round(b.x1 + pad)), y1 = Math.min(gray.rows, Math.round(b.y1 + pad));
    const roi = clean.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0)).clone();
    // Cut the ROI border so ink leaving the box (a neighbouring tick) cannot join the ring.
    cv.rectangle(roi, new cv.Point(0, 0), new cv.Point(roi.cols - 1, roi.rows - 1), new cv.Scalar(0), 3);
    for (const c of circles(cv, roi, bodyH)) found.push({ ...c, cx: c.cx + x0, cy: c.cy + y0 });
    roi.delete();
  }
  // The recogniser knows circled digits too (①…⑳): trust that reading even when it is weak.
  const native = [];
  for (const l of allLines) {
    const t = l.text.trim();
    if (!/^[\u2460-\u2473]$/.test(t)) continue;
    const b = boxOf(l);
    const c = { cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, rx: (b.x1 - b.x0) / 2, ry: (b.y1 - b.y0) / 2 };
    if (found.some((f) => Math.abs(f.cx - c.cx) < f.rx && Math.abs(f.cy - c.cy) < f.ry)) continue;
    const p = Math.min(l.minProb, 0.84);
    native.push({ ...c, line: { text: t, score: Math.max(0.5, l.score), minProb: p, marker: true, vertical: false, chars: [{ c: t, p, x: 0.5 }], pts: l.pts } });
  }
  if (!found.length) return native;
  const crops = found.map((c) => {
    // Inner part of the ellipse, ring painted white, padded so the digit sits like a text line.
    const rx = c.rx * 0.78, ry = c.ry * 0.8;
    const x0 = Math.max(0, Math.round(c.cx - rx)), y0 = Math.max(0, Math.round(c.cy - ry));
    const w = Math.min(rgb.cols - x0, Math.round(2 * rx)), h = Math.min(rgb.rows - y0, Math.round(2 * ry));
    const inner = rgb.roi(new cv.Rect(x0, y0, w, h)).clone();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (((x - w / 2) / (w / 2)) ** 2 + ((y - h / 2) / (h / 2)) ** 2 > 0.85) inner.ucharPtr(y, x).set([255, 255, 255]);
    }
    const padded = new cv.Mat();
    const p = Math.round(h * 0.25);
    cv.copyMakeBorder(inner, padded, p, p, p * 2, p * 2, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
    inner.delete();
    return padded;
  });
  const reads = await ocr.recognize(cv, crops);
  crops.forEach((m) => m.delete());
  const all = native.concat(found.map((c, i) => {
    // The content is a number: at each position take the digit reading, even when a letter
    // scored higher (a written 4 often looks like "Y" or "H").
    const digits = reads[i].chars.map((ch) => (/\d/.test(ch.c) ? ch.c : ch.altP > 0.02 ? ch.alt : "")).join("");
    const ok = /^\d{1,2}$/.test(digits);
    const text = ok ? circled(Number(digits)) : "◯";
    const p = ok ? Math.min(reads[i].minProb, ...reads[i].chars.map((ch) => (/\d/.test(ch.c) ? ch.p : ch.altP))) : 0.3;
    return {
      cx: c.cx, cy: c.cy, rx: c.rx, ry: c.ry,
      line: {
        text, score: Math.max(0.5, reads[i].score), minProb: p, marker: true, vertical: false,
        chars: [{ c: text, p, x: 0.5 }],
        pts: [[c.cx - c.rx, c.cy - c.ry], [c.cx + c.rx, c.cy - c.ry], [c.cx + c.rx, c.cy + c.ry], [c.cx - c.rx, c.cy + c.ry]],
      },
    };
  }));
  // A section marker stands on its own line: drop unreadable circles, and any marker that shares
  // its row with a live (not crossed-out) entry, which is a scribble or a letter loop.
  const entries = allLines.filter((l) => l.text.trim().length >= 3 && l.score > 0.6 && !l.struck).map(boxOf);
  return all.filter((m) => m.line.text !== "◯"
    && !entries.some((e) => Math.abs((e.y0 + e.y1) / 2 - m.cy) < 0.5 * bodyH));
}

/**
 * On pages divided by hand-drawn column lines: a cell between two lines that the text detector
 * left empty but that holds ink (a quantity written as one thin stroke, "1") is read directly.
 * Results are always flagged for review.
 */
/** Do most filled cells of column c (between main rules c-1 and c) hold numbers? */
function numericColumn(items, main, c, band) {
  const inCol = items.filter((it) => {
    const left = main[c - 1].xAt(it.cy), right = c < main.length ? main[c].xAt(it.cy) : Infinity;
    return it.cx > left && it.cx < right;
  });
  const numeric = inCol.filter((it) => /^[\d.,+\-/ ]+$/.test(it.text.trim())).length;
  return inCol.length >= 2 && numeric >= 0.6 * inCol.length;
}

async function readInkInRuledCells(cv, ocr, rgb, clean, rules, lines, bodyH) {
  const items = lines.filter((l) => !l.marker).map(toItem);
  const main = mainRules(items, rules);
  if (!main.length) return [];
  const top = Math.min(...main.map((r) => r.y0)), bottom = Math.max(...main.map((r) => r.y1));
  const found = [];
  for (const band of rowBands(items)) {
    if (band.cy < top || band.cy > bottom) continue;
    // Only rows that are real entries (something left of the first column line).
    if (!band.items.some((it) => it.cx < main[0].xAt(it.cy) && it.text.trim().length >= 3)) continue;
    for (let c = 1; c <= main.length; c++) {
      const left = main[c - 1].xAt(band.cy);
      const right = c < main.length ? main[c].xAt(band.cy)
        : Math.min(...rules.map((r) => r.xAt(band.cy)).filter((x) => x > left + bodyH), left + 6 * bodyH);
      if (band.items.some((it) => it.cx > left && it.cx < right)) continue;
      const blob = inkBlob(cv, clean, left + 0.25 * bodyH, band.cy - 0.45 * band.h, right - 0.25 * bodyH, band.cy + 0.45 * band.h);
      // Must be a mark of this row: tall enough, and centred on the row (not the tail of the
      // number above or below spilling into the band).
      if (!blob || blob.h < 0.35 * bodyH || Math.abs(blob.y + blob.h / 2 - band.cy) > 0.3 * bodyH) continue;
      // Leftover bits of curved ruling are wide, flat and sparse; handwriting is not.
      if (blob.w > 2.5 * blob.h && blob.h < 0.6 * bodyH) continue;
      // Crop around the mark but never beyond this row, so the row above/below can't leak in.
      const pad = 0.35 * bodyH;
      const x0 = Math.max(0, blob.x - pad), x1 = Math.min(rgb.cols - 1, blob.x + blob.w + pad);
      const y0 = Math.max(0, blob.y - pad, band.cy - 0.6 * band.h);
      const y1 = Math.min(rgb.rows - 1, blob.y + blob.h + pad, band.cy + 0.6 * band.h);
      found.push({ pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], numericCol: numericColumn(items, main, c, band) });
    }
  }
  if (!found.length) return [];
  const mats = found.map((f) => cropBox(cv, rgb, f.pts).mat);
  const res = (await ocr.recognize(cv, mats)).map(fixNumericTokens);
  mats.forEach((m) => m.delete());
  return found
    .map((f, i) => {
      // In a column of numbers, a lone stroke is a digit ("l" / "|" -> "1") when the digit reading
      // is plausible at all.
      const r = res[i];
      if (f.numericCol && r.chars.length && r.chars.length <= 3 && !/^\d+$/.test(r.text)
        && r.chars.every((ch) => /\d/.test(ch.c) || ch.altP > 0.01)) {
        const chars = r.chars.map((ch) => (/\d/.test(ch.c) ? ch : { ...ch, c: ch.alt, p: Math.min(ch.p, 0.6) }));
        return { ...r, chars, text: chars.map((ch) => ch.c).join(""), score: Math.max(r.score, 0.5), pts: f.pts, vertical: false };
      }
      return { ...r, pts: f.pts, vertical: false };
    })
    .filter((l) => l.text.trim() && l.score > 0.3)
    .map((l) => ({ ...l, chars: l.chars.map((ch) => ({ ...ch, p: Math.min(ch.p, 0.84) })) }));
}

export async function recognizePage(env, imageData, { precision = "high", flatten = true, onStep = () => {} } = {}) {
  const { cv, ocr } = env;
  const t0 = Date.now();
  onStep("prepare");
  const prepared = prepare(cv, imageData, { flatten });
  const steps = [...prepared.steps];
  let rgb = prepared.rgb;

  onStep("detect");
  // boxThresh 0.4 (PaddleOCR uses 0.5): slanted cursive often scores 0.4-0.6; weak false boxes are
  // dropped later by recognition confidence.
  const detOpts = { maxSide: DET_SIDE[precision] || DET_SIDE.high, boxThresh: 0.4 };
  let boxes = await ocr.detect(cv, rgb, detOpts);

  if (boxes.length) {
    // Page orientation, settled on the page itself (not per line) so that rows and columns come
    // out in reading order. 1) Sideways: most text boxes taller than wide.
    const tall = boxes.filter((b) => { const d = boxDims(b.pts); return d.h > 1.5 * d.w; }).length;
    if (tall > boxes.length * 0.6 && boxes.length >= 3) {
      const r = rotate90(cv, rgb, 1);
      rgb.delete(); rgb = r;
      boxes = await ocr.detect(cv, rgb, detOpts);
      steps.push("rotated 90°");
    }
    // 2) Upside down: ask the orientation classifier about the longest lines; if most of them
    //    are upside down, turn the whole page by 180° and detect again.
    const sample = [...boxes].sort((a, b) => boxDims(b.pts).w - boxDims(a.pts).w).slice(0, 24)
      .filter((b) => { const d = boxDims(b.pts); return d.w > 2 * d.h; });
    if (sample.length >= 3) {
      const mats = sample.map((b) => cropBox(cv, rgb, b.pts).mat);
      const flips = await ocr.upsideDown(cv, mats);
      mats.forEach((m) => m.delete());
      if (flips.filter(Boolean).length > 0.6 * sample.length) {
        const r = rotate90(cv, rgb, 2);
        rgb.delete(); rgb = r;
        boxes = await ocr.detect(cv, rgb, detOpts);
        steps.push("page was upside down: turned 180°");
      }
    }
    // 3) Deskew. Ruled lines (tables, forms) are the most reliable reference; otherwise use the
    //    dominant angle of long text lines, but only when they agree (handwritten words wobble).
    const ruled = ruledLineAngle(cv, rgb);
    const angles = boxes.filter((b) => { const d = boxDims(b.pts); return d.w > 3 * d.h; }).map((b) => lineAngle(b.pts));
    const med = median(angles);
    const spread = median(angles.map((a) => Math.abs(a - med)));
    const angle = ruled ?? (angles.length >= 3 && spread < 1.5 ? med : 0);
    if (Math.abs(angle) > 0.5 && Math.abs(angle) < 30) {
      const r = rotate(cv, rgb, angle);
      rgb.delete(); rgb = r;
      boxes = await ocr.detect(cv, rgb, detOpts);
      steps.push(`deskewed ${angle > 0 ? "+" : ""}${angle.toFixed(1)}°`);
    }
  }

  // Contrast-enhanced copy: second opinion for faint/noisy pages and the preview image.
  const enhanced = enhance(cv, rgb, prepared.noise);
  if (prepared.noise > 2.5) steps.push(`denoised (noise ${prepared.noise.toFixed(0)})`);
  steps.push("shadows removed, faint ink boosted");
  const enhancedRgb = new cv.Mat();
  cv.cvtColor(enhanced, enhancedRgb, cv.COLOR_GRAY2RGB);

  // Second detection pass on the enhanced copy when the page looks hard: noisy, sparse or low-confidence.
  const weak = boxes.length < 5 || median(boxes.map((b) => b.score)) < 0.75 || prepared.noise > 2.5;
  if (precision === "max" || (precision === "high" && weak)) {
    const alt = await ocr.detect(cv, enhancedRgb, { ...detOpts, thresh: 0.25, boxThresh: 0.45 });
    const added = alt.filter((b) => !boxes.some((e) => iou(e, b) > 0.3));
    if (added.length) {
      boxes = boxes.concat(added);
      steps.push(`+${added.length} lines found on enhanced copy`);
    }
  }
  if (precision === "max") {
    onStep("tiles");
    const before = boxes.length;
    boxes = await tileDetect(cv, ocr, rgb, boxes);
    if (boxes.length > before) steps.push(`+${boxes.length - before} small items found in zoomed tiles`);
  }

  onStep("recognize");
  const crops = boxes.map((b) => cropBox(cv, rgb, b.pts));
  const mats = crops.map((c) => c.mat);
  let results = await ocr.recognize(cv, mats);

  if (precision !== "fast") {
    onStep("reread");
    const doubtful = results.map((r, i) => (r.minProb < REREAD_BELOW ? i : -1)).filter((i) => i >= 0);
    if (doubtful.length) {
      const variants = [];
      for (const i of doubtful) {
        variants.push({ i, mat: cropBox(cv, enhancedRgb, boxes[i].pts).mat });
        if (precision === "max") {
          // Slightly larger crop: gives the recogniser context for clipped ascenders and dots.
          const d = boxDims(boxes[i].pts);
          const pad = d.h * 0.12;
          const [p0, p1, p2, p3] = boxes[i].pts;
          const grown = [[p0[0] - pad, p0[1] - pad], [p1[0] + pad, p1[1] - pad], [p2[0] + pad, p2[1] + pad], [p3[0] - pad, p3[1] + pad]]
            .map(([x, y]) => [Math.min(rgb.cols - 1, Math.max(0, x)), Math.min(rgb.rows - 1, Math.max(0, y))]);
          variants.push({ i, mat: cropBox(cv, rgb, grown).mat });
        }
      }
      const alt = await ocr.recognize(cv, variants.map((v) => v.mat));
      let improved = 0;
      variants.forEach((v, k) => {
        const cur = results[v.i], cand = alt[k];
        v.mat.delete();
        if (!cand.text) return;
        if (cand.text === cur.text) {
          // Same reading from a second copy: keep the more confident character scores.
          if (cand.minProb > cur.minProb) results[v.i] = cand;
          return;
        }
        // Readings disagree. The more certain one wins (weakest character first, then mean score),
        // but a re-read that gains or loses characters has usually taken in a neighbour's ink (a
        // tick's tail: "16" -> "116") and never wins. Either way the disagreement is flagged.
        const better = cand.minProb > cur.minProb + 0.02 || (Math.abs(cand.minProb - cur.minProb) <= 0.02 && cand.score > cur.score + 0.02);
        const pick = better && cand.text.length === cur.text.length ? cand : cur;
        if (pick === cand) improved++;
        results[v.i] = { ...pick, chars: pick.chars.map((ch) => ({ ...ch, p: Math.min(ch.p, 0.84) })), minProb: Math.min(pick.minProb, 0.84) };
      });
      if (improved) steps.push(`${improved} doubtful reading${improved > 1 ? "s" : ""} improved by re-reading`);
    }
  }
  mats.forEach((m) => m.delete());
  results = results.map(fixNumericTokens);
  results = dropStrayScript(results);

  onStep("layout");
  const allLines = boxes.map((b, i) => ({ ...results[i], pts: b.pts, vertical: crops[i].vertical }));
  let lines = allLines.filter((l) => l.text.trim() && l.score > 0.35); // weak readings stay, flagged uncertain
  const gray = new cv.Mat();
  cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
  const bin = inkMask(cv, gray);
  let grid = ruledGrid(cv, gray);
  if (grid) {
    // A printed table has text in most of its rows. Ruled notebook paper under a hand-drawn
    // ledger also forms a grid, but one whose rows are mostly empty: use the column lines instead.
    const cys = lines.map((l) => { const ys = l.pts.map((p) => p[1]); return (Math.min(...ys) + Math.max(...ys)) / 2; });
    const filled = grid.ys.slice(1).filter((y, i) => cys.some((c) => c >= grid.ys[i] && c < y)).length;
    if (filled < 0.7 * (grid.ys.length - 1)) grid = null;
  }
  if (grid) {
    lines = splitLinesAtGrid(grid, lines);
    // Table cells the detector left empty but that contain ink (a lone "1", a dot, a tick):
    // read the ink directly so no mark in a table is lost.
    const extra = await readInkInEmptyCells(cv, ocr, rgb, gray, grid, lines);
    if (extra.length) {
      lines = lines.concat(extra);
      steps.push(`${extra.length} small mark${extra.length > 1 ? "s" : ""} read from table cells`);
    }
  }

  // Pen marks without ruling / column lines (used by the checks below).
  const bodyH = median(lines.map((l) => boxDims(l.pts).h)) || 40;
  const clean = lineFreeMask(cv, bin, bodyH);

  // Scribbled-out marks (a solid, filled blob of ink next to the real value) are not text. A digit,
  // even a crossed-out one, is made of strokes and never fills most of its own outline.
  const scribble = (l) => {
    if (l.text.trim().length > 2 || l.score > 0.8) return false;
    const xs = l.pts.map((p) => p[0]), ys = l.pts.map((p) => p[1]);
    const x0 = Math.max(0, Math.round(Math.min(...xs))), y0 = Math.max(0, Math.round(Math.min(...ys)));
    const w = Math.min(clean.cols - x0, Math.round(Math.max(...xs) - x0)), h = Math.min(clean.rows - y0, Math.round(Math.max(...ys) - y0));
    if (w < 4 || h < 4) return false;
    const roi = clean.roi(new cv.Rect(x0, y0, w, h));
    const labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat();
    const n = cv.connectedComponentsWithStats(roi, labels, stats, cents, 8, cv.CV_32S);
    let solid = false;
    for (let i = 1; i < n; i++) {
      const bw = stats.intAt(i, cv.CC_STAT_WIDTH), bh = stats.intAt(i, cv.CC_STAT_HEIGHT), a = stats.intAt(i, cv.CC_STAT_AREA);
      if (bw > 0.4 * bodyH && bh > 0.3 * bodyH && a > 0.5 * bw * bh) solid = true;
    }
    roi.delete(); labels.delete(); stats.delete(); cents.delete();
    return solid;
  };
  const before = lines.length;
  lines = lines.filter((l) => !scribble(l));
  if (lines.length < before) steps.push(`${before - lines.length} scribbled-out mark${before - lines.length > 1 ? "s" : ""} ignored`);

  // Hand-drawn structure: struck-out entries, column rules, circled section numbers.
  let struck = 0;
  for (const l of allLines) {
    const xs = l.pts.map((p) => p[0]), ys = l.pts.map((p) => p[1]);
    if (isStruck(cv, bin, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys))) {
      l.struck = true;
      if (lines.includes(l)) struck++;
    }
  }
  if (struck) steps.push(`${struck} struck-out entr${struck > 1 ? "ies" : "y"} marked`);
  const rules = grid ? [] : verticalRules(cv, gray, bin);
  const markers = await readCircledNumbers(cv, ocr, rgb, gray, clean, bodyH, allLines);
  if (markers.length) {
    const covered = (l) => markers.some((m) => {
      const xs = l.pts.map((p) => p[0]), ys = l.pts.map((p) => p[1]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      return Math.abs(cx - m.cx) < m.rx && Math.abs(cy - m.cy) < m.ry && l.text.trim().length <= 3;
    });
    lines = lines.filter((l) => !covered(l)).concat(markers.map((m) => m.line));
    steps.push(`${markers.length} circled number${markers.length > 1 ? "s" : ""} found`);
  }
  if (rules.length) {
    const extra = await readInkInRuledCells(cv, ocr, rgb, clean, rules, lines, bodyH);
    if (extra.length) {
      lines = lines.concat(extra);
      steps.push(`${extra.length} small mark${extra.length > 1 ? "s" : ""} read between column lines`);
    }
  }
  if (rules.length) steps.push(`${rules.length} hand-drawn column line${rules.length > 1 ? "s" : ""} found`);
  const tickInk = (x0, y0, x1, y1) => inkBlob(cv, clean, x0, y0, x1, y1);
  const blocks = buildLayout(cv, gray, lines, grid, { rules, tickInk });
  clean.delete();
  bin.delete();
  gray.delete();

  const preview = toImageData(cv, enhanced, 1400);
  enhanced.delete(); enhancedRgb.delete(); rgb.delete();
  return { blocks, steps, preview, ms: Date.now() - t0, lines: lines.length };
}
