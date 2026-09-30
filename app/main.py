"""HTTP API + the OmniScan web app.

    npm install && npm run build          # builds the on-device OCR web app into dist/
    uvicorn app.main:app                   # then open http://localhost:8000

The web app does all recognition on the user's device (no key needed). This server adds an
optional "AI vision" engine (Claude) when ANTHROPIC_API_KEY is set, and keeps the JSON API
(/api/extract, /api/export) for scripts and integrations.
"""

from __future__ import annotations

import base64
import re
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import preprocess
from .engines import EngineError, engine_status, pick_engine
from .exporters import export
from .schema import ExtractedDocument

DIST = Path(__file__).resolve().parent.parent / "dist"
MAX_FILES = 30
MAX_BYTES = 40 * 1024 * 1024

app = FastAPI(title="OmniScan: picture to Excel / Word / PDF")


@app.middleware("http")
async def cross_origin_isolation(request, call_next):
    # Lets the in-browser OCR engine use several CPU threads (SharedArrayBuffer).
    response = await call_next(request)
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
    return response


@app.get("/api/engines")
def engines():
    return engine_status()


def _process_one(engine, data: bytes, page_number: int, precision: str, enhance: bool):
    t0 = time.perf_counter()
    prepared = preprocess.prepare(data, enhance=enhance)
    page, meta = engine.extract_page(prepared, page_number, precision)
    preview = base64.b64encode(preprocess.encode_jpeg(prepared.enhanced, 1400, 85)).decode()
    return page, meta, {
        "page": page_number,
        "steps": prepared.steps,
        "seconds": round(time.perf_counter() - t0, 2),
        "enhanced_preview": f"data:image/jpeg;base64,{preview}",
    }


@app.post("/api/extract")
def extract(
    files: list[UploadFile] = File(...),
    engine: str = Form("auto"),
    precision: str = Form("high"),
    enhance: bool = Form(True),
    x_anthropic_key: Optional[str] = Header(default=None),
):
    if not files:
        raise HTTPException(400, "Add at least one image.")
    if len(files) > MAX_FILES:
        raise HTTPException(400, f"At most {MAX_FILES} pages per scan.")
    if precision not in ("fast", "high", "max"):
        raise HTTPException(400, "precision must be fast, high or max")
    blobs = []
    for f in files:
        data = f.file.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise HTTPException(413, f"{f.filename} is larger than 40 MB.")
        blobs.append(data)

    try:
        chosen = pick_engine(engine, x_anthropic_key or None)
    except EngineError as exc:
        raise HTTPException(400, str(exc)) from exc

    t0 = time.perf_counter()
    try:
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda args: _process_one(chosen, *args, precision, enhance),
                                    [(data, i) for i, data in enumerate(blobs, 1)]))
    except EngineError as exc:
        raise HTTPException(502, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    doc = ExtractedDocument(pages=[r[0] for r in results])
    for _, meta, _ in results:
        doc.title = doc.title or meta.get("title")
        doc.language = doc.language or meta.get("language")
        if meta.get("handwritten"):
            doc.handwritten = True
    return JSONResponse({
        "document": doc.model_dump(),
        "engine": chosen.name,
        "engine_label": chosen.label,
        "precision": precision,
        "pages": [r[2] for r in results],
        "seconds": round(time.perf_counter() - t0, 2),
    })


class ExportRequest(BaseModel):
    document: ExtractedDocument
    format: str
    filename: Optional[str] = None


@app.post("/api/export")
def export_file(req: ExportRequest):
    try:
        data, media, ext = export(req.document, req.format)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    stem = re.sub(r"[^\w\- ]+", "", req.filename or req.document.title or "scan").strip()[:80] or "scan"
    return Response(data, media_type=media, headers={"Content-Disposition": f'attachment; filename="{stem}.{ext}"'})


# The built web app is served last so the /api routes above take precedence.
if DIST.is_dir():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="web")
else:
    @app.get("/")
    def index():
        return Response("OmniScan web app not built yet: run `npm install && npm run build`.", media_type="text/plain")
