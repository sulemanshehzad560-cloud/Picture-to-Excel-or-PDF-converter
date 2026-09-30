from __future__ import annotations

from typing import Optional

from .base import Engine, EngineError
from .claude_engine import ClaudeEngine
from .tesseract_engine import TesseractEngine

__all__ = ["Engine", "EngineError", "ClaudeEngine", "TesseractEngine", "pick_engine", "engine_status"]


def engine_status() -> dict:
    return {
        "claude": {"label": ClaudeEngine.label, "server_key": ClaudeEngine.configured()},
        "tesseract": {"label": TesseractEngine.label, "available": TesseractEngine().available()},
    }


def pick_engine(name: str, api_key: Optional[str] = None) -> Engine:
    """'auto' prefers Claude (handwriting-grade) whenever a key is available, else offline OCR."""
    claude = ClaudeEngine(api_key)
    if name == "claude":
        if not claude.available():
            raise EngineError("The Claude engine needs an Anthropic API key. Add one in Settings or on the server.")
        return claude
    if name == "tesseract":
        return TesseractEngine()
    return claude if claude.available() else TesseractEngine()
