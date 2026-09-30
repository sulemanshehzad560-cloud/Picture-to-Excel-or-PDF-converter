// Non-text marks that carry structure in handwritten sheets: hand-drawn column rules,
// circled section numbers, strike-throughs and tick marks. All work on a greyscale page Mat.

/** Black-on-white -> white-ink binary (ink = 255). Caller deletes. */
export function inkMask(cv, gray) {
  const bin = new cv.Mat();
  cv.adaptiveThreshold(gray, bin, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV,
    Math.max(15, Math.floor(Math.min(gray.rows, gray.cols) / 60) | 1), 15);
  return bin;
}

/**
 * Long, roughly vertical pen lines that split a page into columns (they may be tilted, slightly
 * curved or broken where they cross text). Returns [{xAt(y), y0, y1}] sorted left to right.
 */
export function verticalRules(cv, gray, bin = null) {
  const own = !bin;
  if (own) bin = inkMask(cv, gray);
  const H = gray.rows, W = gray.cols;
  const vert = new cv.Mat(), labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat();
  try {
    // Keep vertical strokes much taller than any handwritten letter...
    const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, Math.max(40, Math.floor(H / 28))));
    cv.morphologyEx(bin, vert, cv.MORPH_OPEN, k);
    k.delete();
    // ...then bridge small gaps and slight wobble so one pen line becomes one component.
    const bridge = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, Math.max(20, Math.floor(H / 45))));
    cv.dilate(vert, vert, bridge);
    bridge.delete();
    const n = cv.connectedComponentsWithStats(vert, labels, stats, cents, 8, cv.CV_32S);
    const rules = [];
    for (let i = 1; i < n; i++) {
      const x = stats.intAt(i, cv.CC_STAT_LEFT), y = stats.intAt(i, cv.CC_STAT_TOP);
      const w = stats.intAt(i, cv.CC_STAT_WIDTH), h = stats.intAt(i, cv.CC_STAT_HEIGHT);
      if (h < 0.3 * H || w > 0.12 * W) continue;
      // Least-squares x = a*y + b over the component's pixels (sampled per row: mean x).
      const ys = [], xs = [];
      for (let yy = y; yy < y + h; yy += 3) {
        let sum = 0, cnt = 0;
        for (let xx = x; xx < x + w; xx++) if (labels.intAt(yy, xx) === i) { sum += xx; cnt++; }
        if (cnt) { ys.push(yy); xs.push(sum / cnt); }
      }
      if (ys.length < 10) continue;
      const my = ys.reduce((s, v) => s + v, 0) / ys.length, mx = xs.reduce((s, v) => s + v, 0) / xs.length;
      let num = 0, den = 0;
      ys.forEach((yy, k2) => { num += (yy - my) * (xs[k2] - mx); den += (yy - my) ** 2; });
      const a = den ? num / den : 0, b = mx - a * my;
      const resid = ys.reduce((s, yy, k2) => s + Math.abs(xs[k2] - (a * yy + b)), 0) / ys.length;
      if (Math.abs(a) > 0.2 || resid > 12) continue; // not a straight-ish vertical line
      rules.push({ a, b, y0: y, y1: y + h, xAt: (yy) => a * yy + b });
    }
    return rules.sort((r, s) => r.xAt(H / 2) - s.xAt(H / 2));
  } finally {
    vert.delete(); labels.delete(); stats.delete(); cents.delete();
    if (own) bin.delete();
  }
}

/**
 * Ink mask with long straight-ish lines removed (notebook ruling, column rules, underlines), so
 * circles and small marks that touch those lines become separate shapes. Kernels ~3 text-heights
 * long follow gently curved photographed lines but keep letters and ring arcs. Caller deletes.
 */
export function lineFreeMask(cv, bin, bodyH) {
  const clean = bin.clone();
  const len = Math.max(40, Math.round(3 * bodyH));
  const thick = cv.Mat.ones(3, 3, cv.CV_8U);
  for (const size of [new cv.Size(len, 1), new cv.Size(1, len)]) {
    const lines = new cv.Mat();
    const lk = cv.getStructuringElement(cv.MORPH_RECT, size);
    cv.morphologyEx(bin, lines, cv.MORPH_OPEN, lk);
    cv.dilate(lines, lines, thick);
    cv.subtract(clean, lines, clean);
    lk.delete(); lines.delete();
  }
  thick.delete();
  const k = cv.Mat.ones(3, 3, cv.CV_8U);
  cv.morphologyEx(clean, clean, cv.MORPH_CLOSE, k);
  k.delete();
  return clean;
}

