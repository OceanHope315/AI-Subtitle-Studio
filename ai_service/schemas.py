from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


JobStatus = Literal["queued", "processing", "completed", "failed"]


class NormalizedROI(BaseModel):
    """A crop rectangle expressed relative to the uncropped video frame."""

    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    width: float = Field(gt=0, le=1)
    height: float = Field(gt=0, le=1)

    @model_validator(mode="after")
    def validate_bounds(self) -> "NormalizedROI":
        # A tiny tolerance avoids rejecting browser-generated decimal values such
        # as 0.30000000000000004 while still preventing an out-of-frame crop.
        if self.x + self.width > 1.000001:
            raise ValueError("ROI x + width must not exceed 1")
        if self.y + self.height > 1.000001:
            raise ValueError("ROI y + height must not exceed 1")
        return self


class SubtitleItem(BaseModel):
    id: str
    text: str
    start_time: float = Field(ge=0)
    end_time: float = Field(gt=0)
    confidence: float = Field(default=0, ge=0, le=1)
    position: list[int] | None = None
    source: str = "ocr"

    @model_validator(mode="after")
    def validate_times(self) -> "SubtitleItem":
        if self.end_time <= self.start_time:
            raise ValueError("end_time must be greater than start_time")
        if self.position is not None and len(self.position) != 4:
            raise ValueError("position must contain [x1, y1, x2, y2]")
        return self


class VideoMetadata(BaseModel):
    width: int
    height: int
    fps: float
    frame_count: int
    duration: float
    codec: str | None = None


class JobRecord(BaseModel):
    task_id: str
    status: JobStatus = "queued"
    progress: int = Field(default=0, ge=0, le=100)
    message: str = "等待处理"
    filename: str
    video_path: str
    roi: NormalizedROI | None = None
    metadata: VideoMetadata | None = None
    subtitles: list[SubtitleItem] = Field(default_factory=list)
    artifacts: dict[str, str] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    def public_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json")
