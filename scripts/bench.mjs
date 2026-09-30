// Accuracy benchmark for the on-device engine, same metrics as tests/benchmark.py.
//
//   python -m tests.samples          # generate the good -> worst sample pages first
//   node scripts/bench.mjs [fast|high|max] [--save]
//
// text accuracy = 1 - character error rate of the closest output line per ground-truth line
// table cells   = share of ground-truth cells reproduced exactly (same grid position when shapes agree)
// numbers       = share of ground-truth numbers found exactly, every dot and comma included

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recognizePage } from "../web/src/ocr/engine.js";
import { loadEnv, readPng, samplesDir } from "../web/tests/node-env.js";

const NUM_RE = /\d[\d,./:-]*\d|\d/g;

export function levenshtein(a, b) {
  if (a.length < b.length) [a, b] = [b, a];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1])));
    prev = cur;
  }
  return prev[b.length];
}

export function outputLines(blocks) {
  const lines = [];
  for (const b of blocks) {
    if (b.type === "key_value") lines.push(...b.pairs.map((kv) => `${kv.key}: ${kv.value}`));
    else if (b.type === "table") {
      lines.push(...b.rows.map((r) => r.map((c) => c.text).join(" ")));
      lines.push(...b.rows.flat().map((c) => c.text));
    } else if (b.type === "list") lines.push(...b.items);
    else lines.push(...(b.text || "").split("\n"));
  }
  return [...lines, ...lines.slice(1).map((l, i) => `${lines[i]} ${l}`)];
}

export function score(truth, blocks) {
  const cands = outputLines(blocks);
  const lineAcc = (t) => Math.max(0, 1 - Math.min(...cands.map((c) => levenshtein(t.trim(), c.trim()))) / Math.max(1, t.length));
  const text = truth.lines.reduce((s, l) => s + (cands.length ? lineAcc(l) : 0), 0) / truth.lines.length;

  let cells = null;
  if (truth.table) {
    cells = 0;
    const total = truth.table.flat().length;
    for (const b of blocks.filter((x) => x.type === "table")) {
      let hits = 0;
      if (b.rows.length === truth.table.length && b.rows[0].length === truth.table[0].length) {
        truth.table.forEach((row, r) => row.forEach((t, c) => { if (b.rows[r][c].text.trim() === t) hits++; }));
      } else {
        const pool = b.rows.flat().map((c) => c.text.trim());
        for (const t of truth.table.flat()) { const k = pool.indexOf(t); if (k >= 0) { pool.splice(k, 1); hits++; } }
      }
      cells = Math.max(cells, hits / total);
    }
  }
  const want = [...truth.lines, ...(truth.table || []).flat()].join(" ").match(NUM_RE) || [];
  const found = cands.join(" ").match(NUM_RE) || [];
  let hits = 0;
  for (const n of want) { const k = found.indexOf(n); if (k >= 0) { found.splice(k, 1); hits++; } }
  return { text, cells, numbers: want.length ? hits / want.length : 1 };
}

async function main() {
  const precision = process.argv.find((a) => ["fast", "high", "max"].includes(a)) || "high";
  const save = process.argv.includes("--save");
  const env = await loadEnv();
  const truth = JSON.parse(readFileSync(join(samplesDir, "truth.json"), "utf8"));
  const outDir = join(samplesDir, "..", `ppocr_${precision}`);
  if (save) mkdirSync(outDir, { recursive: true });
  const pct = (v) => (v == null ? "     -" : `${(v * 100).toFixed(1).padStart(5)}%`);
  const rows = [];
  for (const [name, t] of Object.entries(truth)) {
    const res = await recognizePage(env, readPng(join(samplesDir, `${name}.png`)), { precision });
    const s = score(t, res.blocks);
    rows.push({ sample: name, quality: t.quality, ...s, seconds: res.ms / 1000 });
    console.log(`${name.padEnd(28)} ${t.quality.padEnd(7)} text ${pct(s.text)}  cells ${pct(s.cells)}  numbers ${pct(s.numbers)}  ${(res.ms / 1000).toFixed(1).padStart(5)}s`);
    if (save) writeFileSync(join(outDir, `${name}.json`), JSON.stringify({ pages: [{ page_number: 1, blocks: res.blocks }], steps: res.steps }, null, 2));
  }
  if (save) writeFileSync(join(outDir, "benchmark.json"), JSON.stringify(rows, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