/**
 * Hand-drawn circles/ovals around a number (section markers like ②) in a line-free mask
 * (see lineFreeMask). Returns [{cx, cy, rx, ry, r}]. A marker is a pen stroke that goes most of
 * the way round a centre (small gaps allowed) with ink inside it (the number). Letter loops such
 * as O, 0 or P are empty inside and are ignored.
 */
export function circles(cv, clean, bodyH) {
  const contours = new cv.MatVector(), hier = new cv.Mat();
  const out = [];
  try {
    cv.findContours(clean, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const bb = cv.boundingRect(c);
      const major = Math.max(bb.width, bb.height), minor = Math.min(bb.width, bb.height);
      if (major < 0.9 * bodyH || major > 3.2 * bodyH || minor < 0.45 * bodyH || major > 3.2 * minor) { c.delete(); continue; }
      // Two ellipse models: the bounding box, and an ellipse fitted to the stroke (robust to a
      // leftover stub of a ruling line hanging off the ring). Keep the one the ring follows best.
      const pts = c.data32S;
      const coverageOf = (m) => {
        const bins = new Uint8Array(36);
        const cos = Math.cos(m.a), sin = Math.sin(m.a);
        for (let p = 0; p < pts.length; p += 2) {
          const x = pts[p] - m.cx, y = pts[p + 1] - m.cy;
          const dx = (x * cos + y * sin) / m.rx, dy = (-x * sin + y * cos) / m.ry;
          const rn = Math.hypot(dx, dy);
          if (rn > 0.72 && rn < 1.2) bins[Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * 36) % 36] = 1;
        }
        return bins.reduce((s, v) => s + v, 0) / 36;
      };
      const models = [{ cx: bb.x + bb.width / 2, cy: bb.y + bb.height / 2, rx: bb.width / 2, ry: bb.height / 2, a: 0 }];
      if (pts.length >= 10) {
        const e = cv.fitEllipse(c);
        if (e.size.width > 4 && e.size.height > 4) {
          models.push({ cx: e.center.x, cy: e.center.y, rx: e.size.width / 2, ry: e.size.height / 2, a: (e.angle * Math.PI) / 180 });
        }
      }
      c.delete();
      let best = null, bestCov = 0;
      for (const m of models) {
        const cov = coverageOf(m);
        if (cov > bestCov) { bestCov = cov; best = m; }
      }
      if (bestCov < 0.72) continue;
      const { cx, cy } = best;
      // Axis-aligned half-extents of the chosen ellipse.
      const rx = Math.sqrt((best.rx * Math.cos(best.a)) ** 2 + (best.ry * Math.sin(best.a)) ** 2);
      const ry = Math.sqrt((best.rx * Math.sin(best.a)) ** 2 + (best.ry * Math.cos(best.a)) ** 2);
      if (Math.max(rx, ry) * 2 > 3.2 * bodyH || Math.min(rx, ry) * 2 < 0.45 * bodyH) continue;
      // Ink inside (the number), well away from the ring.
      let inside = 0, total = 0;
      for (let y = Math.round(cy - ry * 0.55); y <= cy + ry * 0.55; y++) {
        for (let x = Math.round(cx - rx * 0.55); x <= cx + rx * 0.55; x++) {
          if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 > 0.3) continue;
          total++;
          if (clean.ucharAt(y, x)) inside++;
        }
      }
      const ratio = total ? inside / total : 0;
      if (ratio < 0.04 || ratio > 0.55) continue;
      out.push({ cx, cy, rx, ry, r: Math.max(rx, ry) });
    }
    return out;
  } finally {
    contours.delete(); hier.delete();
  }
}

/**
 * Is the text in this axis-aligned box struck through? Looks for one long pen stroke running
 * through the middle band of the box across most of the text. The stroke may wobble: a small
 * vertical smear keeps a wavy line continuous while the gaps between letters stay open.
 * Rejected: ruling / form lines (they continue past the text on both sides) and scribbled-out
 * blobs (tall solid ink, not a thin line).
 */
