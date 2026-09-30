"""Claude vision engine: reads handwriting, messy scans, forms and tables.

Precision comes from three things:
  1. the page is sent twice: a full overview for layout, plus overlapping zoomed tiles so
     small marks (decimal points, dots on i/j, commas, minus signs) are several pixels wide
     even after the API's own downscaling;
  2. a strict transcription prompt (no spell-correction, no guessing, flag doubt);
  3. in "max" precision, a second proof-reading pass that checks the draft against the image.
"""

from __future__ import annotations

import base64
import json
import os
from typing import Optional

import anthropic

from .. import preprocess
from ..schema import Page
from .base import Engine, EngineError

MODEL = os.environ.get("SCANNER_MODEL", "claude-opus-5-5")
OVERVIEW_LONG_SIDE = 1568  # Claude's native long edge; larger images are downscaled server-side
TILE_LONG_SIDE = 1568

PRECISION = {
    #          tiles grid, effort,  proof-read pass
    "fast": (1, "medium", False),
    "high": (2, "high", False),
    "max": (3, "xhigh", True),
}

SYSTEM_PROMPT = """You are a forensic-grade document transcription engine. You receive photos or scans of a \
single document page: printed, handwritten (neat or very messy), or mixed; forms, tables, receipts, notes, \
ledgers, letters, whiteboards.

Your job is to reproduce the page's content EXACTLY as written, in reading order, as structured blocks.

Transcription rules:
- Copy characters exactly. Never fix spelling, grammar, casing, arithmetic or dates. Keep abbreviations, \
currency symbols, units, leading zeros and trailing zeros exactly as written.
- Every small mark matters: decimal points vs commas, dots on i and j, periods at line ends, colons, hyphens, \
minus signs, apostrophes, degree signs, superscripts, bullets. Zoom into the tiles to confirm each one.
- Distinguish look-alikes carefully using context and the writer's other letters: 0/O/o, 1/l/I/7, 5/S, \
2/Z, 8/B, 6/b, 9/g/q, u/v, rn/m, cl/d.
- Crossed-out text: omit it unless nothing replaces it; then write it as ~~text~~.
- Text inserted with a caret or written above a line belongs where the writer indicated.
- Illegible content: transcribe your best reading and mark it uncertain. If truly unreadable write [illegible]. \
Never invent content that is not on the page.
- Set "uncertain": true on any cell, pair or block containing a reading you are not sure of.

Structure rules:
- Anything laid out in rows and columns (ruled or not, including lists of items with amounts) is a "table". \
Keep every row and column, including empty cells (""), so the grid is rectangular. Header rows go first and \
"header_rows" says how many. For a merged cell, put the text in its first cell and "" in the rest.
- Label/value fields ("Name: ____") are "key_value" pairs; a blank field has value "".
- Tick boxes are "checkbox" blocks with "checked".
- Titles are "heading" (level 1-3), running text is "paragraph" (keep the writer's line breaks with \\n only when \
they are meaningful, e.g. addresses or poems), bulleted/numbered lines are "list".
- Signatures: "signature" block, text = the legible name or "".
- Drawings, stamps, logos, charts: "figure" block with a short description in brackets.
- The tiles are zoomed, overlapping crops of the SAME page. Use them for detail only; do not duplicate content \
that appears in several tiles.
- "confidence" is your 0-1 estimate for the block. Put anything noteworthy about page condition in "notes"."""

PROOFREAD_PROMPT = """Below is a draft transcription of this page. Proof-read it against the images character by \
character, especially numbers, punctuation, decimal points and small dots, and every item marked uncertain. \
Fix any misread character, missing or extra row/column, wrong cell alignment or missing text. Keep everything \
that is already correct unchanged. Return the complete corrected transcription.

DRAFT:
"""

