// Printed reports and photographed tables: form headers, curled pages, record tables with an
// indented description line, and text that runs across a printed column rule.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLayout, splitLinesAtGrid } from "../src/ocr/layout.js";

const line = (text, x0, y0, w, h = 30, slope = 0) => ({
  text, score: 0.99, vertical: false, minProb: 0.99,
  pts: [[x0, y0], [x0 + w, y0 + slope * w], [x0 + w, y0 + slope * w + h], [x0, y0 + h]],
  chars: [...text].map((c, i) => ({ c, p: 0.99, x: (i + 0.5) / text.length })),
});
const cells = (b) => b.rows.map((r) => r.map((c) => c.text));

test("report header: labelled fields, two on a line, dot leaders, a colon read on its own", () => {
  const blocks = buildLayout(null, null, [
    line("Pick list : 93.001774278.8", 100, 100, 520),
    line("Supervisor :", 100, 140, 240), line("LFS", 360, 140, 60),
    line("Work pack. :", 100, 180, 240), line("748322", 360, 180, 130),
    line("Ship. Meth.:", 100, 260, 240), line("Order", 700, 260, 100), line(".:", 830, 262, 30),
    line("Tour . . . : Product. no:", 100, 300, 700),
  ], null);
  assert.equal(blocks[0].type, "key_value");
  assert.deepEqual(blocks[0].pairs.map((p) => [p.key, p.value]), [
    ["Pick list", "93.001774278.8"], ["Supervisor", "LFS"], ["Work pack.", "748322"],
    ["Ship. Meth.", ""], ["Order", ""], ["Tour", ""], ["Product. no", ""],
  ]);
});

test("curled page: rows that tilt differently across the page stay rows", () => {
  // Tilt 0.10 at the left edge easing to 0.0 at the right: the right end of each row sits a
  // full line higher than a straight line through its left end would suggest.
  const s = (x) => 0.1 * (1 - x / 1400);
  const yAt = (y0, x) => y0 + 0.1 * (x - 100) - 0.1 * (x * x - 100 * 100) / 2800;
  const lines = [];
  const want = [];
  for (let r = 0; r < 8; r++) {
    const y0 = 100 + r * 45;
    const row = [[`CODE-${r}1`, 100, 200], [`${r}0${r}`, 600, 90], [`${r}.000 PCS`, 1100, 200]];
    for (const [t, x, w] of row) lines.push(line(t, x, yAt(y0, x) - 15, w, 30, s(x + w / 2)));
    want.push(row.map((c) => c[0]));
  }
  const t = buildLayout(null, null, lines, null).find((b) => b.type === "table");
  assert.deepEqual(cells(t), want);
});

test("record table: an indented description line under each record does not merge columns", () => {
  const lines = [
    line("Bin loc.", 130, 100, 90), line("Item no.", 330, 100, 90), line("TPO no.", 860, 100, 80), line("Rem. qty", 1000, 100, 120),
    line("EX-INB-0008", 125, 150, 125), line("11137618512-FEB", 325, 150, 170), line("19423272", 855, 150, 92), line("1.000 PCS", 1040, 150, 105),
    line("OIL SUMP BM CAR FEBI", 160, 185, 225), line("0.000", 1220, 185, 60),
    line("EX-INB-0009", 125, 230, 125), line("20393097-FEB", 325, 230, 150), line("19423273", 855, 230, 92), line("2.000 PCS", 1040, 230, 105),
    line("GASKET SET ENGINE", 160, 265, 225), line("1.000", 1220, 265, 60),
  ];
  const t = buildLayout(null, null, lines, null).find((b) => b.type === "table");
  assert.equal(t.rows[0].length, 5);
  assert.deepEqual(cells(t)[1], ["EX-INB-0008", "11137618512-FEB", "19423272", "1.000 PCS", ""]);
  assert.deepEqual(cells(t)[2], ["OIL SUMP BM CAR FEBI", "", "", "", "0.000"]);
});

test("a text line read across a printed column rule is split at the rule", () => {
  const grid = { xs: [100, 300, 500], ys: [0, 50, 100] };
  const [a, b] = splitLinesAtGrid(grid, [line("5540 KYB", 200, 60, 200)]);
  assert.equal(a.text, "5540");
  assert.equal(b.text, "KYB");
  assert.ok(Math.max(...a.pts.map((p) => p[0])) <= 301 && Math.min(...b.pts.map((p) => p[0])) >= 299);
  // A line inside one cell is left alone.
  assert.equal(splitLinesAtGrid(grid, [line("TGP", 320, 60, 80)]).length, 1);
});
