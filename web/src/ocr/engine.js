// Page recognition pipeline. Runs identically in a browser Web Worker, the Android WebView and Node.
//
// fast : flatten page -> detect -> recognise
// high : + deskew from text-line angles, upside-down correction, and a second opinion on every
//          doubtful line from a contrast-enhanced copy (the more confident reading wins)
// max  : + zoomed tile detection so tiny text and lone marks are found, and extra re-reads of
//          doubtful lines at a different scale

import { buildLayout, ruledGrid } from "./layout.js";
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
      if (!touchesEdge && !out.some((e) => iou(e, moved) > 0.3)) out.push(moved);
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
    found.push([[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]]);
  }
  if (!found.length) return [];
  const mats = found.map((pts) => cropBox(cv, rgb, pts).mat);
  const res = (await ocr.recognize(cv, mats)).map(fixNumericTokens);
  mats.forEach((m) => m.delete());
  return found
    .map((pts, i) => ({ ...res[i], pts, vertical: false }))
    .filter((l) => l.text.trim())
    .map((l) => ({ ...l, chars: l.chars.map((ch) => ({ ...ch, p: Math.min(ch.p, 0.84) })) })); // always flag for review
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

  if (precision !== "fast" && boxes.length) {
    // Page turned sideways: most boxes taller than wide.
    const tall = boxes.filter((b) => { const d = boxDims(b.pts); return d.h > 1.5 * d.w; }).length;
    if (tall > boxes.length * 0.6 && boxes.length >= 3) {
      const r = rotate90(cv, rgb, 1);
      rgb.delete(); rgb = r;
      boxes = await ocr.detect(cv, rgb, detOpts);
      steps.push("rotated 90°");
    }
    // Deskew. Ruled lines (tables, forms) are the most reliable reference; otherwise use the
    // dominant angle of long text lines, but only when they agree, since handwritten words wobble.
    const ruled = ruledLineAngle(cv, rgb);
    const angles = boxes.filter((b) => { const d = boxDims(b.pts); return d.w > 3 * d.h; }).map((b) => lineAngle(b.pts));
    const med = median(angles);
    const spread = median(angles.map((a) => Math.abs(a - med)));
    const angle = ruled ?? (angles.length >= 3 && spread < 1.5 ? med : 0);
    if (Math.abs(angle) > 0.8 && Math.abs(angle) < 30) {
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
  let mats = crops.map((c) => c.mat);
  if (precision !== "fast" && mats.length) {
    // Only trust the orientation classifier when most of the page agrees (single-line flags are
    // usually false alarms on short handwritten words).
    const flips = await ocr.upsideDown(cv, mats);
    if (flips.filter(Boolean).length > mats.length * 0.6 && mats.length >= 3) {
      mats = mats.map((m) => { const r = rotate90(cv, m, 2); m.delete(); return r; });
      steps.push("page was upside down: corrected");
    }
  }
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
        // Prefer the reading whose weakest character is more certain; tie-break on mean score.
        if (cand.text && (cand.minProb > cur.minProb + 0.02 || (Math.abs(cand.minProb - cur.minProb) <= 0.02 && cand.score > cur.score + 0.02))) {
          if (cand.text !== cur.text) improved++;
          results[v.i] = cand;
        }
        v.mat.delete();
      });
      if (improved) steps.push(`${improved} doubtful reading${improved > 1 ? "s" : ""} improved by re-reading`);
    }
  }
  mats.forEach((m) => m.delete());
  results = results.map(fixNumericTokens);

  onStep("layout");
  let lines = boxes.map((b, i) => ({ ...results[i], pts: b.pts, vertical: crops[i].vertical })).filter((l) => l.text.trim() && l.score > 0.35); // weak readings stay, flagged uncertain
  const gray = new cv.Mat();
  cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
  const grid = ruledGrid(cv, gray);
  if (grid) {
    // Table cells the detector left empty but that contain ink (a lone "1", a dot, a tick):
    // read the ink directly so no mark in a table is lost.
    const extra = await readInkInEmptyCells(cv, ocr, rgb, gray, grid, lines);
    if (extra.length) {
      lines = lines.concat(extra);
      steps.push(`${extra.length} small mark${extra.length > 1 ? "s" : ""} read from table cells`);
    }
  }
  const blocks = buildLayout(cv, gray, lines, grid);
  gray.delete();

  const preview = toImageData(cv, enhanced, 1400);
  enhanced.delete(); enhancedRgb.delete(); rgb.delete();
  return { blocks, steps, preview, ms: Date.now() - t0, lines: lines.length };
}