_NULLABLE_STR = {"type": ["string", "null"]}
_CELL = {
    "type": "object",
    "properties": {"text": {"type": "string"}, "uncertain": {"type": "boolean"}},
    "required": ["text", "uncertain"],
    "additionalProperties": False,
}
_PAIR = {
    "type": "object",
    "properties": {"key": {"type": "string"}, "value": {"type": "string"}, "uncertain": {"type": "boolean"}},
    "required": ["key", "value", "uncertain"],
    "additionalProperties": False,
}
_BLOCK = {
    "type": "object",
    "properties": {
        "type": {
            "type": "string",
            "enum": ["heading", "paragraph", "list", "table", "key_value", "checkbox", "signature", "figure"],
        },
        "text": _NULLABLE_STR,
        "level": {"type": ["integer", "null"]},
        "items": {"type": ["array", "null"], "items": {"type": "string"}},
        "ordered": {"type": ["boolean", "null"]},
        "rows": {"type": ["array", "null"], "items": {"type": "array", "items": _CELL}},
        "header_rows": {"type": ["integer", "null"]},
        "pairs": {"type": ["array", "null"], "items": _PAIR},
        "checked": {"type": ["boolean", "null"]},
        "uncertain": {"type": "boolean"},
        "confidence": {"type": ["number", "null"]},
    },
    "required": [
        "type", "text", "level", "items", "ordered", "rows", "header_rows", "pairs", "checked", "uncertain",
        "confidence",
    ],
    "additionalProperties": False,
}
PAGE_SCHEMA = {
    "type": "object",
    "properties": {
        "title": _NULLABLE_STR,
        "language": _NULLABLE_STR,
        "handwritten": {"type": "boolean"},
        "notes": _NULLABLE_STR,
        "blocks": {"type": "array", "items": _BLOCK},
    },
    "required": ["title", "language", "handwritten", "notes", "blocks"],
    "additionalProperties": False,
}


def _image_block(png_or_jpeg: bytes, media_type: str) -> dict:
    return {
        "type": "image",
        "source": {"type": "base64", "media_type": media_type, "data": base64.standard_b64encode(png_or_jpeg).decode()},
    }


class ClaudeEngine(Engine):
    name = "claude"
    label = "Claude AI vision (handwriting-grade)"

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key

    @staticmethod
    def configured() -> bool:
        return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))

    def available(self) -> bool:
        return bool(self.api_key) or self.configured()

    def _client(self) -> anthropic.Anthropic:
        return anthropic.Anthropic(api_key=self.api_key) if self.api_key else anthropic.Anthropic()

    def _images(self, prepared: preprocess.Prepared, grid: int) -> list[dict]:
        content: list[dict] = [
            {"type": "text", "text": "Full page (original colours):"},
            _image_block(preprocess.encode_jpeg(prepared.original, OVERVIEW_LONG_SIDE, 92), "image/jpeg"),
        ]
        if grid > 1:
            content.append({"type": "text", "text": "Full page (contrast-enhanced, flattened):"})
            content.append(_image_block(preprocess.encode_png(prepared.enhanced, OVERVIEW_LONG_SIDE), "image/png"))
            for name, tile in preprocess.tiles(prepared.enhanced, grid):
                content.append({"type": "text", "text": f"Zoomed tile: {name}"})
                content.append(_image_block(preprocess.encode_png(tile, TILE_LONG_SIDE), "image/png"))
        return content

    def _call(self, content: list[dict], effort: str) -> dict:
        try:
            with self._client().beta.messages.stream(
                model=MODEL,
                max_tokens=64000,
                system=SYSTEM_PROMPT,
                thinking={"type": "adaptive"},
                output_config={"effort": effort, "format": {"type": "json_schema", "schema": PAGE_SCHEMA}},
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                messages=[{"role": "user", "content": content}],
            ) as stream:
                message = stream.get_final_message()
        except anthropic.AuthenticationError as exc:
            raise EngineError("Claude API key was rejected. Check it in Settings.") from exc
        except anthropic.RateLimitError as exc:
            raise EngineError("Claude API rate limit reached. Wait a moment and try again.") from exc
        except anthropic.APIStatusError as exc:
            raise EngineError(f"Claude API error {exc.status_code}: {exc.message}") from exc
        except anthropic.APIConnectionError as exc:
            raise EngineError("Could not reach the Claude API. Check your network connection.") from exc

        if message.stop_reason == "refusal":
            raise EngineError("Claude declined to transcribe this page.")
        if message.stop_reason == "max_tokens":
            raise EngineError("The page is too long for one pass. Try splitting it into two photos.")
        text = next((b.text for b in message.content if b.type == "text"), None)
        if not text:
            raise EngineError("Claude returned no transcription.")
        return json.loads(text)

    def extract_page(self, prepared: preprocess.Prepared, page_number: int, precision: str = "high") -> tuple[Page, dict]:
        grid, effort, proofread = PRECISION.get(precision, PRECISION["high"])
        content = self._images(prepared, grid)
        content.append({"type": "text", "text": "Transcribe this page."})
        data = self._call(content, effort)
        if proofread:
            content[-1] = {"type": "text", "text": PROOFREAD_PROMPT + json.dumps(data, ensure_ascii=False)}
            data = self._call(content, effort)
        page = Page.model_validate({"page_number": page_number, "blocks": data["blocks"], "notes": data.get("notes")})
        meta = {k: data.get(k) for k in ("title", "language", "handwritten")}
        return page, meta
