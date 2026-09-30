// PP-OCRv6 text detection (DB) + recognition (CTC) + 180° line classifier, on ONNX Runtime Web.
// Pre/post-processing mirrors PaddleOCR / RapidOCR so the models see exactly what they were
// trained on: BGR channel order, pixels scaled to [-1, 1], 48 px recognition height.

const REC_H = 48;
const REC_MIN_RATIO = 320 / 48;
const REC_BATCH = 6;
const CLS_SHAPE = [48, 192];

export class PPOCR {
  constructor(ort, sessions, dict) {
    this.ort = ort;
    this.det = sessions.det;
    this.rec = sessions.rec;
    this.cls = sessions.cls;
    this.chars = ["", ...dict, " "]; // CTC: index 0 is blank, trailing space appended
  }

  /** loadAsset(name) -> Promise<ArrayBuffer|Uint8Array>; names: det.onnx rec.onnx cls.onnx rec_dict.txt */
  static async create(ort, loadAsset, options = {}) {
    const opts = { executionProviders: ["wasm"], graphOptimizationLevel: "all", ...options };
    const [det, rec, cls, dictBuf] = await Promise.all([
      loadAsset("det.onnx").then((b) => ort.InferenceSession.create(b, opts)),
      loadAsset("rec.onnx").then((b) => ort.InferenceSession.create(b, opts)),
      loadAsset("cls.onnx").then((b) => ort.InferenceSession.create(b, opts)),
      loadAsset("rec_dict.txt"),
    ]);
    const dict = new TextDecoder().decode(dictBuf).split("\n");
    if (dict[dict.length - 1] === "") dict.pop();
    return new PPOCR(ort, { det, rec, cls }, dict);
  }

  // ---------------------------------------------------------------- detection