export function isStruck(cv, bin, x0, y0, x1, y1) {
  const w = Math.round(x1 - x0), h = Math.round(y1 - y0);
  // One or two characters can't be judged: the belly of a 6, 8, 0 or 9 looks exactly like a
  // strike line. Short values inherit the strike from their row instead (see layout).
  if (w < 20 || h < 8 || w < 2.2 * h) return false;
  const rect = new cv.Rect(Math.max(0, Math.round(x0)), Math.max(0, Math.round(y0)),
    Math.min(w, bin.cols - Math.round(x0)), Math.min(h, bin.rows - Math.round(y0)));
  const roi = bin.roi(rect);
  const smear = new cv.Mat(), line = new cv.Mat();
  const kv = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, 7));
  cv.dilate(roi, smear, kv);
  const kh = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(12, Math.floor(rect.width * 0.3)), 1));
  cv.morphologyEx(smear, line, cv.MORPH_OPEN, kh);
  kv.delete(); kh.delete();
  let hitY = -1;
  const top = Math.floor(rect.height * 0.3), bottom = Math.ceil(rect.height * 0.72);
  for (let y = top; y < bottom && hitY < 0; y++) {
    let run = 0;
    for (let x = 0; x < rect.width; x++) if (line.ucharAt(y, x)) run++;
    if (run > 0.75 * rect.width) hitY = y;
  }
  let struck = false;
  if (hitY >= 0) {
    // Scribble test: share of columns filled over most of the box height.
    let solid = 0;
    for (let x = 0; x < rect.width; x++) {
      let col = 0;
      for (let y = 0; y < rect.height; y++) if (roi.ucharAt(y, x)) col++;
      if (col > 0.6 * rect.height) solid++;
    }
    // Ruling test: does the stroke continue beyond the box on both sides?
    const gy = rect.y + hitY, reach = Math.max(10, Math.round(0.7 * rect.height));
    const beyond = (xa, xb) => {
      let hit = 0, n = 0;
      for (let x = Math.max(0, xa); x < Math.min(bin.cols, xb); x++) {
        n++;
        for (let dy = -4; dy <= 4; dy++) {
          const yy = gy + dy;
          if (yy >= 0 && yy < bin.rows && bin.ucharAt(yy, x)) { hit++; break; }
        }
      }
      return n ? hit / n : 0;
    };
    const leftCont = beyond(rect.x - reach, rect.x - 2), rightCont = beyond(rect.x + rect.width + 2, rect.x + rect.width + reach);
    // Underline test: a strike cuts through the letters, so there is text ink above AND below it.
    let above = 0, below = 0;
    for (let y = 0; y < rect.height; y++) {
      if (Math.abs(y - hitY) <= 3) continue;
      for (let x = 0; x < rect.width; x++) if (roi.ucharAt(y, x)) { if (y < hitY) above++; else below++; }
    }
    const through = below > 0.2 * above && above > 0.2 * below;
    // Form lines and ruling run on well past the writing; a strike stops near the text's ends.
    struck = solid < 0.3 * rect.width && through && Math.max(leftCont, rightCont) < 0.7;
  }
  roi.delete(); smear.delete(); line.delete();
  return struck;
}

/**
 * Pen marks inside a region of a line-free mask (see lineFreeMask: ruling and column lines are
 * already gone, while short strokes such as a "1" or a tick survive). -> {area, w, h, x, y} or null
 */
export function inkBlob(cv, clean, x0, y0, x1, y1) {
  const rx = Math.max(0, Math.round(x0)), ry = Math.max(0, Math.round(y0));
  const rw = Math.min(clean.cols - rx, Math.round(x1 - x0)), rh = Math.min(clean.rows - ry, Math.round(y1 - y0));
  if (rw < 6 || rh < 6) return null;
  const roi = clean.roi(new cv.Rect(rx, ry, rw, rh));
  const area = cv.countNonZero(roi);
  const bb = area ? cv.boundingRect(roi) : null;
  roi.delete();
  if (!bb || area < 25) return null;
  return { area, w: bb.width, h: bb.height, x: rx + bb.x, y: ry + bb.y };
}

const CIRCLED = ["⓪", "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳"];
export const circled = (n) => CIRCLED[n] ?? `(${n})`;
