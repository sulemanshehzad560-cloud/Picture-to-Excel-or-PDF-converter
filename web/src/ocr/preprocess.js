// Image preparation with OpenCV.js. Every function frees the Mats it creates; callers own
// the Mats they receive. Coordinates are in the prepared ("work") image throughout.

export const MAX_LONG_SIDE = 3600; // cap work size for phones; text stays > 20 px tall on A4
export const MIN_LONG_SIDE = 1600; // upscale tiny images so small marks span several pixels

export function fromImageData(cv, img) {
  const rgba = cv.matFromImageData(img);
  const rgb = new cv.Mat();
  cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
  rgba.delete();
  return rgb;
}

export function toImageData(cv, mat, longSide) {
  let src = mat;
  if (longSide && Math.max(mat.rows, mat.cols) > longSide) src = resizeLong(cv, mat, longSide);
  const rgba = new cv.Mat();
  cv.cvtColor(src, rgba, src.channels() === 1 ? cv.COLOR_GRAY2RGBA : cv.COLOR_RGB2RGBA);
  const out = { width: rgba.cols, height: rgba.rows, data: new Uint8ClampedArray(rgba.data) };
  rgba.delete();
  if (src !== mat) src.delete();
  return out;
}

export function resizeLong(cv, mat, target) {
  const scale = target / Math.max(mat.rows, mat.cols);
  const out = new cv.Mat();
  cv.resize(mat, out, new cv.Size(Math.round(mat.cols * scale), Math.round(mat.rows * scale)), 0, 0,
    scale > 1 ? cv.INTER_CUBIC : cv.INTER_AREA);
  return out;
}

function orderCorners(pts) {
  const s = pts.map(([x, y]) => x + y);
  const d = pts.map(([x, y]) => y - x);
  const at = (arr, fn) => pts[arr.indexOf(fn(...arr))];
  return [at(s, Math.min), at(d, Math.min), at(s, Math.max), at(d, Math.max)];
}

/** Find the sheet of paper in a photo and warp it flat. Returns a new Mat or null. */
export function flattenPage(cv, rgb) {
  const scale = 800 / Math.max(rgb.rows, rgb.cols);
  const small = new cv.Mat(), gray = new cv.Mat(), edges = new cv.Mat();
  const contours = new cv.MatVector(), hier = new cv.Mat();
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
  try {
    cv.resize(rgb, small, new cv.Size(0, 0), scale, scale, cv.INTER_AREA);
    cv.cvtColor(small, gray, cv.COLOR_RGB2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    cv.Canny(gray, edges, 50, 150);
    cv.dilate(edges, edges, kernel);
    cv.findContours(edges, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const total = small.rows * small.cols;
    const list = [];
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      list.push({ c, area: cv.contourArea(c) });
    }
    list.sort((a, b) => b.area - a.area);
    let result = null;
    for (const { c, area } of list.slice(0, 5)) {
      if (result || area < 0.25 * total || area > 0.97 * total) continue;
      const approx = new cv.Mat();
      cv.approxPolyDP(c, approx, 0.02 * cv.arcLength(c, true), true);
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const pts = [];
        for (let k = 0; k < 4; k++) pts.push([approx.data32S[k * 2] / scale, approx.data32S[k * 2 + 1] / scale]);
        const [tl, tr, br, bl] = orderCorners(pts);
        const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
        const w = Math.round(Math.max(dist(br, bl), dist(tr, tl)));
        const h = Math.round(Math.max(dist(tr, br), dist(tl, bl)));
        if (w >= 200 && h >= 200) {
          const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [...tl, ...tr, ...br, ...bl]);
          const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w - 1, 0, w - 1, h - 1, 0, h - 1]);
          const m = cv.getPerspectiveTransform(srcPts, dstPts);
          const flat = new cv.Mat();
          cv.warpPerspective(rgb, flat, m, new cv.Size(w, h), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
          // Trim a hair off each edge so no sliver of desk survives as a fake ruled line.
          const my = Math.max(2, Math.floor(h / 80)), mx = Math.max(2, Math.floor(w / 80));
          result = flat.roi(new cv.Rect(mx, my, w - 2 * mx, h - 2 * my)).clone();
          flat.delete(); m.delete(); srcPts.delete(); dstPts.delete();
        }
      }
      approx.delete();
    }
    list.forEach(({ c }) => c.delete());
    return result;
  } finally {
    small.delete(); gray.delete(); edges.delete(); contours.delete(); hier.delete(); kernel.delete();
  }
}

