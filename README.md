# OmniScan: picture → Excel / Word / PDF

Take a photo or scan of **any** document (printed, handwritten, messy, tilted, shadowed) and get the
content back as **Excel, Word, PDF, CSV, Markdown, plain text or JSON**. You choose the format.

- **Reads handwriting.** The AI vision engine (Claude) reads neat and messy handwriting, forms,
  tables, receipts and ledgers. It copies every character exactly: decimal points, commas, leading zeros,
  minus signs. It never spell-corrects or "fixes" numbers.
- **Precision modes.** *High* sends the page plus 4 zoomed, overlapping tiles so single dots stay
  several pixels wide. *Maximum* sends 9 tiles and runs a second proof-reading pass that checks the draft
  against the image, character by character.
- **Flags doubt.** Anything hard to read is marked low-confidence. It is highlighted yellow in the
  preview, in Excel (with a cell comment), and in Word and PDF.
- **Cleans the photo first.** It finds the sheet in the photo and flattens the perspective, removes
  shadows, deskews, denoises according to the measured noise level, and boosts faint ink.
- **Preserves structure.** Tables become real spreadsheet cells (numbers stay numbers, formats keep
  trailing zeros, IDs like `007` stay text). Forms become field/value pairs. Headings, lists, checkboxes
  and signatures are kept.
- **Edit before you download.** Every cell and line in the preview is editable, and downloads include
  your edits.
- **Works offline too.** Without an API key it falls back to Tesseract + OpenCV layout analysis. This
  is excellent for printed pages and ruled tables, but only best-effort for handwriting.
- Multi-page scans (drag to reorder), live camera capture, paste from the clipboard, and a mobile-friendly UI.

## Run it

```bash
# system OCR for the offline engine
sudo apt-get install tesseract-ocr        # macOS: brew install tesseract

pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...        # optional: enables handwriting-grade AI vision
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Open http://localhost:8000. Instead of setting the key on the server, each user can paste their own
key in **Settings** (gear icon). It is stored only in their browser.

The model defaults to `claude-opus-5-5`; override it with `SCANNER_MODEL`.

## How it works

```
photo ─► preprocess.py ─► engine ─► ExtractedDocument (JSON) ─► browser preview / edit ─► exporters
         flatten, denoise,   Claude vision (tiles +            headings, paragraphs,        xlsx, docx, pdf,
         deskew, contrast    strict JSON schema)               lists, tables, forms,        csv, md, txt, json
                             or Tesseract + layout             checkboxes, uncertainty
```

| Path | What it does |
|---|---|
| `app/preprocess.py` | Page detection and perspective flattening, shadow removal, deskew, noise-adaptive denoise, contrast, zoom tiles |
| `app/engines/claude_engine.py` | Vision prompt, strict JSON-schema output, tiles, proof-reading pass, refusal fallback |
| `app/engines/tesseract_engine.py` | Offline OCR: ruled-grid table detection, borderless column tables, forms, lists, headings |
| `app/exporters/` | Excel (typed numbers, frozen headers, highlighted doubts), Word, PDF (Unicode), CSV/zip, Markdown, text, JSON |
| `app/main.py` | `POST /api/extract`, `POST /api/export`, `GET /api/engines` |
| `app/static/` | The web UI (no build step) |

## Tests and accuracy benchmark

```bash
python -m pytest -q                        # 32 tests: exporters, image pipeline, both engines, HTTP API
python -m tests.samples                    # write the synthetic test images to tests/output/samples/
python -m tests.benchmark --save           # score the offline engine on good → worst handwriting
python -m tests.benchmark --engine claude --precision high --save   # score AI vision (needs a key)
```

`tests/samples.py` generates documents with known ground truth, from a clean printed invoice to a
blurred, low-contrast, rotated phone photo of messy handwriting. Handwriting fonts are read from
`$HANDWRITING_FONTS` (e.g. Caveat, Indie Flower, Homemade Apple, Reenie Beanie and Dawning of a New Day
from Google Fonts). Without them the generator falls back to DejaVu Sans.

Offline engine results (Tesseract 5.3, precision *high*):

| Sample | Quality | Text accuracy | Table cells exact | Numbers exact |
|---|---|---|---|---|
| Printed invoice | good | 100% | 100% | 100% |
| Neat handwritten note | good | 99.4% | – | 83% |
| Handwritten table | good | 94% | 62% | 50% |
| Handwritten table, photo | medium | 100% | 33% | 21% |
| Handwritten table, shadow + blur | bad | 31% | 8% | 29% |
| Messy note, photo | bad | 83% | – | 17% |
| Messy note, faint + tiny + blurred | worst | 27% | – | 0% |

These numbers show why the AI vision engine is the default whenever a key is available. Classic OCR
confuses handwritten digits (1→7, 7→2) even when it gets the layout right. Run the Claude benchmark
line above with your key to measure the AI engine on the same pages.
