from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


class OCRUnavailableError(RuntimeError):
    pass


@dataclass(slots=True)
class DetectedText:
    text: str
    confidence: float
    position: tuple[int, int, int, int]


class OCREngine(Protocol):
    name: str

    def detect(
        self,
        image,
        offset_y: int = 0,
        offset_x: int = 0,
        *,
        apply_layout_filter: bool = True,
    ) -> list[DetectedText]: ...
