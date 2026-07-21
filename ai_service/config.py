from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent.parent
SERVICE_ROOT = Path(__file__).resolve().parent
load_dotenv(SERVICE_ROOT / ".env")


def _data_path() -> Path:
    value = os.getenv("DATA_DIR")
    if not value:
        return PROJECT_ROOT / "data"
    path = Path(value)
    return path if path.is_absolute() else (SERVICE_ROOT / path).resolve()


def _as_bool(value: str | None, default: bool) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(slots=True)
class Settings:
    data_dir: Path = _data_path()
    sample_fps: float = float(os.getenv("SAMPLE_FPS", "2.0"))
    roi_top_ratio: float = float(os.getenv("OCR_ROI_TOP", "0.45"))
    roi_bottom_ratio: float = float(os.getenv("OCR_ROI_BOTTOM", "0.84"))
    ocr_language: str = os.getenv("OCR_LANGUAGE", "en")
    ocr_device: str = os.getenv("OCR_DEVICE", "cpu")
    min_ocr_confidence: float = float(os.getenv("MIN_OCR_CONFIDENCE", "0.55"))
    text_similarity_threshold: float = float(os.getenv("TEXT_SIMILARITY_THRESHOLD", "0.68"))
    max_missing_seconds: float = float(os.getenv("MAX_MISSING_SECONDS", "0.8"))
    min_event_duration: float = float(os.getenv("MIN_EVENT_DURATION", "0.10"))
    refine_boundaries: bool = _as_bool(os.getenv("REFINE_OCR_BOUNDARIES"), True)
    # Maximum *new* PaddleOCR calls per start/end boundary. Coarse-sample and
    # adjacent-event cache hits are free, so the practical count is often lower.
    boundary_ocr_budget: int = int(os.getenv("BOUNDARY_OCR_BUDGET", "2"))
    discover_short_events: bool = _as_bool(os.getenv("DISCOVER_SHORT_EVENTS"), True)
    discovery_ocr_budget: int = int(os.getenv("DISCOVERY_OCR_BUDGET", "24"))
    discovery_change_threshold: float = float(
        os.getenv("DISCOVERY_CHANGE_THRESHOLD", "2.0")
    )
    enable_whisper: bool = _as_bool(os.getenv("ENABLE_WHISPER"), True)
    whisper_model: str = os.getenv("WHISPER_MODEL", "small")
    whisper_device: str = os.getenv("WHISPER_DEVICE", "cpu")
    whisper_compute_type: str = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
    max_upload_mb: int = int(os.getenv("MAX_UPLOAD_MB", "2048"))
    preview_interval_seconds: float = float(os.getenv("PREVIEW_INTERVAL_SECONDS", "1.0"))
    preview_ring_size: int = int(os.getenv("PREVIEW_RING_SIZE", "8"))
    preview_max_long_edge: int = int(os.getenv("PREVIEW_MAX_LONG_EDGE", "800"))
    preview_jpeg_quality: int = int(os.getenv("PREVIEW_JPEG_QUALITY", "80"))
    cors_origins: str = os.getenv(
        "CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
    )

    @property
    def videos_dir(self) -> Path:
        return self.data_dir / "videos"

    @property
    def subtitles_dir(self) -> Path:
        return self.data_dir / "subtitles"

    @property
    def jobs_dir(self) -> Path:
        return self.data_dir / "jobs"

    @property
    def progress_dir(self) -> Path:
        return self.data_dir / "progress"

    def ensure_directories(self) -> None:
        for directory in (
            self.videos_dir,
            self.subtitles_dir,
            self.jobs_dir,
            self.progress_dir,
        ):
            directory.mkdir(parents=True, exist_ok=True)


settings = Settings()