/** Rotate by `angle` degrees counter-clockwise, expanding the canvas, white/replicated border. */
export function rotate(cv, mat, angle) {
  const center = new cv.Point(mat.cols / 2, mat.rows / 2);
  const m = cv.getRotationMatrix2D(center, angle, 1.0);
  const cos = Math.abs(m.doubleAt(0, 0)), sin = Math.abs(m.doubleAt(0, 1));
  const nw = Math.round(mat.rows * sin + mat.cols * cos), nh = Math.round(mat.rows * cos + mat.cols * sin);
  m.doublePtr(0, 2)[0] += nw / 2 - mat.cols / 2;
  m.doublePtr(1, 2)[0] += nh / 2 - mat.rows / 2;
  const out = new cv.Mat();
  cv.warpAffine(mat, out, m, new cv.Size(nw, nh), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
  m.delete();
  return out;
}

/** Rotate by a multiple of 90 degrees clockwise (1, 2 or 3 quarter turns). */
export function rotate90(cv, mat, quarters) {
  const out = new cv.Mat();
  const code = [null, cv.ROTATE_90_CLOCKWISE, cv.ROTATE_180, cv.ROTATE_90_COUNTERCLOCKWISE][quarters % 4];
  if (code === null) mat.copyTo(out); else cv.rotate(mat, out, code);
  return out;
}

/** Relative noise level from the median absolute Laplacian; roughly 0-3 on clean scans. */
export function estimateNoise(cv, gray) {
  const small = Math.max(gray.rows, gray.cols) > 1600 ? resizeLong(cv, gray, 1600) : gray;
  const lap = new cv.Mat();
  cv.Laplacian(small, lap, cv.CV_32F);
  const vals = Float32Array.from(lap.data32F, Math.abs);
  lap.delete();
  if (small !== gray) small.delete();
  // median via sampling keeps this O(n) on big pages
  const step = Math.max(1, Math.floor(vals.length / 200000));
  const sample = [];
  for (let i = 0; i < vals.length; i += step) sample.push(vals[i]);
  sample.sort((a, b) => a - b);
  return (sample[sample.length >> 1] * 1.4826) / 2.83;
}

/**
 * High-contrast greyscale version for hard pages: denoise matched to the noise level,
 * shadow/illumination flattening, gentle local contrast (CLAHE). Returns a new 1-channel Mat.
 */
export function enhance(cv, rgb, noise) {
  const gray = new cv.Mat();
  cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
  if (noise > 4) {
    // Heavy grain (dim light, small sensor, strong JPEG): median kills speckle, blur smooths the rest.
    const tmp = new cv.Mat();
    cv.medianBlur(gray, tmp, 5);
    cv.GaussianBlur(tmp, gray, new cv.Size(3, 3), 0);
    tmp.delete();
  } else if (noise > 2.5) {
    const tmp = new cv.Mat();
    cv.bilateralFilter(gray, tmp, 7, Math.min(90, 12 * noise), 7);
    cv.medianBlur(tmp, gray, 3);
    tmp.delete();
  }
  // Divide by an estimate of the paper background: evens out shadows and flash hot spots.
  const bg = new cv.Mat();
  const k = Math.max(15, Math.floor(Math.min(gray.rows, gray.cols) / 30) | 1);
  const kernel = cv.Mat.ones(7, 7, cv.CV_8U);
  cv.dilate(gray, bg, kernel);
  cv.medianBlur(bg, bg, Math.min(k, 255) | 1);
  const out = new cv.Mat();
  cv.divide(gray, bg, out, 255);
  cv.normalize(out, out, 0, 255, cv.NORM_MINMAX);
  if (noise <= 3) {
    // Local contrast for faint ink; skipped on noisy pages where it would amplify grain.
    const clahe = new cv.CLAHE(1.6, new cv.Size(8, 8));
    clahe.apply(out, out);
    clahe.delete();
  }
  bg.delete(); kernel.delete(); gray.delete();
  return out;
}

/**
 * Photo -> flattened, size-normalised RGB work image.
 * Returns { rgb, noise, steps }. Deskew happens later, from detected text-line angles.
 */
export function prepare(cv, imageData, { flatten = true } = {}) {
  const steps = [];
  let rgb = fromImageData(cv, imageData);
  if (Math.max(rgb.rows, rgb.cols) > MAX_LONG_SIDE) {
    const r = resizeLong(cv, rgb, MAX_LONG_SIDE);
    rgb.delete();
    rgb = r;
  }
  if (flatten) {
    const flat = flattenPage(cv, rgb);
    if (flat) {
      rgb.delete();
      rgb = flat;
      steps.push("page flattened");
    }
  }
  // Measure noise at native resolution: upscaling first would smooth the grain and hide it.
  const gray = new cv.Mat();
  cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
  const noise = estimateNoise(cv, gray);
  gray.delete();
  if (Math.max(rgb.rows, rgb.cols) < MIN_LONG_SIDE) {
    const r = resizeLong(cv, rgb, MIN_LONG_SIDE);
    rgb.delete();
    rgb = r;
    steps.push("upscaled for small details");
  }
  return { rgb, noise, steps };
}
