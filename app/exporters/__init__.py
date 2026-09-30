"""Turn an ExtractedDocument into the file format the user picked."""

from __future__ import annotations

import csv
import io
import zipfile

from ..schema import ExtractedDocument, block_to_text
from .excel import to_xlsx
from .pdf import to_pdf
from .word import to_docx

FORMATS = {
    "xlsx": ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", to_xlsx),
    "docx": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", to_docx),
    "pdf": ("application/pdf", to_pdf),
}


def to_csv(doc: ExtractedDocument) -> tuple[bytes, str, str]:
    """One CSV for a single table; a zip of CSVs for several; text lines if there is no table."""
    tables = doc.tables()

    def render(rows: list[list[str]]) -> bytes:
        buf = io.StringIO()
        csv.writer(buf).writerows(rows)
        return ("\ufeff" + buf.getvalue()).encode("utf-8")  # BOM so Excel opens UTF-8 correctly

    if not tables:
        return render([[line] for line in doc.plain_text().splitlines()]), "text/csv", "csv"
    if len(tables) == 1:
        return render([[c.text for c in r] for r in tables[0][2].rows]), "text/csv", "csv"
    zbuf = io.BytesIO()
    with zipfile.ZipFile(zbuf, "w", zipfile.ZIP_DEFLATED) as z:
        for page, n, block in tables:
            z.writestr(f"page{page}_table{n}.csv", render([[c.text for c in r] for r in block.rows]))
    return zbuf.getvalue(), "application/zip", "zip"


def to_markdown(doc: ExtractedDocument) -> str:
    out = []
    if doc.title:
        out.append(f"# {doc.title}\n")
    for page in doc.pages:
        if len(doc.pages) > 1:
            out.append(f"<!-- page {page.page_number} -->")
        for b in page.blocks:
            if b.type == "heading":
                out.append("#" * min(6, (b.level or 1) + (1 if doc.title else 0)) + " " + (b.text or ""))
            elif b.type == "table" and b.rows:
                hdr = max(1, b.header_rows or 0)
                esc = lambda s: s.replace("|", "\\|").replace("\n", "<br>")  # noqa: E731
                rows = [[esc(c.text) + (" ⚠" if c.uncertain else "") for c in r] for r in b.rows]
                out.append("| " + " | ".join(rows[0]) + " |")
                out.append("|" + "---|" * len(rows[0]))
                for r in rows[1:] if hdr else rows:
                    out.append("| " + " | ".join(r) + " |")
            elif b.type == "key_value":
                out.extend(f"- **{kv.key}:** {kv.value}" for kv in b.pairs or [])
            else:
                out.append(block_to_text(b))
            out.append("")
    return "\n".join(out).strip() + "\n"


def export(doc: ExtractedDocument, fmt: str) -> tuple[bytes, str, str]:
    """Return (bytes, media type, file extension)."""
    for page in doc.pages:
        page.blocks = [b.normalized() for b in page.blocks]
    if fmt in FORMATS:
        media, fn = FORMATS[fmt]
        return fn(doc), media, fmt
    if fmt == "csv":
        return to_csv(doc)
    if fmt == "json":
        return doc.model_dump_json(indent=2).encode(), "application/json", "json"
    if fmt == "txt":
        return doc.plain_text().encode("utf-8"), "text/plain; charset=utf-8", "txt"
    if fmt == "md":
        return to_markdown(doc).encode("utf-8"), "text/markdown; charset=utf-8", "md"
    raise ValueError(f"Unknown format: {fmt}")


__all__ = ["export", "to_csv", "to_markdown", "to_xlsx", "to_docx", "to_pdf"]
