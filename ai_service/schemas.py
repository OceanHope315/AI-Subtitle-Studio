from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


JobStatus = Literal["queued", "processing", "completed", "failed"]
ProgressEventType = Literal[
    "stage.progress",
    "frame.analyzed",
    "cue.upserted",
    "translation.upserted",
    "job.completed",
    "job.failed",
]


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
    start_frame: int | None = Field(default=None, ge=0)
    end_frame_exclusive: int | None = Field(default=None, ge=1)
    start_pts: int | None = None
    end_pts: int | None = None
    time_base: str | None = None

    @model_validator(mode="after")
    def validate_times(self) -> "SubtitleItem":
        if self.end_time <= self.start_time:
            raise ValueError("end_time must be greater than start_time")
        if self.position is not None and len(self.position) != 4:
            raise ValueError("position must contain [x1, y1, x2, y2]")
        if (
            self.start_frame is not None
            and self.end_frame_exclusive is not None
            and self.end_frame_exclusive <= self.start_frame
        ):
            raise ValueError("end_frame_exclusive must be greater than start_frame")
        return self


class VideoMetadata(BaseModel):
    width: int
    height: int
    fps: float
    frame_count: int
    duration: float
    codec: str | None = None
    time_base: str | None = None
    start_pts: int | None = None
    start_time: float = 0
    variable_frame_rate: bool = False


class ProgressEvent(BaseModel):
    """One append-only progress event.

    ``progress`` and ``message`` intentionally remain top-level compatibility
    fields for consumers that have not switched to the structured payload yet.
    Event identity is the pair ``(run_id, seq)``.
    """

    seq: int = Field(ge=1)
    task_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,80}$")
    run_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    type: ProgressEventType
    occurred_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    payload: dict[str, Any] = Field(default_factory=dict)
    progress: int = Field(default=0, ge=0, le=100)
    message: str = ""

    def public_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json")


class JobRecord(BaseModel):
    task_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,80}$")
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
    # Only the current event summary belongs in the job snapshot. The complete
    # append-only history lives in the independent progress JSONL store.
    run_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")
    latest_seq: int = Field(default=0, ge=0)
    latest_event: ProgressEvent | None = None
    latest_frame_event: ProgressEvent | None = None
    latest_preview_event: ProgressEvent | None = None
    # Internal write-ahead marker. It is persisted in the AI job file but
    # excluded from public API responses so restart recovery can be retried
    # idempotently across repeated crashes.
    recovery_pending: bool = False
    # A successful pipeline persists its complete result before publishing the
    # terminal event. This marker lets startup finish that commit after a crash
    # without incorrectly changing a completed run into a failed one.
    completion_pending: bool = False
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    def public_dict(self) -> dict[str, Any]:
        return self.model_dump(
            mode="json",
            exclude={"recovery_pending", "completion_pending"},
        )