  /**
   * Returns text boxes [{pts:[[x,y]*4] (tl,tr,br,bl), score}] in `rgb` coordinates.
   * limitSide: the shorter side is scaled up to at least this (PP-OCRv6 default 736).
   */
  async detect(cv, rgb, { limitSide = 736, maxSide = 2400, thresh = 0.3, boxThresh = 0.5, unclip = 1.6 } = {}) {
    const h = rgb.rows, w = rgb.cols;
    let ratio = Math.min(h, w) < limitSide ? limitSide / Math.min(h, w) : 1;
    if (Math.max(h, w) * ratio > maxSide) ratio = maxSide / Math.max(h, w);
    const rh = Math.max(32, Math.round((h * ratio) / 32) * 32);
    const rw = Math.max(32, Math.round((w * ratio) / 32) * 32);
    const resized = new cv.Mat();
    cv.resize(rgb, resized, new cv.Size(rw, rh), 0, 0, cv.INTER_LINEAR);
    const input = toCHW(resized, rh, rw);
    resized.delete();

    const feeds = { [this.det.inputNames[0]]: new this.ort.Tensor("float32", input, [1, 3, rh, rw]) };
    const out = await this.det.run(feeds);
    const prob = out[this.det.outputNames[0]].data;

    const probMat = new cv.Mat(rh, rw, cv.CV_32F);
    probMat.data32F.set(prob);
    const bitmap = new cv.Mat(rh, rw, cv.CV_8U);
    const bits = bitmap.data;
    for (let i = 0; i < prob.length; i++) bits[i] = prob[i] > thresh ? 255 : 0;
    const k = cv.Mat.ones(2, 2, cv.CV_8U);
    cv.dilate(bitmap, bitmap, k);
    k.delete();

    const contours = new cv.MatVector(), hier = new cv.Mat();
    cv.findContours(bitmap, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const sx = w / rw, sy = h / rh;
    const boxes = [];
    for (let i = 0; i < Math.min(contours.size(), 1000); i++) {
      const c = contours.get(i);
      const rect = cv.minAreaRect(c);
      c.delete();
      if (Math.min(rect.size.width, rect.size.height) < 3) continue;
      const score = boxScore(cv, probMat, rectPoints(rect));
      if (score < boxThresh) continue;
      // Unclip: grow the box by area*ratio/perimeter on every side (DB post-processing).
      const { width: bw, height: bh } = rect.size;
      const d = (bw * bh * unclip) / (2 * (bw + bh));
      const grown = { center: rect.center, size: { width: bw + 2 * d, height: bh + 2 * d }, angle: rect.angle };
      if (Math.min(grown.size.width, grown.size.height) < 5) continue;
      const pts = orderPoints(rectPoints(grown)).map(([x, y]) => [
        clamp(x * sx, 0, w - 1),
        clamp(y * sy, 0, h - 1),
      ]);
      boxes.push({ pts, score });
    }
    contours.delete(); hier.delete(); bitmap.delete(); probMat.delete();
    return sortBoxes(boxes);
  }

  // ---------------------------------------------------------------- classification

  /** For each crop (RGB Mat), true when the text line is upside down. */
  async upsideDown(cv, crops) {
    const flags = [];
    const [H, W] = CLS_SHAPE;
    for (let b = 0; b < crops.length; b += REC_BATCH) {
      const batch = crops.slice(b, b + REC_BATCH);
      const data = new Float32Array(batch.length * 3 * H * W);
      batch.forEach((m, i) => data.set(resizeNormPad(cv, m, H, W), i * 3 * H * W));
      const out = await this.cls.run({ [this.cls.inputNames[0]]: new this.ort.Tensor("float32", data, [batch.length, 3, H, W]) });
      const p = out[this.cls.outputNames[0]].data;
      for (let i = 0; i < batch.length; i++) flags.push(p[i * 2 + 1] > p[i * 2] && p[i * 2 + 1] > 0.9);
    }
    return flags;
  }

  // ---------------------------------------------------------------- recognition

  /**
   * Recognise line crops. Returns per crop {text, score, minProb, chars:[{c, p, x}]} where
   * x is the character centre as a fraction (0..1) of the crop width.
   */
  async recognize(cv, crops) {
    const order = crops.map((m, i) => [m.cols / m.rows, i]).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
    const results = new Array(crops.length);
    for (let b = 0; b < order.length; b += REC_BATCH) {
      const idx = order.slice(b, b + REC_BATCH);
      let maxRatio = REC_MIN_RATIO;
      for (const i of idx) maxRatio = Math.max(maxRatio, crops[i].cols / crops[i].rows);
      const W = Math.ceil(REC_H * maxRatio);
      const data = new Float32Array(idx.length * 3 * REC_H * W);
      const widths = idx.map((i, n) => {
        const { tensor, resizedW } = resizeNormPadRec(cv, crops[i], W);
        data.set(tensor, n * 3 * REC_H * W);
        return resizedW;
      });
      const out = await this.rec.run({ [this.rec.inputNames[0]]: new this.ort.Tensor("float32", data, [idx.length, 3, REC_H, W]) });
      const t = out[this.rec.outputNames[0]];
      const [, T, C] = t.dims;
      for (let n = 0; n < idx.length; n++) {
        results[idx[n]] = ctcDecode(t.data, n, T, C, this.chars, W, widths[n]);
      }
    }
    return results;
  }
}

// ------------------------------------------------------------------ helpers

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** RGB HWC uint8 Mat -> BGR CHW float32 in [-1, 1]. */
function toCHW(mat, h, w) {
  const src = mat.data, plane = h * w;
  const out = new Float32Array(3 * plane);
  for (let i = 0, p = 0; p < plane; p++, i += 3) {
    out[p] = src[i + 2] / 127.5 - 1; // B
    out[plane + p] = src[i + 1] / 127.5 - 1; // G
    out[2 * plane + p] = src[i] / 127.5 - 1; // R
  }
  return out;
}

function resizeNormPad(cv, mat, H, W) {
  const ratio = mat.cols / mat.rows;
  const rw = Math.min(W, Math.ceil(H * ratio));
  const r = new cv.Mat();
  cv.resize(mat, r, new cv.Size(rw, H), 0, 0, cv.INTER_LINEAR);
  const chw = toCHW(r, H, rw);
  r.delete();
  const out = new Float32Array(3 * H * W); // zero == mid-grey after normalisation, as in PaddleOCR
  for (let c = 0; c < 3; c++) for (let y = 0; y < H; y++) out.set(chw.subarray(c * H * rw + y * rw, c * H * rw + (y + 1) * rw), c * H * W + y * W);
  return out;
}

function resizeNormPadRec(cv, mat, W) {
  const rw = Math.min(W, Math.ceil(REC_H * (mat.cols / mat.rows)));
  return { tensor: resizeNormPad(cv, mat, REC_H, W), resizedW: rw };
}

const digitIndexCache = new WeakMap();
function digitIndices(chars) {
  if (!digitIndexCache.has(chars)) digitIndexCache.set(chars, chars.map((c, i) => (/^\d$/.test(c) ? i : -1)).filter((i) => i >= 0));
  return digitIndexCache.get(chars);
}

function ctcDecode(data, n, T, C, chars, W, resizedW) {
  const base = n * T * C;
  const digits = digitIndices(chars);
  const out = [];
  let prev = -1, sum = 0;
  for (let t = 0; t < T; t++) {
    let best = 0, bestP = -1;
    const off = base + t * C;
    for (let c = 0; c < C; c++) {
      const v = data[off + c];
      if (v > bestP) { bestP = v; best = c; }
    }
    if (best !== 0 && best !== prev) {
      const x = (((t + 0.5) * W) / T) / resizedW;
      // Keep the most likely digit at this position so later passes can prefer it in numeric context.
      let dIdx = digits[0], dP = -1;
      for (const d of digits) if (data[off + d] > dP) { dP = data[off + d]; dIdx = d; }
      out.push({ c: chars[best] ?? "", p: bestP, x: Math.min(1, x), alt: chars[dIdx], altP: Math.max(0, dP) });
      sum += bestP;
    }
    prev = best;
  }
  const text = out.map((o) => o.c).join("");
  return {
    text,
    score: out.length ? sum / out.length : 0,
    minProb: out.length ? Math.min(...out.map((o) => o.p)) : 0,
    chars: out,
  };
}

const LOOKALIKE = /[sSoOlIZzBgqbGT|]/;
const NUMERIC_SEP = /[\d.,/:\-$€£¥₹#%+]/;

/**
 * Inside number-like tokens ("202s", "12,450.7s"), a letter whose runner-up is a digit is almost
 * always a misread digit (handwritten 5/s, 0/o, 1/l, 2/z, 8/B, 9/g). Swap it and flag it for review.
 * Words the model is sure about ("1990s" with a clear s) keep their letter: the digit must be a
 * real runner-up, not noise.
 */
export function fixNumericTokens(res) {
  const chars = res.chars;
  let i = 0, changed = false;
  while (i < chars.length) {
    if (chars[i].c === " ") { i++; continue; }
    let j = i;
    while (j < chars.length && chars[j].c !== " ") j++;
    const tok = chars.slice(i, j);
    const digits = tok.filter((c) => /\d/.test(c.c)).length;
    const odd = tok.filter((c) => !NUMERIC_SEP.test(c.c));
    const fixable = odd.every((c) => LOOKALIKE.test(c.c) && /\d/.test(c.alt) && c.altP >= 0.01);
    if (digits >= 2 && odd.length && odd.length <= Math.max(1, digits / 3) && fixable) {
      for (const c of odd) {
        c.c = c.alt;
        c.p = Math.min(c.p, 0.5); // flag: corrected reading, please verify
      }
      changed = true;
    }
    i = j;
  }
  if (changed) {
    res.text = chars.map((c) => c.c).join("");
    res.minProb = Math.min(...chars.map((c) => c.p));
  }
  return res;
}

function rectPoints(rect) {
  const t = (rect.angle * Math.PI) / 180;
  const b = Math.cos(t) * 0.5, a = Math.sin(t) * 0.5;
  const { x: cx, y: cy } = rect.center;
  const { width: w, height: h } = rect.size;
  const p0 = [cx - a * h - b * w, cy + b * h - a * w];
  const p1 = [cx + a * h - b * w, cy - b * h - a * w];
  return [p0, p1, [2 * cx - p0[0], 2 * cy - p0[1]], [2 * cx - p1[0], 2 * cy - p1[1]]];
}

/** Clockwise from top-left, like PaddleOCR's order_points_clockwise. */
export function orderPoints(pts) {
  const byX = [...pts].sort((a, b) => a[0] - b[0]);
  const left = byX.slice(0, 2).sort((a, b) => a[1] - b[1]);
  const right = byX.slice(2).sort((a, b) => a[1] - b[1]);
  return [left[0], right[0], right[1], left[1]];
}

/** Mean probability inside the (rotated) box: DB "fast" box score. */
function boxScore(cv, prob, pts) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = clamp(Math.floor(Math.min(...xs)), 0, prob.cols - 1), x1 = clamp(Math.ceil(Math.max(...xs)), 0, prob.cols - 1);
  const y0 = clamp(Math.floor(Math.min(...ys)), 0, prob.rows - 1), y1 = clamp(Math.ceil(Math.max(...ys)), 0, prob.rows - 1);
  const rect = new cv.Rect(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  const mask = cv.Mat.zeros(rect.height, rect.width, cv.CV_8U);
  const poly = cv.matFromArray(4, 1, cv.CV_32SC2, pts.flatMap(([x, y]) => [Math.round(x - x0), Math.round(y - y0)]));
  const polys = new cv.MatVector();
  polys.push_back(poly);
  cv.fillPoly(mask, polys, new cv.Scalar(1));
  const roi = prob.roi(rect);
  const m = cv.mean(roi, mask)[0];
  roi.delete(); mask.delete(); poly.delete(); polys.delete();
  return m;
}

/** Top-to-bottom, then left-to-right within ~10 px lines (PaddleOCR sorted_boxes). */
function sortBoxes(boxes) {
  boxes.sort((a, b) => a.pts[0][1] - b.pts[0][1] || a.pts[0][0] - b.pts[0][0]);
  for (let i = 0; i < boxes.length - 1; i++) {
    for (let j = i; j >= 0; j--) {
      const a = boxes[j], b = boxes[j + 1];
      if (Math.abs(b.pts[0][1] - a.pts[0][1]) < 10 && b.pts[0][0] < a.pts[0][0]) {
        boxes[j] = b;
        boxes[j + 1] = a;
      } else break;
    }
  }
  return boxes;
}

/** Perspective-crop a detected quad out of `src` (PaddleOCR get_rotate_crop_image). */
export function cropBox(cv, src, pts) {
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const w = Math.max(2, Math.round(Math.max(d(pts[0], pts[1]), d(pts[2], pts[3]))));
  const h = Math.max(2, Math.round(Math.max(d(pts[0], pts[3]), d(pts[1], pts[2]))));
  const s = cv.matFromArray(4, 1, cv.CV_32FC2, pts.flat());
  const t = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
  const m = cv.getPerspectiveTransform(s, t);
  const out = new cv.Mat();
  cv.warpPerspective(src, out, m, new cv.Size(w, h), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
  s.delete(); t.delete(); m.delete();
  if (h / w >= 1.5) {
    const r = new cv.Mat();
    cv.rotate(out, r, cv.ROTATE_90_COUNTERCLOCKWISE);
    out.delete();
    return { mat: r, vertical: true };
  }
  return { mat: out, vertical: false };
}
