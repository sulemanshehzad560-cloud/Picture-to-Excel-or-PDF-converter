"""Accuracy benchmark: run an engine over the synthetic samples and score it.

    python -m tests.benchmark                   # offline engine
    python -m tests.benchmark --engine claude   # needs ANTHROPIC_API_KEY
    python -m tests.benchmark --engine claude --precision max --save

Scores:
  text accuracy  = 1 - character error rate over the ground-truth lines, found anywhere in the output
  table cells    = share of ground-truth table cells reproduced exactly (character for character)
  numbers        = share of ground-truth numbers (with every dot and comma) found exactly
"""

from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path

from app import preprocess
from app.engines import pick_engine
from app.exporters import export
from app.schema import ExtractedDocument

from .samples import Sample, all_samples

NUM_RE = re.compile(r"\d[\d,./:-]*\d|\d")


def levenshtein(a: str, b: str) -> int:
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def best_line_match(truth: str, candidates: list[str]) -> float:
    """Character accuracy of the closest output line (layout differences shouldn't count as errors)."""
    if not candidates:
        return 0.0
    t = truth.strip()
    best = min(levenshtein(t, c.strip()) for c in candidates)
    return max(0.0, 1 - best / max(1, len(t)))


def output_lines(doc: ExtractedDocument) -> list[str]:
    lines = []
    for p in doc.pages:
        for b in p.blocks:
            if b.type == "key_value":
                lines += [f"{kv.key}: {kv.value}" for kv in b.pairs or []]
            elif b.type == "table":
                lines += [" ".join(c.text for c in r) for r in b.rows or []]
                lines += [c.text for r in b.rows or [] for c in r]
            elif b.type == "list":
                lines += b.items or []
            else:
                lines += (b.text or "").split("\n")
    # also allow adjacent lines joined (engines sometimes split one written line in two)
    lines += [a + " " + b for a, b in zip(lines, lines[1:])]
    return lines


def table_cell_accuracy(truth: list[list[str]], doc: ExtractedDocument) -> float:
    tables = [b.rows for _, _, b in doc.tables()]
    if not tables:
        return 0.0
    best = 0.0
    for rows in tables:
        cells = [c.text.strip() for r in rows for c in r]
        # Match cell-by-cell against the same grid position when shapes agree, else by content.
        if len(rows) == len(truth) and len(rows[0]) == len(truth[0]):
            hits = sum(rows[r][c].text.strip() == truth[r][c] for r in range(len(truth)) for c in range(len(truth[0])))
        else:
            pool = list(cells)
            hits = 0
            for t in (x for row in truth for x in row):
                if t in pool:
                    pool.remove(t)
                    hits += 1
        best = max(best, hits / sum(len(r) for r in truth))
    return best


def number_accuracy(sample: Sample, doc: ExtractedDocument) -> float:
    truth_text = " ".join(sample.lines + [c for r in (sample.table or []) for c in r])
    nums = NUM_RE.findall(truth_text)
    if not nums:
        return 1.0
    found_text = " ".join(output_lines(doc))
    found = NUM_RE.findall(found_text)
    hits = 0
    for n in nums:
        if n in found:
            found.remove(n)
            hits += 1
    return hits / len(nums)


def run(engine_name: str, precision: str, save: bool) -> list[dict]:
    engine = pick_engine(engine_name)
    out_dir = Path(__file__).parent / "output" / f"{engine.name}_{precision}"
    rows = []
    for s in all_samples():
        t0 = time.perf_counter()
        prepared = preprocess.prepare(s.image)
        page, meta = engine.extract_page(prepared, 1, precision)
        doc = ExtractedDocument(pages=[page], title=meta.get("title"))
        secs = time.perf_counter() - t0
        cands = output_lines(doc)
        text_acc = sum(best_line_match(l, cands) for l in s.lines) / len(s.lines)
        row = {
            "sample": s.name,
            "quality": s.quality,
            "text_accuracy": round(text_acc, 3),
            "table_cells": round(table_cell_accuracy(s.table, doc), 3) if s.table else None,
            "numbers": round(number_accuracy(s, doc), 3),
            "seconds": round(secs, 1),
            "steps": prepared.steps,
        }
        rows.append(row)
        if save:
            out_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / f"{s.name}.json").write_text(doc.model_dump_json(indent=2))
            for fmt in ("xlsx", "docx", "pdf"):
                data, _, ext = export(doc, fmt)
                (out_dir / f"{s.name}.{ext}").write_bytes(data)
        print(f"{s.name:28} {s.quality:7} text {row['text_accuracy']:.1%}  "
              f"cells {'-' if row['table_cells'] is None else format(row['table_cells'], '.1%'):>6}  "
              f"numbers {row['numbers']:.1%}  {secs:5.1f}s", flush=True)
    return rows


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", default="tesseract", choices=["tesseract", "claude", "auto"])
    ap.add_argument("--precision", default="high", choices=["fast", "high", "max"])
    ap.add_argument("--save", action="store_true", help="write JSON/XLSX/DOCX/PDF outputs to tests/output/")
    args = ap.parse_args()
    results = run(args.engine, args.precision, args.save)
    if args.save:
        p = Path(__file__).parent / "output" / f"benchmark_{args.engine}_{args.precision}.json"
        p.write_text(json.dumps(results, indent=2))
