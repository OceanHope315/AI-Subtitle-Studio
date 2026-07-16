from .base import DetectedText, OCREngine, OCRUnavailableError
from .composition import compose_line_candidates
from .paddle_engine import PaddleOCREngine

__all__ = [
    "DetectedText",
    "OCREngine",
    "OCRUnavailableError",
    "PaddleOCREngine",
    "compose_line_candidates",
]
