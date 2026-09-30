"""Synthetic test documents with known ground truth, from pristine to terrible.

Handwriting is simulated with handwriting fonts plus per-word jitter (baseline wobble,
rotation, size and ink variation), then degraded like a real phone photo: perspective,
rotation, shadows, blur, noise, low contrast and JPEG artefacts.

Fonts are looked up in $HANDWRITING_FONTS (a directory of .ttf files). Without it we
fall back to DejaVu, which still exercises every degradation.
"""

from __future__ import annotations

import io
import math
import os
import random
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

FONT_DIR = Path(os.environ.get("HANDWRITING_FONTS", "/tmp/claude-0/fonts"))
FALLBACK = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
PRINTED = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def font_path(name: str) -> str:
    p = FONT_DIR / f"{name}.ttf"
    return str(p) if p.exists() else FALLBACK


@dataclass
class Sample:
    name: str
    quality: str  # good | medium | bad | worst
    image: bytes
    lines: list[str] = field(default_factory=list)  # ground-truth text lines (non-table)
    table: list[list[str]] | None = None  # ground-truth table


class Canvas:
    def __init__(self, w=1700, h=2200, paper=(250, 248, 240), ruled=False, seed=0):
        self.img = Image.new("RGB", (w, h), paper)
        self.draw = ImageDraw.Draw(self.img)
        self.rng = random.Random(seed)
        if ruled:
            for y in range(180, h - 80, 64):
                self.draw.line([(60, y), (w - 60, y)], fill=(170, 195, 230), width=2)
            self.draw.line([(150, 0), (150, h)], fill=(235, 150, 150), width=2)

    def hand(self, xy, text, font: str, size=54, ink=(20, 30, 90), jitter=1.0):
        """Draw text word by word with human-like wobble."""
        x, y = xy
        for word in text.split(" "):
            s = int(size * (1 + self.rng.uniform(-0.06, 0.06) * jitter))
            f = ImageFont.truetype(font, s)
            bbox = f.getbbox(word)
            ww, wh = bbox[2] + 8, bbox[3] + 18
            layer = Image.new("RGBA", (ww, wh), (0, 0, 0, 0))
            shade = tuple(max(0, min(255, c + self.rng.randint(-15, 15))) for c in ink)
            ImageDraw.Draw(layer).text((2, 2), word, font=f, fill=shade + (255,))
            layer = layer.rotate(self.rng.uniform(-3, 3) * jitter, resample=Image.BICUBIC, expand=True)
            dy = int(self.rng.uniform(-5, 5) * jitter)
            self.img.paste(layer, (int(x), int(y + dy)), layer)
            x += ww + f.getlength(" ") * self.rng.uniform(0.8, 1.3)
        return x

    def text(self, xy, text, size=40, font=PRINTED, fill=(15, 15, 15)):
        self.draw.text(xy, text, font=ImageFont.truetype(font, size), fill=fill)

    def grid(self, x0, y0, col_w: list[int], row_h: int, rows: int, color=(40, 40, 40), width=3):
        xs = [x0]
        for w in col_w:
            xs.append(xs[-1] + w)
        for r in range(rows + 1):
            self.draw.line([(x0, y0 + r * row_h), (xs[-1], y0 + r * row_h)], fill=color, width=width)
        for x in xs:
            self.draw.line([(x, y0), (x, y0 + rows * row_h)], fill=color, width=width)
        return xs


# ---------------- degradations ----------------

def to_cv(img: Image.Image) -> np.ndarray:
    return cv2.cvtColor(np.asarray(img), cv2.COLOR_RGB2BGR)


def photo(page: np.ndarray, rng: random.Random, tilt=8.0, persp=0.06, bg=(40, 45, 50)) -> np.ndarray:
    """Place the sheet on a desk, photographed at an angle."""
    h, w = page.shape[:2]
    pad = int(0.12 * max(h, w))
    canvas = np.full((h + 2 * pad, w + 2 * pad, 3), bg, np.uint8)
    noise = np.random.default_rng(rng.randint(0, 10**6)).normal(0, 6, canvas.shape)
    canvas = np.clip(canvas + noise, 0, 255).astype(np.uint8)
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    j = lambda: rng.uniform(-persp, persp) * w  # noqa: E731
    dst = np.float32([[pad + j(), pad + j()], [pad + w + j(), pad + j()], [pad + w + j(), pad + h + j()], [pad + j(), pad + h + j()]])
    m = cv2.getPerspectiveTransform(src, dst)
    warped = cv2.warpPerspective(page, m, (canvas.shape[1], canvas.shape[0]))
    mask = cv2.warpPerspective(np.full((h, w), 255, np.uint8), m, (canvas.shape[1], canvas.shape[0]))
    canvas[mask > 0] = warped[mask > 0]
    rot = cv2.getRotationMatrix2D((canvas.shape[1] / 2, canvas.shape[0] / 2), tilt, 1.0)
    return cv2.warpAffine(canvas, rot, (canvas.shape[1], canvas.shape[0]), borderValue=bg)


def shadow(img: np.ndarray, strength=0.45) -> np.ndarray:
    h, w = img.shape[:2]
    xx = np.linspace(0, 1, w)[None, :]
    yy = np.linspace(0, 1, h)[:, None]
    grad = 1 - strength * np.clip(1.3 * xx * 0.7 + yy * 0.5 - 0.2, 0, 1)
    return np.clip(img * grad[..., None], 0, 255).astype(np.uint8)


