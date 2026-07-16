from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import cv2

from ai_service.schemas import NormalizedROI, VideoMetadata


@dataclass(slots=True)
class SampledFrame:
    image: object
    frame_index: int
    timestamp: float
    roi_offset_y: int = 0
    roi_offset_x: int = 0


class VideoReader:
    def __init__(self, path: str | Path) -> None:
        self.path = str(path)

    def probe(self) -> VideoMetadata:
        cap = cv2.VideoCapture(self.path)
        if not cap.isOpened():
            raise RuntimeError(f"无法打开视频: {self.path}")
        try:
            fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
            frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
            width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
            height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
            duration = frame_count / fps if fps > 0 else 0
            codec_int = int(cap.get(cv2.CAP_PROP_FOURCC) or 0)
            codec = "".join(chr((codec_int >> 8 * i) & 0xFF) for i in range(4)).strip("\x00")
        finally:
            cap.release()
        if not width or not height or not frame_count or fps <= 0:
            raise RuntimeError("视频元数据无效或视频损坏")
        return VideoMetadata(
            width=width,
            height=height,
            fps=fps,
            frame_count=frame_count,
            duration=duration,
            codec=codec or None,
        )

    def sampled_frames(
        self,
        sample_fps: float,
        roi_top_ratio: float = 0.0,
        roi_bottom_ratio: float = 1.0,
        *,
        roi: NormalizedROI | dict | tuple[float, float, float, float] | None = None,
    ) -> Iterator[SampledFrame]:
        if sample_fps <= 0:
            raise ValueError("sample_fps must be greater than zero")
        if not 0 <= roi_top_ratio < roi_bottom_ratio <= 1:
            raise ValueError("invalid OCR ROI ratios")

        normalized_roi = _coerce_roi(roi) if roi is not None else NormalizedROI(
            x=0,
            y=roi_top_ratio,
            width=1,
            height=roi_bottom_ratio - roi_top_ratio,
        )

        cap = cv2.VideoCapture(self.path)
        if not cap.isOpened():
            raise RuntimeError(f"无法打开视频: {self.path}")
        source_fps = float(cap.get(cv2.CAP_PROP_FPS) or 25.0)
        sample_step = max(1, round(source_fps / sample_fps))
        frame_index = 0
        try:
            while cap.grab():
                if frame_index % sample_step == 0:
                    ok, frame = cap.retrieve()
                    if not ok:
                        break
                    crop, left, top = _crop_frame(frame, normalized_roi)
                    yield SampledFrame(
                        image=crop,
                        frame_index=frame_index,
                        timestamp=frame_index / source_fps,
                        roi_offset_y=top,
                        roi_offset_x=left,
                    )
                frame_index += 1
        finally:
            cap.release()

    def frames_between(
        self,
        start_time: float,
        end_time: float,
        *,
        roi: NormalizedROI | dict | tuple[float, float, float, float] | None = None,
    ) -> Iterator[SampledFrame]:
        """Read every source frame in a short inclusive time window.

        This is intentionally separate from ``sampled_frames``: the pipeline
        uses coarse sampling for discovery, then calls this method only around
        candidate start/end boundaries where frame-accurate OCR is worthwhile.
        """

        if start_time < 0 or end_time < start_time:
            raise ValueError("invalid frame time range")
        normalized_roi = _coerce_roi(roi) if roi is not None else NormalizedROI(
            x=0, y=0, width=1, height=1
        )
        cap = cv2.VideoCapture(self.path)
        if not cap.isOpened():
            raise RuntimeError(f"无法打开视频: {self.path}")
        source_fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        if source_fps <= 0 or frame_count <= 0:
            cap.release()
            raise RuntimeError("视频元数据无效或视频损坏")
        first_index = max(0, min(frame_count - 1, int(start_time * source_fps)))
        last_index = max(first_index, min(frame_count - 1, int(end_time * source_fps)))
        cap.set(cv2.CAP_PROP_POS_FRAMES, first_index)
        try:
            for frame_index in range(first_index, last_index + 1):
                ok, frame = cap.read()
                if not ok:
                    break
                crop, left, top = _crop_frame(frame, normalized_roi)
                yield SampledFrame(
                    image=crop,
                    frame_index=frame_index,
                    timestamp=frame_index / source_fps,
                    roi_offset_y=top,
                    roi_offset_x=left,
                )
        finally:
            cap.release()

    def frame_at_index(
        self,
        frame_index: int,
        *,
        roi: NormalizedROI | dict | tuple[float, float, float, float] | None = None,
    ) -> SampledFrame:
        """Random-read one exact source frame for bounded OCR discovery probes."""

        if frame_index < 0:
            raise ValueError("frame_index must not be negative")
        normalized_roi = _coerce_roi(roi) if roi is not None else NormalizedROI(
            x=0, y=0, width=1, height=1
        )
        cap = cv2.VideoCapture(self.path)
        if not cap.isOpened():
            raise RuntimeError(f"无法打开视频: {self.path}")
        source_fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        if source_fps <= 0 or frame_index >= frame_count:
            cap.release()
            raise ValueError("frame_index is outside the video")
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
        try:
            ok, frame = cap.read()
            if not ok:
                raise RuntimeError(f"无法读取视频帧: {frame_index}")
            crop, left, top = _crop_frame(frame, normalized_roi)
            return SampledFrame(
                image=crop,
                frame_index=frame_index,
                timestamp=frame_index / source_fps,
                roi_offset_y=top,
                roi_offset_x=left,
            )
        finally:
            cap.release()


def _coerce_roi(
    value: NormalizedROI | dict | tuple[float, float, float, float],
) -> NormalizedROI:
    if isinstance(value, NormalizedROI):
        return value
    if isinstance(value, dict):
        return NormalizedROI.model_validate(value)
    if isinstance(value, (tuple, list)) and len(value) == 4:
        return NormalizedROI(x=value[0], y=value[1], width=value[2], height=value[3])
    raise ValueError("ROI must contain normalized x, y, width and height")


def _crop_frame(frame, roi: NormalizedROI):
    height, width = frame.shape[:2]
    # Round the two edges independently so the crop remains aligned to the
    # original frame even when the player reports recurring decimals.
    left = max(0, min(width - 1, round(width * roi.x)))
    top = max(0, min(height - 1, round(height * roi.y)))
    right = max(left + 1, min(width, round(width * (roi.x + roi.width))))
    bottom = max(top + 1, min(height, round(height * (roi.y + roi.height))))
    return frame[top:bottom, left:right], left, top
