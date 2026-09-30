"""Engine-neutral document model.

Every OCR engine produces an ``ExtractedDocument``; every exporter consumes one.
The same structure is sent to the browser, edited there, and posted back for export,
so what the user sees in the preview is exactly what lands in the file.
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

BlockType = Literal["heading", "paragraph", "list", "table", "key_value", "checkbox", "signature", "figure"]


class Cell(BaseModel):
    text: str = ""
    uncertain: bool = False
    struck: bool = False  # crossed out on the original


class KeyValue(BaseModel):
    key: str = ""
    value: str = ""
    uncertain: bool = False


class Block(BaseModel):
    type: BlockType
    text: Optional[str] = None  # heading / paragraph / checkbox label / signature / figure description
    level: Optional[int] = None  # heading level 1-3
    items: Optional[list[str]] = None  # list items
    ordered: Optional[bool] = None  # numbered list?
    rows: Optional[list[list[Cell]]] = None  # table grid, row-major, rectangular
    header_rows: Optional[int] = None  # how many leading rows are headers
    pairs: Optional[list[KeyValue]] = None  # form fields
    checked: Optional[bool] = None  # checkbox state
    uncertain: bool = False  # any part of this block was hard to read
    confidence: Optional[float] = None  # 0..1, engine's own estimate

    def normalized(self) -> "Block":
        """Make tables rectangular so every exporter can rely on it."""
        if self.type == "table" and self.rows:
            width = max(len(r) for r in self.rows)
            self.rows = [r + [Cell() for _ in range(width - len(r))] for r in self.rows]
            self.header_rows = max(0, min(self.header_rows or 0, len(self.rows)))
        return self


class Page(BaseModel):
    page_number: int = 1
    blocks: list[Block] = Field(default_factory=list)
    notes: Optional[str] = None  # engine remarks, e.g. "bottom-right corner is torn"


class ExtractedDocument(BaseModel):
    title: Optional[str] = None
    language: Optional[str] = None
    handwritten: Optional[bool] = None
    pages: list[Page] = Field(default_factory=list)

    def tables(self) -> list[tuple[int, int, Block]]:
        """(page_number, index_on_page, block) for every table in the document."""
        out = []
        for page in self.pages:
            n = 0
            for block in page.blocks:
                if block.type == "table" and block.rows:
                    n += 1
                    out.append((page.page_number, n, block))
        return out

    def plain_text(self) -> str:
        return "\n\n".join(block_to_text(b) for p in self.pages for b in p.blocks).strip()


def block_to_text(b: Block) -> str:
    if b.type == "heading":
        return b.text or ""
    if b.type == "list":
        return "\n".join(
            (f"{i}. " if b.ordered else "• ") + item for i, item in enumerate(b.items or [], 1)
        )
    if b.type == "table":
        return "\n".join("\t".join(c.text for c in row) for row in (b.rows or []))
    if b.type == "key_value":
        return "\n".join(f"{kv.key}: {kv.value}" for kv in (b.pairs or []))
    if b.type == "checkbox":
        return f"[{'x' if b.checked else ' '}] {b.text or ''}"
    if b.type == "signature":
        return f"(signature) {b.text or ''}".strip()
    if b.type == "figure":
        return f"(figure) {b.text or ''}".strip()
    return b.text or ""
