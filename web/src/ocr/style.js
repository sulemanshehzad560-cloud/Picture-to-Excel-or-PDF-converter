// The look of the page, for the page-copy exports: text colour and weight, shaded table cells.
// Colours are judged against the paper, so a grey photo of white paper still gives white cells
// and black text, while a blue pen stays blue and a dark header row stays dark.

/** Pixels of a box as {r, g, b, l}, subsampled to about `max` points. */
function sampler(rgb) {
  const W = rgb.cols, H = rgb.rows, ch = rgb.channels(), data = rgb.data;
  return (x0, y0, x1, y1, max = 1600) => {
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(W, Math.ceil(x1)); y1 = Math.min(H, Math.ceil(y1));
    const out = [];
    if (x1 - x0 < 2 || y1 - y0 < 2) return out;
    const step = Math.max(1, Math.sqrt(((x1 - x0) * (y1 - y0)) / max));
    for (let y = y0; y < y1; y += step) {
      for (let x = x0; x < x1; x += step) {
        const i = (Math.floor(y) * W + Math.floor(x)) * ch;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        out.push({ r, g, b, l: 0.299 * r + 0.587 * g + 0.114 * b });
      }
    }
    return out.sort((a, b) => a.l - b.l);
  };
}

const hex = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0").toUpperCase();
const sat = (p) => { const mx = Math.max(p.r, p.g, p.b), mn = Math.min(p.r, p.g, p.b); return mx ? (mx - mn) / mx : 0; };

export function styleBlocks(cv, rgb, blocks) {
  const sample = sampler(rgb);
  const all = sample(0, 0, rgb.cols, rgb.rows, 6000);
  if (!all.length) return;
  const paper = all[Math.floor(all.length * 0.75)];
  // Colour relative to the paper: the paper itself becomes white.
  const relative = (p) => `${hex((p.r * 255) / Math.max(1, paper.r))}${hex((p.g * 255) / Math.max(1, paper.g))}${hex((p.b * 255) / Math.max(1, paper.b))}`;

  const texts = [];
  const textStyle = (box, target) => {
    if (!box) return;
    const px = sample(...box);
    if (px.length < 8) return;
    const bg = px[px.length >> 1];
    // Light text on a dark fill when the bright tail stands further from the background than the
    // dark one (which may only be a ruled line crossing the box).
    const lo = px[Math.floor(px.length * 0.03)], hi = px[Math.floor(px.length * 0.97)];
    const light = bg.l < 0.8 * paper.l && hi.l - bg.l > 1.3 * (bg.l - lo.l);
    const ext = light ? hi : lo;
    const contrast = Math.abs(ext.l - bg.l);
    if (contrast < 20) return;
    const ink = px.filter((p) => Math.abs(p.l - bg.l) > 0.5 * contrast).length / px.length;
    const color = sat(ext) > 0.3 && !light ? relative(ext) : light ? "FFFFFF" : "000000";
    target.style = { ...(target.style || {}), color };
    texts.push({ target, ink, light, h: box[3] - box[1] });
  };

  for (const b of blocks) {
    if (b.type === "table" && b.geo) {
      const fills = tableFills(sample, b);
      b.rows.forEach((row, r) => row.forEach((cell, c) => {
        const fill = fills(r, c);
        if (fill) cell.style = { ...(cell.style || {}), fill };
        if (cell.box && cell.text) {
          const n = Math.max(1, cell.text.split("\n").length);
          textStyle(cell.box, cell);
          if (cell.style) cell.style.lineH = cell.lineH || (cell.box[3] - cell.box[1]) / n;
        }
      }));
    } else if (b.geo?.lines) {
      for (const line of b.geo.lines) textStyle(line.box, line);
    }
  }
  // Light text on a dark band is a heading row: print it bold, as such rows are. Dark text is bold
  // when it carries clearly more ink than the page's usual text.
  for (const t of texts) if (t.light) t.target.style.bold = true;
  const dark = texts.filter((t) => !t.light);
  if (dark.length >= 3) {
    const med = dark.map((t) => t.ink).sort((a, b) => a - b)[dark.length >> 1];
    for (const t of dark) if (t.ink > 1.5 * med) t.target.style.bold = true;
  }
}

