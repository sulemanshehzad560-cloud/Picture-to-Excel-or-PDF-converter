"""Image clean-up that makes faint strokes, decimal points and small dots survive OCR.

Pipeline: EXIF orientation -> page detection + perspective flattening -> shadow removal
-> deskew -> contrast (CLAHE) -> gentle denoise -> upscale small images.
Each step is conservative: if it can't find what it needs it leaves the image alone.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image, ImageOps

MIN_LONG_SIDE = 2000  # upscale below this so a pen dot spans several pixels
MAX_LONG_SIDE = 4200  # cap memory/time on 48MP phone photos


@dataclass
class Prepared:
    original: np.ndarray  # BGR, orientation-corrected
    enhanced: np.ndarray  # grayscale, cleaned, full resolution
    binary: np.ndarray  # black text on white, for classic OCR
    steps: list[str]


def load_image(data: bytes) -> np.ndarray:
    try:
        img = Image.open(io.BytesIO(data))
    except Exception as exc:  # noqa: BLE001 - surface a friendly message
        raise ValueError("Unsupported or corrupt image file") from exc
    img = ImageOps.exif_transpose(img)
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
        img = Image.alpha_composite(bg, img)
    img = img.convert("RGB")
    return cv2.cvtColor(np.asarray(img), cv2.COLOR_RGB2BGR)


def _resize_long(img: np.ndarray, target: int, allow_up: bool = True) -> np.ndarray:
    h, w = img.shape[:2]
    scale = target / max(h, w)
    if scale == 1 or (scale > 1 and not allow_up):
        return img
    interp = cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA
    return cv2.resize(img, (round(w * scale), round(h * scale)), interpolation=interp)


def _order_corners(pts: np.ndarray) -> np.ndarray:
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).ravel()
    return np.array([pts[np.argmin(s)], pts[np.argmin(d)], pts[np.argmax(s)], pts[np.argmax(d)]], dtype=np.float32)


def flatten_page(img: np.ndarray) -> tuple[np.ndarray, bool]:
    """Find the sheet of paper in a photo and warp it to a flat rectangle."""
    h, w = img.shape[:2]
    small_scale = 800 / max(h, w)
    small = cv2.resize(img, None, fx=small_scale, fy=small_scale, interpolation=cv2.INTER_AREA)
    gray = cv2.GaussianBlur(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), (5, 5), 0)
    edges = cv2.dilate(cv2.Canny(gray, 50, 150), np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    area_total = small.shape[0] * small.shape[1]
    for c in sorted(contours, key=cv2.contourArea, reverse=True)[:5]:
        area = cv2.contourArea(c)
        # A real sheet in a photo: big, but not the whole frame (which is just the image border).
        if not 0.25 * area_total < area < 0.97 * area_total:
            continue
        approx = cv2.approxPolyDP(c, 0.02 * cv2.arcLength(c, True), True)
        if len(approx) != 4 or not cv2.isContourConvex(approx):
            continue
        quad = _order_corners(approx.reshape(4, 2).astype(np.float32) / small_scale)
        tl, tr, br, bl = quad
        width = int(max(np.linalg.norm(br - bl), np.linalg.norm(tr - tl)))
        height = int(max(np.linalg.norm(tr - br), np.linalg.norm(tl - bl)))
        if width < 200 or height < 200:
            continue
        dst = np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], dtype=np.float32)
        m = cv2.getPerspectiveTransform(quad, dst)
        flat = cv2.warpPerspective(img, m, (width, height), flags=cv2.INTER_CUBIC)
        # Trim a hair off each edge so no sliver of desk survives as a fake ruled line.
        my, mx = max(2, height // 80), max(2, width // 80)
        return flat[my:height - my, mx:width - mx], True
    return img, False


def remove_shadows(gray: np.ndarray) -> np.ndarray:
    """Divide by an estimate of the paper background: evens out phone-flash hot spots and shadows."""
    k = max(15, (min(gray.shape) // 30) | 1)
    bg = cv2.medianBlur(cv2.dilate(gray, np.ones((7, 7), np.uint8)), k)
    return cv2.normalize(cv2.divide(gray, bg, scale=255), None, 0, 255, cv2.NORM_MINMAX)


def estimate_skew(gray: np.ndarray) -> float:
    """Angle in degrees to pass to rotate() so text lines become horizontal (within +-15)."""
    small = _resize_long(gray, 1200)
    bw = cv2.threshold(small, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
    # Smear characters into line-shaped blobs, then measure their orientation.
    blobs = cv2.dilate(bw, cv2.getStructuringElement(cv2.MORPH_RECT, (25, 3)))
    contours, _ = cv2.findContours(blobs, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    angles, weights = [], []
    for c in contours:
        (_, _), (w, h), a = cv2.minAreaRect(c)
        if w < h:
            w, h = h, w
            a += 90
        if w < 60 or w < 3 * h:
            continue
        a = ((a + 90) % 180) - 90
        if abs(a) <= 15:
            angles.append(a)
            weights.append(w)
    if len(angles) < 3:
        return 0.0
    order = np.argsort(angles)
    cum = np.cumsum(np.asarray(weights)[order])
    median = float(np.asarray(angles)[order][np.searchsorted(cum, cum[-1] / 2)])
    return median


def rotate(img: np.ndarray, angle: float) -> np.ndarray:
    h, w = img.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    cos, sin = abs(m[0, 0]), abs(m[0, 1])
    nw, nh = int(h * sin + w * cos), int(h * cos + w * sin)
    m[0, 2] += nw / 2 - w / 2
    m[1, 2] += nh / 2 - h / 2
    border = 255 if img.ndim == 2 else (255, 255, 255)
    return cv2.warpAffine(img, m, (nw, nh), flags=cv2.INTER_CUBIC, borderValue=border)


def estimate_noise(gray: np.ndarray) -> float:
    """Relative noise level from the median absolute Laplacian (robust to text edges); ~0-3 is clean."""
    lap = cv2.Laplacian(gray.astype(np.float32), cv2.CV_32F)
    return float(np.median(np.abs(lap)) * 1.4826 / 2.83)


def prepare(data: bytes, enhance: bool = True) -> Prepared:
    original = load_image(data)
    steps: list[str] = []
    img = _resize_long(original, MAX_LONG_SIDE, allow_up=False)
    if enhance:
        img, flat = flatten_page(img)
        if flat:
            steps.append("page flattened")
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    if enhance:
        # Denoise first, at native resolution: upscaling or contrast-boosting noise only amplifies it.
        # Strength follows the measured noise, so clean scans keep every faint dot untouched.
        sigma = estimate_noise(gray)
        if sigma > 2.5:
            h = float(min(28.0, max(6.0, 1.6 * sigma)))
            gray = cv2.fastNlMeansDenoising(gray, None, h=h, templateWindowSize=7, searchWindowSize=21)
            steps.append(f"denoised (noise level {sigma:.0f})")
        gray = remove_shadows(gray)
        steps.append("shadows removed")
        angle = estimate_skew(gray)
        if abs(angle) > 0.3:
            gray = rotate(gray, angle)
            steps.append(f"deskewed {angle:+.1f}°")
    if max(gray.shape[:2]) < MIN_LONG_SIDE:
        gray = _resize_long(gray, MIN_LONG_SIDE)
        steps.append("upscaled for small details")
    if enhance:
        gray = cv2.createCLAHE(clipLimit=1.6, tileGridSize=(8, 8)).apply(gray)
        steps.append("faint ink boosted")
    block = max(15, (min(gray.shape) // 60) | 1)
    # A light median before thresholding drops paper-grain specks that classic OCR reads as letters.
    binary = cv2.adaptiveThreshold(cv2.medianBlur(gray, 3), 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                   cv2.THRESH_BINARY, block, 15)
    return Prepared(original=original, enhanced=gray, binary=binary, steps=steps)


def encode_png(img: np.ndarray, long_side: int | None = None) -> bytes:
    if long_side:
        img = _resize_long(img, long_side, allow_up=False)
    ok, buf = cv2.imencode(".png", img)
    if not ok:
        raise ValueError("Could not encode image")
    return buf.tobytes()


def encode_jpeg(img: np.ndarray, long_side: int | None = None, quality: int = 90) -> bytes:
    if long_side:
        img = _resize_long(img, long_side, allow_up=False)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise ValueError("Could not encode image")
    return buf.tobytes()


def tiles(img: np.ndarray, grid: int, overlap: float = 0.12) -> list[tuple[str, np.ndarray]]:
    """Split into grid x grid overlapping zoomed crops so a vision model sees fine detail.

    Overlap keeps a word cut by one tile boundary whole in the neighbouring tile.
    """
    if grid <= 1:
        return []
    h, w = img.shape[:2]
    th, tw = h / grid, w / grid
    oy, ox = th * overlap, tw * overlap
    out = []
    for r in range(grid):
        for c in range(grid):
            y0, y1 = int(max(0, r * th - oy)), int(min(h, (r + 1) * th + oy))
            x0, x1 = int(max(0, c * tw - ox)), int(min(w, (c + 1) * tw + ox))
            vert = ["top", "middle", "bottom"][r] if grid == 3 else ["top", "bottom"][r]
            horiz = ["left", "centre", "right"][c] if grid == 3 else ["left", "right"][c]
            out.append((f"{vert}-{horiz}", img[y0:y1, x0:x1]))
    return out
