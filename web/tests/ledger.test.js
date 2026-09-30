// Hand-drawn column rules, tick marks, circled section numbers, strike-throughs and repeated
// codes: the structure of real handwritten stock sheets and ledgers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLayout, harmonizeCodes } from "../src/ocr/layout.js";
import { loadEnv } from "./node-env.js";

const H = 40;
const line = (text, x0, y0, w, { p = 0.99, struck = false, marker = false, h = H } = {}) => ({
  text, score: p, minProb: p, vertical: false, struck, marker,
  pts: [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]],
  chars: [...text].map((c, i) => ({ c, p, x: (i + 0.5) / text.length })),
});
// Two slightly tilted column rules at x ~ 560 and ~ 800.
const rule = (x, a = -0.01) => ({ a, b: x, y0: 0, y1: 1400, xAt: (y) => a * y + x });

test("column rules define the table even when rows are tightly packed or cells are empty", () => {
  const y = (i) => 100 + i * 42; // rows closer together than one text height + padding
  const lines = [
    line("PART-NO", 150, y(0) - 50, 200),
    line("TC500368-083", 150, y(1), 280), line("V", 495, y(1), 30), line("06", 600, y(1), 50),
    line("ECSF1546PB", 150, y(2), 230), line("V", 497, y(2), 30), line("12", 600, y(2), 50),
    line("LCPM20A4LR", 150, y(3), 230), line("L", 493, y(3), 30), line("30", 840, y(3), 50),
    line("ATFMT4SB", 150, y(4), 200), line("04", 600, y(4), 50),
    line("08886-02505", 150, y(5), 260, { struck: true }), line("01", 840, y(5), 50),
    line("②", 480, y(6), 50, { marker: true, p: 0.7 }),
    line("ATEMTYSB", 150, y(7), 200, { p: 0.5 }), line("V", 495, y(7), 30), line("1", 600, y(7), 20),
    line("③", 480, y(8), 50, { marker: true }),
    line("6925L", 150, y(9), 120), line("4572", 840, y(9), 90),
  ];
  const [table, ...rest] = buildLayout(null, null, lines, null, { rules: [rule(560), rule(800)] });
  assert.equal(table.type, "table");
  assert.equal(rest.length, 0, "everything belongs to the one table");
  assert.equal(table.header_rows, 1);
  const rows = table.rows.map((r) => r.map((c) => c.text));
  assert.deepEqual(rows, [
    ["PART-NO", "✓", "", ""],
    ["TC500368-083", "✓", "06", ""],
    ["ECSF1546PB", "✓", "12", ""],
    ["LCPM20A4LR", "✓", "", "30"],
    ["ATFMT4SB", "", "04", ""],
    ["08886-02505", "", "", "01"],
    ["②", "", "", ""],
    ["ATFMT4SB", "✓", "1", ""], // corrected from the confident "ATFMT4SB" above, and flagged
    ["③", "", "", ""],
    ["6925L", "", "", "4572"],
  ]);
  assert.ok(table.rows[5][0].struck && table.rows[5][3].struck, "a struck entry strikes its whole row");
  assert.ok(table.rows[7][0].uncertain, "harmonized codes are flagged for review");
});

test("repeated codes: confusable characters resolve to the confident reading", () => {
  const blocks = [{ type: "table", rows: [
    [{ text: "ECSF1546PB", conf: 0.99 }], [{ text: "ECSF15Y6PB", conf: 0.5 }],
    [{ text: "LCPM20A4LR", conf: 0.86 }], [{ text: "LCPM20AYLR", conf: 0.86 }],
    [{ text: "SUPPLIER", conf: 0.4 }], [{ text: "SUPPLlER", conf: 0.99 }], // words without digits: untouched
  ] }];
  harmonizeCodes(blocks);
  const r = blocks[0].rows.map((x) => x[0]);
  assert.equal(r[1].text, "ECSF1546PB");
  assert.ok(r[1].uncertain);
  assert.ok(r[2].uncertain && r[3].uncertain, "equal confidence: both flagged, neither guessed");
  assert.equal(r[4].text, "SUPPLIER");
});

test("circled section numbers that break a +1 run are repaired", () => {
  const y = (i) => 100 + i * 60;
  const lines = [
    line("PART-A1", 150, y(0), 200), line("5", 600, y(0), 30),
    line("②", 480, y(1), 50, { marker: true }), line("PART-B2", 150, y(2), 200), line("6", 600, y(2), 30),
    line("⑦", 480, y(3), 50, { marker: true, p: 0.4 }), line("PART-C3", 150, y(4), 200), line("7", 600, y(4), 30),
    line("④", 480, y(5), 50, { marker: true }), line("PART-D4", 150, y(6), 200), line("8", 600, y(6), 30),
  ];
  const [table] = buildLayout(null, null, lines, null, { rules: [rule(560, 0)] });
  const marks = table.rows.map((r) => r[0].text).filter((t) => /[②-⑳]/.test(t));
  assert.deepEqual(marks, ["②", "③", "④"]);
});

test("OpenCV.js copies are real copies (4.12 / 5.0 builds share memory and corrupt pages)", async () => {
  const { cv } = await loadEnv();
  const m = new cv.Mat(8, 8, cv.CV_8U, new cv.Scalar(0));
  const c = m.clone();
  cv.bitwise_not(c, c);
  const d = new cv.Mat();
  cv.threshold(m, d, 100, 255, cv.THRESH_BINARY_INV);
  assert.equal(cv.countNonZero(m), 0, "modifying a clone must not change the original");
  assert.equal(cv.countNonZero(c), 64);
  m.delete(); c.delete(); d.delete();
});