/**
 * Background of each table cell, judged against its neighbourhood so uneven light in a photo does
 * not shade the table. Rows banded in alternate shades (a common spreadsheet print) are found from
 * the alternation itself, even when the grey is faint; clearly darker cells (a header band) always.
 */
function tableFills(sample, b) {
  const { xs, ys } = b.geo;
  const nR = ys.length - 1, nC = xs.length - 1;
  const med = (px) => px[px.length >> 1];
  const inset = (x0, y0, x1, y1, n) => sample(x0 + 0.1 * (x1 - x0), y0 + 0.2 * (y1 - y0), x1 - 0.1 * (x1 - x0), y1 - 0.2 * (y1 - y0), n);
  const lum = ys.slice(0, -1).map((y, r) => {
    const px = inset(xs[0], y, xs[nC], ys[r + 1], 3000);
    return px.length ? med(px).l : 255;
  });
  // Local paper: the brightest row nearby.
  const ref = lum.map((_, r) => Math.max(...lum.slice(Math.max(0, r - 2), r + 3)));
  const rel = lum.map((l, r) => l / Math.max(1, ref[r]));
  // Alternating bands: consecutive body rows keep swapping lighter / darker.
  const body = [...Array(nR).keys()].filter((r) => rel[r] > 0.85);
  let flips = 0, triples = 0;
  for (let k = 2; k < body.length; k++) {
    const [a, m, c] = [body[k - 2], body[k - 1], body[k]];
    if (c - a !== 2) continue;
    triples++;
    const d1 = lum[m] - lum[a], d2 = lum[c] - lum[m];
    if (d1 * d2 < 0 && Math.abs(d1) > 1.5 && Math.abs(d2) > 1.5) flips++;
  }
  let band = null;
  if (triples >= 4 && flips >= 0.75 * triples) {
    const avg = (p) => { const v = body.filter((r) => r % 2 === p).map((r) => rel[r]); return v.reduce((s, x) => s + x, 0) / Math.max(1, v.length); };
    const dark = avg(0) < avg(1) ? 0 : 1;
    const g = hex(255 - 255 * 1.4 * (1 - Math.max(0.8, Math.min(0.975, avg(dark) / avg(1 - dark)))));
    band = { parity: dark, fill: g + g + g };
  }
  // A photo compresses shading towards the paper: stretch it back (a printed 50% grey reads as ~64%).
  const deepen = (v) => 255 - (255 - v) * 1.4;
  return (r, c) => {
    if (r >= nR || c >= nC) return null;
    // A clearly darker cell (header band, highlighted cell), in its own colour.
    const px = inset(xs[c], ys[r], xs[c + 1], ys[r + 1], 600);
    const inBand = band && rel[r] > 0.85 && r % 2 === band.parity;
    if (px.length >= 8) {
      const m = med(px);
      const k = 255 / Math.max(1, ref[r]);
      // A shaded band row is printed as a halftone: a patch of it may read darker than the rest.
      if (m.l * k < (inBand ? 0.78 : 0.9) * 255) {
        // Near-grey is grey (the photo's colour cast is not the print's colour).
        const neutral = Math.max(m.r, m.g, m.b) - Math.min(m.r, m.g, m.b) < 0.12 * Math.max(m.r, m.g, m.b);
        const [r0, g0, b0] = neutral ? [m.l, m.l, m.l] : [m.r, m.g, m.b];
        return hex(deepen(r0 * k)) + hex(deepen(g0 * k)) + hex(deepen(b0 * k));
      }
    }
    return inBand ? band.fill : null;
  };
}
