# OmniScan: handwriting and documents to Excel, Word or PDF

Photograph or upload any page (neat or messy handwriting, forms, ledgers, receipts, tables) and
get it back as **Excel, Word, PDF, CSV, Markdown, text or JSON**. You choose the format.

- **Runs on your phone, offline.** Recognition uses PaddleOCR's PP-OCRv6 neural models on-device
  (ONNX Runtime WebAssembly). No API key, no account, no internet, and nothing is uploaded.
- **Reads messy handwriting.** Neural line recognition plus a second, contrast-enhanced read of
  every doubtful word. A digit-aware correction fixes classic slips ("202s" → "2025",
  "450.7s" → "450.75") and flags each fix.
- **Keeps every mark.** Decimal points, commas, leading zeros and minus signs are copied
  exactly. Empty-looking table cells are checked for ink, so a lone "1" or a dot is not lost.
- **Real structure.** Ruled and borderless tables become spreadsheet cells, numbers stay numbers
  with their exact format (`0.750` stays `0.750`), and IDs like `007` stay text. Form fields
  become Field/Value pairs, and lists, headings and checkboxes are kept.
- **Flags doubt.** Low-confidence readings are highlighted in the app, in Excel (with a cell
  comment), and in Word and PDF.
- **Edit before export.** Tap any cell or line to correct it; every download includes your edits.
- Multi-page scans, camera, gallery and scanned-PDF input, per-page rotation, automatic page
  flattening and straightening, and a history of recent scans (stored on the device only).

## Get the Android app

Every push to `main` builds the app on GitHub and publishes a **Release** with:

- `OmniScan-1.0.N.apk`: install it directly on your phone (allow installs from your browser or
  Files app when Android asks).
- `OmniScan-1.0.N.aab`: upload this to Google Play Console. It is only built once the signing
  secrets below are set.

Publishing on Google Play, step by step: [docs/PLAY_STORE.md](docs/PLAY_STORE.md).
Privacy policy: [PRIVACY.md](PRIVACY.md).

### Signing

Google Play needs the app signed with your **upload key**. Add four repository secrets
(Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `OMNISCAN_KEYSTORE_BASE64` | your upload keystore, base64-encoded |
| `OMNISCAN_KEYSTORE_PASSWORD` | keystore password |
| `OMNISCAN_KEY_ALIAS` | key alias (`omniscan`) |
| `OMNISCAN_KEY_PASSWORD` | key password |

Without them, the workflow still builds a debug-signed APK you can install for personal use.
Never commit a keystore; `*.jks` and `keystore.properties` are git-ignored.

## Develop

```bash
npm install
npm run build        # downloads + verifies the OCR models (PyPI), builds the web app into dist/
npm run dev          # live-reload dev server at http://localhost:5173
npm test             # exporter, layout and end-to-end recognition tests (Node, same WASM engine)

# Android (needs Android Studio / Android SDK)
npx cap sync android
cd android && ./gradlew assembleDebug          # app/build/outputs/apk/debug/app-debug.apk
```

The same web app also runs in any modern browser. `uvicorn app.main:app` serves it together
with an optional Python API. That API offers an extra Claude "AI vision" engine only if
`ANTHROPIC_API_KEY` is set on the server, and the app never needs it.

## How it works

```
photo / PDF ─► flatten page, measure noise ─► detect text lines (PP-OCRv6 DB) ─► deskew (ruled lines or text lines)
            ─► recognise lines (PP-OCRv6 CTC) ─► re-read doubtful lines on an enhanced copy, keep the more confident read
            ─► digit-aware fixes ─► ruled-grid + borderless table / form / list / heading layout ─► edit ─► export
```

| Path | What it does |
|---|---|
| `web/src/ocr/ppocr.js` | Detection, recognition and orientation models: pre/post-processing matching PaddleOCR |
| `web/src/ocr/engine.js` | The page pipeline and the Fast / High / Maximum precision modes |
| `web/src/ocr/layout.js` | Tables (ruled and borderless), form fields, lists, headings, paragraphs, uncertainty |
| `web/src/ocr/preprocess.js` | Page flattening, noise-matched denoise, shadow removal, contrast |
| `web/src/export/` | Excel, Word, PDF, CSV, Markdown, text, JSON: all on-device |
| `web/src/main.js` | The app UI; `platform.js` handles the Android camera and saving/sharing files |
| `android/` | Capacitor Android project (target SDK 36, no INTERNET permission) |
| `scripts/fetch-models.mjs` | Downloads the models from PyPI and checks their SHA-256 hashes |
| `app/` | Optional Python server and API (Claude vision engine and Tesseract, legacy) |

## Accuracy

Synthetic test pages with known correct text, from printed to messy handwriting (`python -m
tests.samples`, then `node scripts/bench.mjs high`). The "messy" pages are clean images
(direct uploads and scanner apps) with hard handwriting: slanted, bouncing baselines, uneven
size, cursive.

| Page | Old engine (Tesseract): text / cells / numbers | OmniScan on-device (High): text / cells / numbers |
|---|---|---|
| Printed invoice | 100% / 100% / 100% | 100% / 100% / 100% |
| Neat handwritten note | 99% / – / 83% | **100% / – / 100%** |
| Handwritten table (photo) | 100% / 33% / 21% | **100% / 100% / 100%** |
| Handwritten table (shadow + blur) | 31% / 8% / 29% | **94% / 75% / 93%** |
| Messy note | 79% / – / 17% | **99% / – / 83%** |
| Slanted scrawl | 40% / – / 0% | **87% / – / 33%** |
| Cursive note (phone photo) | 65% / – / 0% | **99% / – / 100%** |
| Cursive table | 31% / 12% / 7% | **100% / 75% / 86%** |
| Borderless handwritten list | 69% / 0% / 36% | **100% / 96% / 100%** |
| Handwritten form | 69% / – / 33% | **100% / – / 100%** |

*Cells* = table cells reproduced exactly. *Numbers* = every digit, dot and comma exact.
Most remaining misses are ornate cursive capitals (a fancy "T" read as "J"). Where the model
is unsure, the reading is highlighted for you to check.
