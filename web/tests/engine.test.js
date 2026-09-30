// End-to-end tests of the on-device engine (same WASM runtime the phone uses).
// Needs the models (npm run models) and the synthetic samples (python -m tests.samples);
// tests that need samples skip when they are absent, e.g. in CI.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildLayout } from "../src/ocr/layout.js";
import { fixNumericTokens } from "../src/ocr/ppocr.js";
import { recognizePage } from "../src/ocr/engine.js";
import { score } from "../../scripts/bench.mjs";
import { loadEnv, readPng, samplesDir } from "./node-env.js";

const haveModels = existsSync(join(samplesDir, "../../../web/public/models/rec.onnx"));
const haveSamples = existsSync(join(samplesDir, "truth.json"));
const truth = haveSamples ? JSON.parse(readFileSync(join(samplesDir, "truth.json"), "utf8")) : {};

test("numeric context turns look-alike letters into the digits the writer meant", () => {
  const mk = (s, alts = {}) => ({ chars: [...s].map((c, i) => ({ c, p: 0.95, x: 0, alt: alts[i]?.[0] ?? "0", altP: alts[i]?.[1] ?? 0.0001 })) });
  const run = (s, alts) => { const r = fixNumericTokens(mk(s, alts)); return r.text ?? s; };
  assert.equal(run("202s", { 3: ["5", 0.2] }), "2025");
  assert.equal(run("$12,450.7s total", { 9: ["5", 0.3] }), "$12,450.75 total");
  assert.equal(run("1990s", { 4: ["5", 0.0001] }), "1990s"); // a confident "s" stays
  assert.equal(run("A4", { 0: ["4", 0.3] }), "A4"); // only one digit: not a number
  const r = fixNumericTokens(mk("2.2s", { 3: ["5", 0.1] }));
  assert.equal(r.text, "2.25");
  assert.ok(r.chars[3].p <= 0.5, "corrected characters are flagged for review");
});

const line = (text, x0, y0, w, h = 40, p = 0.99) => ({
  text, score: p, vertical: false,
  pts: [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]],
  chars: [...text].map((c, i) => ({ c, p, x: (i + 0.5) / text.length })),
});

test("layout: borderless table, form fields, list, heading, paragraph", () => {
  const lines = [
    line("Monthly report", 100, 40, 500, 80),
    line("Name:", 100, 200, 120), line("Ayesha", 400, 200, 160),
    line("Date:", 100, 260, 120), line("07/08/2026", 400, 260, 220),
    line("Item", 100, 400, 100), line("Qty", 500, 400, 80), line("Price", 800, 400, 110),
    line("Pencils", 100, 460, 160), line("12", 500, 460, 50), line("0.75", 800, 460, 90),
    line("Ink", 100, 520, 80), line("3", 500, 520, 25), line("4.20", 800, 520, 90),
    line("- pens", 100, 700, 140), line("- tape", 100, 760, 140),
    line("Budget approved: $12,450.75 total.", 100, 900, 700, 40, 0.7),
    line("Call Sarah about it.", 100, 950, 420),
  ];
  const blocks = buildLayout(null, null, lines, null);
  assert.deepEqual(blocks.map((b) => b.type), ["heading", "key_value", "table", "list", "paragraph"]);
  assert.deepEqual(blocks[1].pairs.map((p) => [p.key, p.value]), [["Name", "Ayesha"], ["Date", "07/08/2026"]]);
  assert.deepEqual(blocks[2].rows.map((r) => r.map((c) => c.text)), [["Item", "Qty", "Price"], ["Pencils", "12", "0.75"], ["Ink", "3", "4.20"]]);
  assert.deepEqual(blocks[3].items, ["pens", "tape"]);
  // A single "label: value" inside running text stays in the paragraph, and low confidence is flagged.
  assert.equal(blocks[4].text, "Budget approved: $12,450.75 total.\nCall Sarah about it.");
  assert.equal(blocks[4].uncertain, true);
});

const cases = {
  printed_invoice: { text: 1, cells: 1, numbers: 1 },
  neat_handwritten_note: { text: 0.98, numbers: 0.8 },
  handwritten_table_medium: { text: 0.95, cells: 0.9, numbers: 0.9 },
  messy_clean_borderless: { text: 0.95, cells: 0.85, numbers: 0.9 },
  messy_clean_form: { text: 0.95, numbers: 0.9 },
};

for (const [name, min] of Object.entries(cases)) {
  test(`reads ${name} accurately`, { skip: !(haveModels && haveSamples && truth[name]) && "models or samples missing", timeout: 180000 }, async () => {
    const env = await loadEnv();
    const res = await recognizePage(env, readPng(join(samplesDir, `${name}.png`)), { precision: "high" });
    const s = score(truth[name], res.blocks);
    for (const [k, v] of Object.entries(min)) assert.ok(s[k] >= v, `${k} ${s[k]} < ${v}`);
    assert.ok(res.preview.width > 0 && res.preview.data.length === res.preview.width * res.preview.height * 4);
  });
}
