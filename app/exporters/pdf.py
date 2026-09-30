from __future__ import annotations

import io
from html import escape
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import ListFlowable, ListItem, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from ..schema import ExtractedDocument

_FONT_CANDIDATES = [
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
    ("C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf"),
    ("/Library/Fonts/Arial Unicode.ttf", "/Library/Fonts/Arial Unicode.ttf"),
]


def _register_font() -> tuple[str, str]:
    """A Unicode TTF so accents, currency symbols and ☑ survive; Helvetica as last resort."""
    for regular, bold in _FONT_CANDIDATES:
        if Path(regular).exists():
            try:
                pdfmetrics.registerFont(TTFont("DocSans", regular))
                pdfmetrics.registerFont(TTFont("DocSans-Bold", bold if Path(bold).exists() else regular))
                return "DocSans", "DocSans-Bold"
            except Exception:  # noqa: BLE001 - try the next candidate
                continue
    return "Helvetica", "Helvetica-Bold"


FONT, FONT_BOLD = _register_font()


def _markup(text: str, uncertain: bool = False) -> str:
    s = escape(text).replace("\n", "<br/>")
    return f'<span backColor="#FFF2A8">{s}</span>' if uncertain and s else s


def to_pdf(doc: ExtractedDocument) -> bytes:
    base = getSampleStyleSheet()
    body = ParagraphStyle("body", parent=base["BodyText"], fontName=FONT, fontSize=10.5, leading=14, alignment=TA_LEFT)
    cell = ParagraphStyle("cell", parent=body, fontSize=9.5, leading=12)
    cell_hdr = ParagraphStyle("cellh", parent=cell, fontName=FONT_BOLD, textColor=colors.white)
    muted = ParagraphStyle("muted", parent=body, textColor=colors.HexColor("#6B7280"), fontSize=9)
    heads = {
        lvl: ParagraphStyle(f"h{lvl}", parent=base[f"Heading{lvl}"], fontName=FONT_BOLD, textColor=colors.HexColor("#111827"))
        for lvl in (1, 2, 3)
    }
    title = ParagraphStyle("title", parent=base["Title"], fontName=FONT_BOLD)

    story = []
    if doc.title:
        story.append(Paragraph(_markup(doc.title), title))
    width = A4[0] - 36 * mm

    for p_i, page in enumerate(doc.pages):
        if p_i:
            story.append(PageBreak())
        for b in page.blocks:
            if b.type == "heading":
                story.append(Paragraph(_markup(b.text or "", b.uncertain), heads[min(3, max(1, b.level or 1))]))
            elif b.type == "paragraph":
                story.append(Paragraph(_markup(b.text or "", b.uncertain), body))
            elif b.type == "list":
                items = [ListItem(Paragraph(_markup(i, b.uncertain), body)) for i in b.items or []]
                story.append(ListFlowable(items, bulletType="1" if b.ordered else "bullet", bulletFontName=FONT))
            elif b.type in ("table", "key_value"):
                hdr = (b.header_rows or 0) if b.type == "table" else 0
                if b.type == "table":
                    raw = [[(c.text, c.uncertain) for c in r] for r in b.rows or []]
                else:
                    raw = [[(kv.key, kv.uncertain), (kv.value, kv.uncertain)] for kv in b.pairs or []]
                if not raw:
                    continue
                data = [[Paragraph(_markup(t, u), cell_hdr if r < hdr else cell) for t, u in row]
                        for r, row in enumerate(raw)]
                ncols = len(raw[0])
                t = Table(data, colWidths=[width / ncols] * ncols, repeatRows=hdr, splitInRow=1)
                style = [
                    ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#B7BDC9")),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("TOPPADDING", (0, 0), (-1, -1), 3),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                ]
                if hdr:
                    style.append(("BACKGROUND", (0, 0), (-1, hdr - 1), colors.HexColor("#1F2A44")))
                if b.type == "key_value":
                    style.append(("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#EEF1F7")))
                t.setStyle(TableStyle(style))
                story.append(t)
            elif b.type == "checkbox":
                story.append(Paragraph(_markup(("☑ " if b.checked else "☐ ") + (b.text or ""), b.uncertain), body))
            elif b.type in ("signature", "figure"):
                label = "Signature: " if b.type == "signature" else ""
                story.append(Paragraph("<i>" + _markup(label + (b.text or "")) + "</i>", muted))
            story.append(Spacer(1, 5))
        if page.notes:
            story.append(Paragraph("<i>Scanner note: " + _markup(page.notes) + "</i>", muted))

    if not story:
        story.append(Paragraph("(no text found)", muted))
    buf = io.BytesIO()
    SimpleDocTemplate(buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm, bottomMargin=16 * mm,
                      title=doc.title or "Scanned document", author="Picture to Excel/PDF converter").build(story)
    return buf.getvalue()
