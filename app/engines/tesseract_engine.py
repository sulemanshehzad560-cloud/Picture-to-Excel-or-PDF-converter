"""Offline engine built on Tesseract + OpenCV layout analysis.

Works without internet or an API key. Very good on printed/typed pages and ruled tables;
on handwriting it is a best-effort fallback (use the Claude engine for real handwriting).
"""

from __future__ import annotations

import os
import re
import shutil
from dataclasses import dataclass
from statistics import median

import cv2
import numpy as np
import pytesseract

from ..preprocess import Prepared
from ..schema import Block, Cell, KeyValue, Page
from .base import Engine, EngineError

# Tesseract's OpenMP threads thrash badly when several pages run in parallel; one each is far faster.
os.environ.setdefault("OMP_THREAD_LIMIT", "1")

UNCERTAIN_CONF = 70  # Tesseract word confidence (0-100) below which we flag a reading
KV_RE = re.compile(r"^\s*([^:]{1,40}?)\s*[:=]\s*(.*)$")
BULLET_RE = re.compile(r"^\s*(?:[-•*·‣▪–]|\(?\d{1,3}[.)]|[a-zA-Z][.)])\s+")
ORDERED_RE = re.compile(r"^\s*\(?\d{1,3}[.)]\s+")


@dataclass
class Word:
    text: str
    conf: float
    x: int
    y: int
    w: int
    h: int
    line_key: tuple


@dataclass
class Line:
    words: list[Word]

    @property
    def text(self) -> str:
        return " ".join(w.text for w in self.words)

    @property
    def x(self) -> int:
        return min(w.x for w in self.words)

    @property
    def y(self) -> int:
        return min(w.y for w in self.words)

    @property
    def height(self) -> float:
        return median(w.h for w in self.words)

    @property
    def uncertain(self) -> bool:
        return any(w.conf < UNCERTAIN_CONF for w in self.words)

    @property
    def conf(self) -> float:
        return sum(w.conf for w in self.words) / len(self.words) / 100


def _words(img: np.ndarray, psm: int = 3) -> list[Word]:
    data = pytesseract.image_to_data(img, config=f"--oem 1 --psm {psm} -c preserve_interword_spaces=1",
                                     output_type=pytesseract.Output.DICT)
    out = []
    for i, text in enumerate(data["text"]):
        text = text.strip()
        conf = float(data["conf"][i])
        if not text or conf < 0:
            continue
        out.append(Word(text, conf, data["left"][i], data["top"][i], data["width"][i], data["height"][i],
                        (data["block_num"][i], data["par_num"][i], data["line_num"][i])))
    return out


def _lines(words: list[Word]) -> list[Line]:
    groups: dict[tuple, list[Word]] = {}
    for w in words:
        groups.setdefault(w.line_key, []).append(w)
    lines = [Line(sorted(ws, key=lambda w: w.x)) for ws in groups.values()]
    return sorted(lines, key=lambda l: (l.y, l.x))


def _segments(line: Line) -> list[list[Word]]:
    """Split a line where the horizontal gap is much wider than a normal word space."""
    gap_limit = max(2.2 * line.height, 25)
    segs = [[line.words[0]]]
    for prev, cur in zip(line.words, line.words[1:]):
        if cur.x - (prev.x + prev.w) > gap_limit:
            segs.append([])
        segs[-1].append(cur)
    return segs


def _cells_from_segments(rows: list[list[list[Word]]]) -> list[list[Cell]]:
    """Align segments from several lines into shared columns by their x-start."""
    starts = sorted(seg[0].x for row in rows for seg in row)
    tol = max(30, median(w.h for row in rows for seg in row for w in seg) * 2)
    cols: list[float] = []
    for s in starts:
        if not cols or s - cols[-1] > tol:
            cols.append(s)
    grid = []
    for row in rows:
        cells = [Cell() for _ in cols]
        for seg in row:
            idx = min(range(len(cols)), key=lambda i: abs(cols[i] - seg[0].x))
            text = " ".join(w.text for w in seg)
            unc = any(w.conf < UNCERTAIN_CONF for w in seg)
            cells[idx] = Cell(text=(cells[idx].text + " " + text).strip(), uncertain=cells[idx].uncertain or unc)
        grid.append(cells)
    return grid


