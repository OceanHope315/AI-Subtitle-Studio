from __future__ import annotations

from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from statistics import median
from typing import Iterator

import av

from ai_service.schemas import NormalizedROI, SubtitleItem, VideoMetadata


@dataclass(frozen=True, slots=True)
class FrameTiming:
    frame_index: int
    pts: int
    duration_pts: int
    timestamp: float


@dataclass(slots=True)
class SampledFrame:
    image: object
    frame_index: int
    timestamp: float
    pts: int | None = None
    duration_pts: int | None = None
    time_base: str | None = None
    roi_offset_y: int = 0
    roi_offset_x: int = 0


class VideoReader:
    """Decode presentation-order frames and use container PTS as the time source.

    Public seconds are always derived from ``(pts - start_pts) * time_base`` so
    MP4 edit-list/non-zero origins do not introduce a global offset. Raw PTS and
    the exact time base remain available for lossless cue boundaries.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        self._timings: list[FrameTiming] | None = None
        self._time_base: Fraction | None = None
        self._start_pts: int | None = None
        self._last_end_pts: int | None = None
        self._metadata: VideoMetadata | None = None

    def probe(self) -> VideoMetadata:
        if self._metadata is not None:
            return self._metadata
        timings, stream_info = self._scan_timeline()
        if not timings or not stream_info["width"] or not stream_info["height"]:
            raise RuntimeError("视频元数据无效或视频损坏")

        deltas = [right.pts - left.pts for left, right in zip(timings, timings[1:])]
        typical_delta = int(round(median(deltas))) if deltas else timings[0].duration_pts
        variable = any(abs(delta - typical_delta) > max(1, typical_delta * 0.001) for delta in deltas)
        duration = float(Fraction(self._last_end_pts - self._start_pts) * self._time_base)
        average_rate = stream_info["average_rate"]
        fps = float(average_rate) if average_rate else (
            len(timings) / duration if duration > 0 else 0
        )
        if fps <= 0:
            raise RuntimeError("视频元数据无效或视频损坏")

        self._metadata = VideoMetadata(
            width=stream_info["width"],
            height=stream_info["height"],
            fps=fps,
            frame_count=len(timings),
            duration=duration,
            codec=stream_info["codec"],
            time_base=_fraction_text(self._time_base),
            start_pts=self._start_pts,
            start_time=float(Fraction(self._start_pts) * self._time_base),
            variable_frame_rate=variable,
        )
        return self._metadata

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
            x=0, y=roi_top_ratio, width=1, height=roi_bottom_ratio - roi_top_ratio
        )
        self.probe()
        next_sample = 0.0
        interval = 1 / sample_fps
        with av.open(self.path) as container:
            stream = container.streams.video[0]
            timing_index = 0
            for frame in container.decode(stream):
                if frame.pts is None:
                    continue
                timing = self._timings[timing_index]
                timing_index += 1
                if timing.timestamp + 1e-9 < next_sample:
                    continue
                while next_sample <= timing.timestamp + 1e-9:
                    next_sample += interval
                image = frame.to_ndarray(format="bgr24")
                crop, left, top = _crop_frame(image, normalized_roi)
                yield self._sample(crop, timing, left, top)

    def frames_between(
        self,
        start_time: float,
        end_time: float,
        *,
        roi: NormalizedROI | dict | tuple[float, float, float, float] | None = None,
    ) -> Iterator[SampledFrame]:
        """Read every presentation frame whose start lies in the inclusive window."""

        if start_time < 0 or end_time < start_time:
            raise ValueError("invalid frame time range")
        normalized_roi = _coerce_roi(roi) if roi is not None else NormalizedROI(
            x=0, y=0, width=1, height=1
        )
        self.probe()
        first_index = max(0, bisect_left(self._timestamps(), start_time - 1e-9))
        last_index = min(
            len(self._timings) - 1,
            bisect_right(self._timestamps(), end_time + 1e-9) - 1,
        )
        if last_index < first_index:
            return
        yield from self._decode_index_range(first_index, last_index, normalized_roi)

    def frame_at_index(
        self,
        frame_index: int,
        *,
        roi: NormalizedROI | dict | tuple[float, float, float, float] | None = None,
    ) -> SampledFrame:
        if frame_index < 0:
            raise ValueError("frame_index must not be negative")
        normalized_roi = _coerce_roi(roi) if roi is not None else NormalizedROI(
            x=0, y=0, width=1, height=1
        )
        self.probe()
        if frame_index >= len(self._timings):
            raise ValueError("frame_index is outside the video")
        return next(self._decode_index_range(frame_index, frame_index, normalized_roi))

    def attach_timebase(self, cues: list[SubtitleItem]) -> list[SubtitleItem]:
        """Snap cue boundaries to PTS and make API seconds derived values."""

        self.probe()
        boundaries = self._timestamps() + [
            float(Fraction(self._last_end_pts - self._start_pts) * self._time_base)
        ]
        result: list[SubtitleItem] = []
        for cue in cues:
            start_index = min(len(self._timings) - 1, _nearest_boundary(boundaries, cue.start_time))
            end_index = _nearest_boundary(boundaries, cue.end_time)
            end_index = max(start_index + 1, min(len(self._timings), end_index))
            start_pts = self._timings[start_index].pts
            end_pts = self._timings[end_index].pts if end_index < len(self._timings) else self._last_end_pts
            start_seconds = float(Fraction(start_pts - self._start_pts) * self._time_base)
            end_seconds = float(Fraction(end_pts - self._start_pts) * self._time_base)
            result.append(cue.model_copy(update={
                "start_time": start_seconds,
                "end_time": end_seconds,
                "start_frame": start_index,
                "end_frame_exclusive": end_index,
                "start_pts": start_pts,
                "end_pts": end_pts,
                "time_base": _fraction_text(self._time_base),
            }))
        return result

    def _scan_timeline(self) -> tuple[list[FrameTiming], dict]:
        if self._timings is not None:
            return self._timings, self._stream_info
        try:
            container = av.open(self.path)
        except Exception as exc:
            raise RuntimeError(f"无法打开视频: {self.path}") from exc
        with container:
            if not container.streams.video:
                raise RuntimeError("视频元数据无效或视频损坏")
            stream = container.streams.video[0]
            time_base = Fraction(stream.time_base)
            raw: list[tuple[int, int]] = []
            for frame in container.decode(stream):
                if frame.pts is None:
                    continue
                raw.append((int(frame.pts), int(frame.duration or 0)))
            if not raw:
                raise RuntimeError("视频元数据无效或视频损坏")
            start_pts = int(stream.start_time) if stream.start_time is not None else raw[0][0]
            if start_pts > raw[0][0]:
                start_pts = raw[0][0]
            deltas = [right[0] - left[0] for left, right in zip(raw, raw[1:]) if right[0] > left[0]]
            fallback_duration = max(1, int(round(median(deltas)))) if deltas else max(1, raw[0][1])
            timings = []
            for index, (pts, declared_duration) in enumerate(raw):
                next_pts = raw[index + 1][0] if index + 1 < len(raw) else None
                duration_pts = (next_pts - pts) if next_pts is not None else (declared_duration or fallback_duration)
                if duration_pts <= 0:
                    duration_pts = fallback_duration
                timings.append(FrameTiming(
                    frame_index=index,
                    pts=pts,
                    duration_pts=duration_pts,
                    timestamp=float(Fraction(pts - start_pts) * time_base),
                ))
            self._timings = timings
            self._time_base = time_base
            self._start_pts = start_pts
            self._last_end_pts = timings[-1].pts + timings[-1].duration_pts
            self._stream_info = {
                "width": int(stream.codec_context.width or 0),
                "height": int(stream.codec_context.height or 0),
                "codec": stream.codec_context.name or None,
                "average_rate": Fraction(stream.average_rate) if stream.average_rate else None,
            }
            return timings, self._stream_info

    def _decode_index_range(
        self, first_index: int, last_index: int, roi: NormalizedROI
    ) -> Iterator[SampledFrame]:
        first_pts = self._timings[first_index].pts
        seek_pts = first_pts - self._timings[first_index].duration_pts * 4
        with av.open(self.path) as container:
            stream = container.streams.video[0]
            container.seek(seek_pts, stream=stream, backward=True, any_frame=False)
            by_pts = {timing.pts: timing for timing in self._timings[first_index:last_index + 1]}
            for frame in container.decode(stream):
                timing = by_pts.get(frame.pts)
                if timing is None:
                    if frame.pts is not None and frame.pts > self._timings[last_index].pts:
                        break
                    continue
                image = frame.to_ndarray(format="bgr24")
                crop, left, top = _crop_frame(image, roi)
                yield self._sample(crop, timing, left, top)
                if timing.frame_index >= last_index:
                    break

    def _sample(self, image, timing: FrameTiming, left: int, top: int) -> SampledFrame:
        return SampledFrame(
            image=image,
            frame_index=timing.frame_index,
            timestamp=timing.timestamp,
            pts=timing.pts,
            duration_pts=timing.duration_pts,
            time_base=_fraction_text(self._time_base),
            roi_offset_y=top,
            roi_offset_x=left,
        )

    def _timestamps(self) -> list[float]:
        return [timing.timestamp for timing in self._timings]


def _nearest_boundary(boundaries: list[float], value: float) -> int:
    index = bisect_left(boundaries, value)
    if index <= 0:
        return 0
    if index >= len(boundaries):
        return len(boundaries) - 1
    return index - 1 if value - boundaries[index - 1] <= boundaries[index] - value else index


def _fraction_text(value: Fraction) -> str:
    return f"{value.numerator}/{value.denominator}"


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
    left = max(0, min(width - 1, round(width * roi.x)))
    top = max(0, min(height - 1, round(height * roi.y)))
    right = max(left + 1, min(width, round(width * (roi.x + roi.width))))
    bottom = max(top + 1, min(height, round(height * (roi.y + roi.height))))
    return frame[top:bottom, left:right], left, top