def degrade(img: np.ndarray, rng: random.Random, blur=0.0, noise=0.0, contrast=1.0, jpeg=95, scale=1.0) -> np.ndarray:
    if scale != 1.0:
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    if blur:
        k = int(blur * 2) * 2 + 1
        img = cv2.GaussianBlur(img, (k, k), blur)
    if contrast != 1.0:
        img = np.clip((img.astype(np.float32) - 128) * contrast + 128 + 30 * (1 - contrast), 0, 255).astype(np.uint8)
    if noise:
        n = np.random.default_rng(rng.randint(0, 10**6)).normal(0, noise, img.shape)
        img = np.clip(img + n, 0, 255).astype(np.uint8)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, jpeg])
    return cv2.imdecode(buf, cv2.IMREAD_COLOR)


def encode(img: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", img)
    return buf.tobytes()


# ---------------- documents ----------------

NOTE_LINES = [
    "Meeting notes 14/03/2025",
    "Call Sarah about the invoice #4471.",
    "Budget approved: $12,450.75 total.",
    "Next review on Friday at 3:30 pm.",
    "Order 0.5 kg of zinc, 2.25 m of wire.",
]

TABLE = [
    ["Item", "Qty", "Price", "Total"],
    ["Pencils", "12", "0.75", "9.00"],
    ["Notebook A4", "3", "4.20", "12.60"],
    ["Glue stick", "5", "1.10", "5.50"],
    ["Stapler", "1", "15.99", "15.99"],
    ["Sum", "", "", "43.09"],
]

FORM = [("Name", "John A. Carter"), ("Date", "02.11.2024"), ("Phone", "0301-555-0192"), ("Amount", "1,250.00")]


def printed_invoice() -> Sample:
    c = Canvas(seed=1)
    c.text((140, 120), "INVOICE", size=72)
    y = 260
    for k, v in FORM:
        c.text((140, y), f"{k}: {v}", size=40)
        y += 70
    xs = c.grid(140, 620, [560, 200, 260, 260], 90, len(TABLE))
    for r, row in enumerate(TABLE):
        for ci, cell in enumerate(row):
            c.text((xs[ci] + 18, 620 + r * 90 + 22), cell, size=38)
    img = to_cv(c.img)
    return Sample("printed_invoice", "good", encode(img), [f"{k}: {v}" for k, v in FORM], TABLE)


def neat_note() -> Sample:
    c = Canvas(ruled=True, seed=2)
    y = 180 - 60
    for line in NOTE_LINES:
        c.hand((180, y), line, font_path("Caveat"), size=60, jitter=0.6)
        y += 128
    return Sample("neat_handwritten_note", "good", encode(to_cv(c.img)), NOTE_LINES)


def handwritten_table(font="IndieFlower", quality="medium", seed=3, **deg) -> Sample:
    c = Canvas(seed=seed)
    c.hand((140, 110), "Stationery order", font_path(font), size=70, jitter=0.8)
    xs = c.grid(140, 280, [560, 200, 260, 260], 110, len(TABLE), color=(30, 30, 60), width=4)
    for r, row in enumerate(TABLE):
        for ci, cell in enumerate(row):
            if cell:
                c.hand((xs[ci] + 22, 280 + r * 110 + 18), cell, font_path(font), size=58, jitter=1.0)
    img = to_cv(c.img)
    rng = random.Random(seed)
    if deg.pop("photo", False):
        img = photo(img, rng, tilt=deg.pop("tilt", 4), persp=deg.pop("persp", 0.03))
    if deg.pop("shadow", False):
        img = shadow(img)
    img = degrade(img, rng, **deg)
    return Sample(f"handwritten_table_{quality}", quality, encode(img), ["Stationery order"], TABLE)


def messy_note(quality="bad", font="ReenieBeanie", seed=4, **deg) -> Sample:
    c = Canvas(ruled=True, seed=seed, paper=(245, 240, 225))
    y = 180 - 64
    for line in NOTE_LINES:
        c.hand((175 + c.rng.randint(-10, 25), y), line, font_path(font), size=66, ink=(25, 25, 40), jitter=1.8)
        y += 128
    img = to_cv(c.img)
    rng = random.Random(seed)
    if deg.pop("photo", True):
        img = photo(img, rng, tilt=deg.pop("tilt", 7), persp=deg.pop("persp", 0.05))
    if deg.pop("shadow", True):
        img = shadow(img)
    img = degrade(img, rng, **deg)
    return Sample(f"messy_note_{quality}", quality, encode(img), NOTE_LINES)


def all_samples() -> list[Sample]:
    return [
        printed_invoice(),
        neat_note(),
        handwritten_table("Caveat", "good", seed=5),
        handwritten_table("IndieFlower", "medium", seed=6, photo=True, tilt=3, blur=0.8, noise=6, jpeg=80),
        handwritten_table("HomemadeApple", "bad", seed=7, photo=True, tilt=6, shadow=True, blur=1.2, noise=10,
                          contrast=0.65, jpeg=60),
        messy_note("bad", "ReenieBeanie", seed=8, blur=1.0, noise=8, jpeg=70),
        messy_note("worst", "DawningofaNewDay", seed=9, tilt=11, persp=0.08, blur=1.8, noise=16, contrast=0.5,
                   jpeg=40, scale=0.45),
    ]


if __name__ == "__main__":
    out = Path(__file__).parent / "output" / "samples"
    out.mkdir(parents=True, exist_ok=True)
    for s in all_samples():
        (out / f"{s.name}.png").write_bytes(s.image)
        print("wrote", out / f"{s.name}.png")