def _ruled_grid(binary: np.ndarray) -> tuple[list[int], list[int], np.ndarray] | None:
    """Find a table drawn with lines. Returns sorted y and x rule positions, plus the rule mask."""
    inv = 255 - binary
    h, w = inv.shape
    horiz = cv2.morphologyEx(inv, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(40, w // 25), 1)))
    vert = cv2.morphologyEx(inv, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(40, h // 25))))

    def positions(mask: np.ndarray, axis: int, min_len: int) -> list[int]:
        proj = (mask > 0).sum(axis=axis)
        idx = np.where(proj > min_len)[0]
        if not len(idx):
            return []
        groups, cur = [], [idx[0]]
        for i in idx[1:]:
            if i - cur[-1] <= 4:
                cur.append(i)
            else:
                groups.append(cur)
                cur = [i]
        groups.append(cur)
        return [int(np.mean(g)) for g in groups]

    # Keep only the rules belonging to the largest table-like structure, so page borders,
    # underlines and notebook ruling elsewhere on the page don't join the grid.
    both = cv2.dilate(cv2.bitwise_or(horiz, vert), np.ones((5, 5), np.uint8))
    contours, _ = cv2.findContours(both, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    x, y, bw, bh = cv2.boundingRect(max(contours, key=cv2.contourArea))
    region = np.zeros_like(inv)
    region[y:y + bh, x:x + bw] = 255
    horiz = cv2.bitwise_and(horiz, region)
    vert = cv2.bitwise_and(vert, region)
    ys = positions(horiz, 1, max(w // 6, bw // 2))
    xs = positions(vert, 0, max(h // 12, bh // 2))
    if len(ys) < 3 or len(xs) < 3:
        return None
    rules = cv2.dilate(cv2.bitwise_or(horiz, vert), np.ones((5, 5), np.uint8))
    return ys, xs, rules


def _read_cell(gray: np.ndarray) -> tuple[str, float]:
    if gray.size == 0 or gray.shape[0] < 8 or gray.shape[1] < 8:
        return "", 1.0
    padded = cv2.copyMakeBorder(gray, 12, 12, 12, 12, cv2.BORDER_CONSTANT, value=255)
    words = _words(padded, psm=6)
    if not words:
        return "", 1.0
    lines = _lines(words)
    return "\n".join(l.text for l in lines), min(w.conf for w in words)


class TesseractEngine(Engine):
    name = "tesseract"
    label = "Offline OCR (printed text & ruled tables)"

    def available(self) -> bool:
        return shutil.which("tesseract") is not None

    def extract_page(self, prepared: Prepared, page_number: int, precision: str = "high") -> tuple[Page, dict]:
        if not self.available():
            raise EngineError("Tesseract is not installed on the server.")
        binary, gray = prepared.binary, prepared.enhanced
        blocks: list[tuple[int, Block]] = []  # (y position, block) so we can restore reading order
        rest = binary.copy()

        grid = _ruled_grid(binary)
        if grid:
            ys, xs, rules = grid
            clean = gray.copy()
            clean[rules > 0] = 255  # erase ruling so line fragments aren't read as characters
            rows, all_conf = [], []
            for y0, y1 in zip(ys, ys[1:]):
                if y1 - y0 < 12:
                    continue
                row = []
                for x0, x1 in zip(xs, xs[1:]):
                    if x1 - x0 < 12:
                        continue
                    pad = 4
                    text, conf = _read_cell(clean[y0 + pad:y1 - pad, x0 + pad:x1 - pad])
                    all_conf.append(conf)
                    row.append(Cell(text=text, uncertain=bool(text) and conf < UNCERTAIN_CONF))
                if row:
                    rows.append(row)
            if rows:
                blocks.append((ys[0], Block(type="table", rows=rows, header_rows=1,
                                            uncertain=any(c.uncertain for r in rows for c in r),
                                            confidence=round(min(all_conf) / 100, 2)).normalized()))
                rest[max(0, ys[0] - 3):ys[-1] + 3, max(0, xs[0] - 3):xs[-1] + 3] = 255

        candidates = [rest]
        if precision != "fast":
            # Tesseract sometimes reads the greyscale better than our binarisation (faint pencil).
            masked_gray = gray.copy()
            if grid:
                masked_gray[max(0, ys[0] - 3):ys[-1] + 3, max(0, xs[0] - 3):xs[-1] + 3] = 255
            candidates.append(masked_gray)
        best_words: list[Word] = []
        best_score = -1.0
        for img in candidates:
            words = _words(img)
            score = sum(w.conf for w in words) / len(words) * min(1, len(words) / 5) if words else 0
            if score > best_score:
                best_words, best_score = words, score
        blocks.extend(self._layout(_lines(best_words)))

        blocks.sort(key=lambda t: t[0])
        return Page(page_number=page_number, blocks=[b for _, b in blocks]), {}

    def _layout(self, lines: list[Line]) -> list[tuple[int, Block]]:
        if not lines:
            return []
        body_h = median(l.height for l in lines)
        out: list[tuple[int, Block]] = []
        i = 0
        while i < len(lines):
            line = lines[i]
            # Borderless table: >=2 consecutive lines that each split into >=2 wide-gap columns.
            j = i
            while j < len(lines) and len(_segments(lines[j])) >= 2:
                j += 1
            if j - i >= 2:
                chunk = lines[i:j]
                rows = _cells_from_segments([_segments(l) for l in chunk])
                out.append((line.y, Block(type="table", rows=rows, header_rows=1,
                                          uncertain=any(l.uncertain for l in chunk),
                                          confidence=round(min(l.conf for l in chunk), 2)).normalized()))
                i = j
                continue

            text = line.text
            kv = KV_RE.match(text)
            if BULLET_RE.match(text):
                items, ordered, first = [], bool(ORDERED_RE.match(text)), line
                while i < len(lines) and BULLET_RE.match(lines[i].text):
                    items.append(BULLET_RE.sub("", lines[i].text, count=1))
                    i += 1
                out.append((first.y, Block(type="list", items=items, ordered=ordered)))
                continue
            # "at 3:30 pm" is a time, not a form field: reject digit:digit splits.
            if kv and kv.group(1).strip() and not kv.group(1)[-1:].isdigit():
                pairs, first = [], line
                while i < len(lines) and (m := KV_RE.match(lines[i].text)) and not m.group(1)[-1:].isdigit():
                    pairs.append(KeyValue(key=m.group(1).strip(), value=m.group(2).strip(),
                                          uncertain=lines[i].uncertain))
                    i += 1
                out.append((first.y, Block(type="key_value", pairs=pairs, uncertain=any(p.uncertain for p in pairs))))
                continue
            if line.height > 1.45 * body_h and len(text) < 80:
                out.append((line.y, Block(type="heading", text=text, level=1, uncertain=line.uncertain,
                                          confidence=round(line.conf, 2))))
                i += 1
                continue
            # Paragraph: keep adding lines that aren't structurally something else.
            para, first = [line], line
            i += 1
            while i < len(lines):
                nxt = lines[i]
                kv_next = KV_RE.match(nxt.text)
                if (len(_segments(nxt)) >= 2 or BULLET_RE.match(nxt.text) or (kv_next and not kv_next.group(1)[-1:].isdigit())
                        or nxt.height > 1.45 * body_h or nxt.y - (para[-1].y + para[-1].height) > 1.6 * body_h):
                    break
                para.append(nxt)
                i += 1
            out.append((first.y, Block(type="paragraph", text="\n".join(l.text for l in para),
                                       uncertain=any(l.uncertain for l in para),
                                       confidence=round(min(l.conf for l in para), 2))))
        return out
