from __future__ import annotations

from ..preprocess import Prepared
from ..schema import Page


class EngineError(RuntimeError):
    """A user-presentable failure (bad key, rate limit, unreadable page...)."""


class Engine:
    name = "base"
    label = "base"

    def available(self) -> bool:
        raise NotImplementedError

    def extract_page(self, prepared: Prepared, page_number: int, precision: str = "high") -> tuple[Page, dict]:
        """Return the page plus document-level hints (title, language, handwritten)."""
        raise NotImplementedError
