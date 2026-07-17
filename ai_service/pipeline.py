from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import inspect
import math
from pathlib import Path
from statistics import median

import cv2

from ai_service.alignment.temporal import (
    OCRFrameObservation,
    OCRObservation,
    build_ocr_events,
    filter_dominant_caption_events,
    frame_contains_event,
    fuse_with_whisper,
    refine_event_boundary,
)
from ai_service.config import Settings
from ai_service.ocr import OCREngine, PaddleOCREngine, compose_line_candidates
from ai_service.schemas import NormalizedROI, SubtitleItem, VideoMetadata
from ai_service.subtitle.srt import write_json_artifact, write_srt, write_subtitle_json
from ai_service.video import SampledFrame, VideoReader
from ai_service.whisper import FasterWhisperEngine


ProgressCallback = Callable[[int, str], None]


@dataclass(slots=True)
class PipelineResult:
    metadata: VideoMetadata
    subtitles: list[SubtitleItem]
    ocr_event_count: int
    whisper_segment_count: int
    artifacts: dict[str, str]
    warnings: list[str]


class SubtitlePipeline:
    def __init__(
        self,
        settings: Settings,
        *,
        ocr_engine: OCREngine | None = None,
        whisper_engine: FasterWhisperEngine | None = None,
    ) -> None:
        self.settings = settings
        self.ocr = ocr_engine or PaddleOCREngine(
            settings.ocr_language, settings.min_ocr_confidence
        )
        self.whisper = whisper_engine or FasterWhisperEngine(
            settings.whisper_model,
            settings.whisper_device,
            settings.whisper_compute_type,
        )

    def process(
        self,
        video_path: str | Path,
        output_dir: str | Path,
        *,
        enable_whisper: bool | None = None,
        roi: NormalizedROI | dict | tuple[float, float, float, float] | None = None,
        progress: ProgressCallback | None = None,
    ) -> PipelineResult:
        callback = progress or (lambda _value, _message: None)
        reader = VideoReader(video_path)
        metadata = reader.probe()
        callback(3, "视频读取成功，开始 PaddleOCR 抽帧识别")

        explicit_roi = roi is not None
        selected_roi = _coerce_roi(roi) if explicit_roi else NormalizedROI(
            x=0,
            y=self.settings.roi_top_ratio,
            width=1,
            height=self.settings.roi_bottom_ratio - self.settings.roi_top_ratio,
        )

        total_samples = max(1, int(metadata.duration * self.settings.sample_fps) + 1)
        observations: list[OCRObservation] = []
        frame_cache: dict[int, OCRFrameObservation] = {}
        warnings: list[str] = []
        consecutive_ocr_errors = 0
        for index, frame in enumerate(
            reader.sampled_frames(
                self.settings.sample_fps,
                roi=selected_roi,
            ),
            start=1,
        ):
            try:
                candidates = self._detect_frame(frame, apply_layout_filter=not explicit_roi)
                candidates = compose_line_candidates(
                    candidates, roi_bounds=_frame_roi_bounds(frame)
                )
                consecutive_ocr_errors = 0
            except Exception as exc:
                consecutive_ocr_errors += 1
                if consecutive_ocr_errors >= 2:
                    warnings.append(str(exc))
                    break
                candidates = []
            frame_observations: list[OCRObservation] = []
            for candidate in candidates:
                observation = OCRObservation(
                    timestamp=frame.timestamp,
                    text=candidate.text,
                    confidence=candidate.confidence,
                    position=candidate.position,
                )
                frame_observations.append(observation)
                observations.append(
                    observation
                )
            frame_cache[frame.frame_index] = OCRFrameObservation(
                frame_index=frame.frame_index,
                timestamp=frame.timestamp,
                candidates=frame_observations,
            )
            callback(
                min(70, 3 + int(index / total_samples * 67)),
                f"PaddleOCR 已处理 {min(index, total_samples)}/{total_samples} 个采样帧",
            )

        coarse_observation_count = len(observations)
        provisional_events = build_ocr_events(
            observations,
            video_duration=metadata.duration,
            sample_fps=self.settings.sample_fps,
            similarity_threshold=self.settings.text_similarity_threshold,
            max_missing_seconds=self.settings.max_missing_seconds,
            min_duration=self.settings.min_event_duration,
        )
        coarse_event_count = len(provisional_events)
        discovery_ocr_calls = 0
        discovery_enabled = bool(
            self.settings.discover_short_events
            and self.settings.discovery_ocr_budget > 0
        )
        if discovery_enabled:
            focus_events = provisional_events
            if explicit_roi:
                focus_events = filter_dominant_caption_events(
                    provisional_events,
                    roi_box=(
                        round(metadata.width * selected_roi.x),
                        round(metadata.height * selected_roi.y),
                        round(metadata.width * (selected_roi.x + selected_roi.width)),
                        round(metadata.height * (selected_roi.y + selected_roi.height)),
                    ),
                    sample_fps=self.settings.sample_fps,
                )
            focus_box = _caption_focus_box(focus_events, metadata, selected_roi)
            probe_indices = _short_event_probe_indices(
                reader,
                metadata=metadata,
                roi=selected_roi,
                focus_box=focus_box,
                cached_frame_indices=set(frame_cache),
                sample_fps=self.settings.sample_fps,
                min_duration=self.settings.min_event_duration,
                change_threshold=self.settings.discovery_change_threshold,
                budget=self.settings.discovery_ocr_budget,
            )
            discovery_errors = 0
            for frame_index in probe_indices:
                if frame_index in frame_cache:
                    continue
                discovery_ocr_calls += 1
                frame = reader.frame_at_index(frame_index, roi=selected_roi)
                try:
                    candidates = compose_line_candidates(
                        self._detect_frame(frame, apply_layout_filter=not explicit_roi),
                        roi_bounds=_frame_roi_bounds(frame),
                    )
                except Exception as exc:
                    discovery_errors += 1
                    if discovery_errors == 1:
                        warnings.append(f"短字幕发现部分失败: {exc}")
                    candidates = []
                discovered = [
                    OCRObservation(
                        timestamp=frame.timestamp,
                        text=candidate.text,
                        confidence=candidate.confidence,
                        position=candidate.position,
                    )
                    for candidate in candidates
                ]
                observations.extend(discovered)
                frame_cache[frame.frame_index] = OCRFrameObservation(
                    frame_index=frame.frame_index,
                    timestamp=frame.timestamp,
                    candidates=discovered,
                )
            callback(
                71,
                f"短字幕变化扫描完成（新增 OCR {discovery_ocr_calls} 次）",
            )

        ocr_events = build_ocr_events(
            observations,
            video_duration=metadata.duration,
            sample_fps=self.settings.sample_fps,
            similarity_threshold=self.settings.text_similarity_threshold,
            max_missing_seconds=self.settings.max_missing_seconds,
            min_duration=self.settings.min_event_duration,
        )
        if explicit_roi:
            roi_left = round(metadata.width * selected_roi.x)
            roi_top = round(metadata.height * selected_roi.y)
            ocr_events = filter_dominant_caption_events(
                ocr_events,
                roi_box=(
                    roi_left,
                    roi_top,
                    round(metadata.width * (selected_roi.x + selected_roi.width)),
                    round(metadata.height * (selected_roi.y + selected_roi.height)),
                ),
                sample_fps=self.settings.sample_fps,
            )
        if not ocr_events:
            warnings.append("未检测到满足阈值的视觉字幕；为避免注入画外语音，Whisper 不会独立生成字幕")
        callback(72, f"OCR 时序聚合完成：{len(ocr_events)} 个视觉字幕事件")

        refinement_ocr_calls = 0
        refinement_enabled = bool(ocr_events and self.settings.refine_boundaries)
        if refinement_enabled:
            interval = 1 / self.settings.sample_fps
            refined: list[SubtitleItem] = []
            refinement_errors = 0

            def selective_boundary_frames(
                event: SubtitleItem,
                start: float,
                end: float,
                direction: str,
            ) -> list[OCRFrameObservation]:
                """Confirm a visual transition with a fixed number of OCR calls."""

                nonlocal refinement_errors, refinement_ocr_calls
                frames = list(reader.frames_between(start, end, roi=selected_roi))
                used = 0

                def observe(frame: SampledFrame) -> OCRFrameObservation | None:
                    nonlocal used, refinement_errors, refinement_ocr_calls
                    cached = frame_cache.get(frame.frame_index)
                    if cached is not None:
                        return cached
                    if used >= max(0, self.settings.boundary_ocr_budget):
                        return None
                    used += 1
                    refinement_ocr_calls += 1
                    try:
                        candidates = self._detect_frame(
                            frame, apply_layout_filter=not explicit_roi
                        )
                        candidates = compose_line_candidates(
                            candidates, roi_bounds=_frame_roi_bounds(frame)
                        )
                    except Exception as exc:
                        refinement_errors += 1
                        if refinement_errors == 1:
                            warnings.append(f"逐帧边界精修部分失败: {exc}")
                        candidates = []
                    observed = OCRFrameObservation(
                        frame_index=frame.frame_index,
                        timestamp=frame.timestamp,
                        candidates=[
                            OCRObservation(
                                timestamp=frame.timestamp,
                                text=candidate.text,
                                confidence=candidate.confidence,
                                position=candidate.position,
                            )
                            for candidate in candidates
                        ],
                    )
                    frame_cache[frame.frame_index] = observed
                    return observed

                return _selective_transition_observations(
                    frames,
                    event,
                    direction=direction,
                    observe=observe,
                    cached=frame_cache,
                    similarity_threshold=max(
                        0.42, self.settings.text_similarity_threshold - 0.15
                    ),
                )

            for index, event in enumerate(ocr_events, start=1):
                start_frames = selective_boundary_frames(
                    event,
                    max(0.0, event.start_time - interval),
                    min(metadata.duration, event.start_time),
                    "start",
                )
                end_frames = selective_boundary_frames(
                    event,
                    max(event.start_time, event.end_time - interval),
                    min(metadata.duration, event.end_time),
                    "end",
                )
                refined.append(
                    refine_event_boundary(
                        event,
                        start_frames=start_frames,
                        end_frames=end_frames,
                        source_fps=metadata.fps,
                        video_duration=metadata.duration,
                        min_duration=self.settings.min_event_duration,
                        similarity_threshold=max(
                            0.42, self.settings.text_similarity_threshold - 0.15
                        ),
                    )
                )
                callback(
                    min(82, 72 + int(index / len(ocr_events) * 10)),
                    f"逐帧边界精修 {index}/{len(ocr_events)}",
                )
            ocr_events = refined
            callback(82, f"逐帧边界精修完成（新增 OCR {refinement_ocr_calls} 次）")

        use_whisper = self.settings.enable_whisper if enable_whisper is None else enable_whisper
        whisper_segments: list[SubtitleItem] = []
        if use_whisper and ocr_events:
            callback(84, "Whisper 正在辅助校验视觉字幕文字")
            try:
                whisper_segments = self.whisper.transcribe(
                    str(video_path), language=self.settings.ocr_language
                )
            except Exception as exc:
                warnings.append(str(exc))
            callback(94, f"Whisper 辅助完成：{len(whisper_segments)} 个语音片段")

        ocr_events = reader.attach_timebase(ocr_events)
        subtitles = reader.attach_timebase(fuse_with_whisper(ocr_events, whisper_segments))
        if not subtitles:
            raise RuntimeError("框选区域内未生成视觉字幕，请检查字幕区域、语言和 OCR 模型")

        output = Path(output_dir)
        output.mkdir(parents=True, exist_ok=True)
        ocr_json_path = write_subtitle_json(ocr_events, output / "ocr_events.json")
        json_path = write_subtitle_json(subtitles, output / "subtitle.json")
        srt_path = write_srt(subtitles, output / "output.srt")
        diagnostics_path = write_json_artifact(
            _build_diagnostics(
                metadata=metadata,
                selected_roi=selected_roi,
                explicit_roi=explicit_roi,
                sample_fps=self.settings.sample_fps,
                observation_count=coarse_observation_count,
                coarse_event_count=coarse_event_count,
                final_events=ocr_events,
                refinement_enabled=refinement_enabled,
                refinement_ocr_calls=refinement_ocr_calls,
                boundary_ocr_budget=self.settings.boundary_ocr_budget,
                discovery_enabled=discovery_enabled,
                discovery_ocr_calls=discovery_ocr_calls,
                discovery_ocr_budget=self.settings.discovery_ocr_budget,
            ),
            output / "diagnostics.json",
        )
        callback(98, "subtitle.json 与 output.srt 已生成")
        return PipelineResult(
            metadata=metadata,
            subtitles=subtitles,
            ocr_event_count=len(ocr_events),
            whisper_segment_count=len(whisper_segments),
            artifacts={
                "ocr_events_json": str(ocr_json_path),
                "subtitle_json": str(json_path),
                "output_srt": str(srt_path),
                "diagnostics_json": str(diagnostics_path),
            },
            warnings=warnings,
        )

    def _detect_frame(self, frame, *, apply_layout_filter: bool):
        """Call modern OCR engines while retaining compatibility with test/custom engines."""

        parameters = inspect.signature(self.ocr.detect).parameters
        supports_kwargs = any(
            parameter.kind is inspect.Parameter.VAR_KEYWORD
            for parameter in parameters.values()
        )
        kwargs = {}
        if "offset_y" in parameters or supports_kwargs:
            kwargs["offset_y"] = frame.roi_offset_y
        if "offset_x" in parameters or supports_kwargs:
            kwargs["offset_x"] = frame.roi_offset_x
        if "apply_layout_filter" in parameters or supports_kwargs:
            kwargs["apply_layout_filter"] = apply_layout_filter
        return self.ocr.detect(frame.image, **kwargs)


def _coerce_roi(
    value: NormalizedROI | dict | tuple[float, float, float, float] | None,
) -> NormalizedROI:
    if isinstance(value, NormalizedROI):
        return value
    if isinstance(value, dict):
        return NormalizedROI.model_validate(value)
    if isinstance(value, (tuple, list)) and len(value) == 4:
        return NormalizedROI(x=value[0], y=value[1], width=value[2], height=value[3])
    raise ValueError("ROI must contain normalized x, y, width and height")


def _frame_roi_bounds(frame: SampledFrame) -> tuple[int, int, int, int]:
    height, width = frame.image.shape[:2]
    return (
        frame.roi_offset_x,
        frame.roi_offset_y,
        frame.roi_offset_x + width,
        frame.roi_offset_y + height,
    )


def _build_diagnostics(
    *,
    metadata: VideoMetadata,
    selected_roi: NormalizedROI,
    explicit_roi: bool,
    sample_fps: float,
    observation_count: int,
    coarse_event_count: int,
    final_events: list[SubtitleItem],
    refinement_enabled: bool,
    refinement_ocr_calls: int,
    boundary_ocr_budget: int,
    discovery_enabled: bool,
    discovery_ocr_calls: int,
    discovery_ocr_budget: int,
) -> dict:
    events = []
    for event in final_events:
        start_frame = event.start_frame if event.start_frame is not None else max(
            0, min(metadata.frame_count - 1, int(round(event.start_time * metadata.fps)))
        )
        end_frame_exclusive = event.end_frame_exclusive or max(
            start_frame + 1,
            min(metadata.frame_count, int(math.ceil(event.end_time * metadata.fps))),
        )
        events.append(
            {
                "id": event.id,
                "text": event.text,
                "start_time": event.start_time,
                "end_time": event.end_time,
                "start_frame": start_frame,
                "end_frame": end_frame_exclusive - 1,
                "end_frame_exclusive": end_frame_exclusive,
                "start_pts": event.start_pts,
                "end_pts": event.end_pts,
                "time_base": event.time_base,
                "confidence": event.confidence,
                "position": event.position,
            }
        )
    return {
        "version": 1,
        "roi": selected_roi.model_dump(mode="json"),
        "roi_source": "manual" if explicit_roi else "configured_default",
        "video": {
            "width": metadata.width,
            "height": metadata.height,
            "source_fps": metadata.fps,
            "frame_count": metadata.frame_count,
            "duration": metadata.duration,
            "time_base": metadata.time_base,
            "start_pts": metadata.start_pts,
            "start_time": metadata.start_time,
            "variable_frame_rate": metadata.variable_frame_rate,
        },
        "sampling": {
            "sample_fps": sample_fps,
            "coarse_observation_count": observation_count,
            "coarse_event_count": coarse_event_count,
        },
        "boundary_refinement": {
            "enabled": refinement_enabled,
            "ocr_budget_per_boundary": max(0, boundary_ocr_budget),
            "new_ocr_call_count": refinement_ocr_calls,
        },
        "short_event_discovery": {
            "enabled": discovery_enabled,
            "global_ocr_budget": max(0, discovery_ocr_budget),
            "new_ocr_call_count": discovery_ocr_calls,
        },
        "final_ocr_event_count": len(final_events),
        "events": events,
    }


def _caption_focus_box(
    events: list[SubtitleItem],
    metadata: VideoMetadata,
    roi: NormalizedROI,
) -> tuple[int, int, int, int] | None:
    boxes = [event.position for event in events if event.position]
    if not boxes:
        return None
    heights = [max(1, box[3] - box[1]) for box in boxes]
    typical_height = median(heights)
    # Discovery deliberately follows the dominant caption band. Expanding one
    # signature to the vertical union of title, raised caption and normal rows
    # dilutes short changes with unrelated gameplay motion. Raised/stacked rows
    # are still found by coarse OCR; the supplemental scan is for states that
    # fall completely between those samples.
    y1 = int(median(box[1] for box in boxes))
    y2 = int(median(box[3] for box in boxes))
    padding = max(6, round(typical_height * 0.35))
    roi_left = round(metadata.width * roi.x)
    roi_right = round(metadata.width * (roi.x + roi.width))
    roi_top = round(metadata.height * roi.y)
    roi_bottom = round(metadata.height * (roi.y + roi.height))
    return (
        roi_left,
        max(roi_top, y1 - padding),
        roi_right,
        min(roi_bottom, y2 + padding),
    )


def _vertical_focus_variants(
    focus_box: tuple[int, int, int, int] | None,
) -> list[tuple[int, int, int, int] | None]:
    """Return tiny vertical jitters for stable resized change signatures.

    A one-pixel crop change can alter area interpolation enough to move a real
    short cue across the transition threshold. All variants are evaluated
    while the decoded source frame is already in memory, so this costs neither
    another video pass nor another OCR call.
    """

    if focus_box is None:
        return [None]
    x1, y1, x2, y2 = focus_box
    edge_jitters = (
        (0, 0),
        (-1, 0),
        (1, 0),
        (0, -1),
        (0, 1),
        (-2, 0),
        (2, 0),
        (0, -2),
        (0, 2),
        (-1, -1),
        (1, 1),
        (-2, -2),
        (2, 2),
    )
    variants: list[tuple[int, int, int, int] | None] = []
    for top_delta, bottom_delta in edge_jitters:
        candidate = (x1, y1 + top_delta, x2, y2 + bottom_delta)
        if candidate[3] > candidate[1] and candidate not in variants:
            variants.append(candidate)
    return variants


def _short_event_probe_indices(
    reader: VideoReader,
    *,
    metadata: VideoMetadata,
    roi: NormalizedROI,
    focus_box: tuple[int, int, int, int] | None,
    cached_frame_indices: set[int],
    sample_fps: float,
    min_duration: float,
    change_threshold: float,
    budget: int,
) -> list[int]:
    """Find uncovered stable intervals using one OCR-free sequential scan."""

    if budget <= 0 or metadata.frame_count < 3:
        return []
    focus_variants = _vertical_focus_variants(focus_box)
    previous_signatures = [None] * len(focus_variants)
    scores_by_variant: list[dict[int, float]] = [
        {} for _variant in focus_variants
    ]
    for frame in reader.frames_between(0, metadata.duration, roi=roi):
        image = frame.image
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image
        for variant_index, variant in enumerate(focus_variants):
            local = gray
            if variant is not None:
                x1, y1, x2, y2 = variant
                local_x1 = max(0, x1 - frame.roi_offset_x)
                local_y1 = max(0, y1 - frame.roi_offset_y)
                local_x2 = min(gray.shape[1], x2 - frame.roi_offset_x)
                local_y2 = min(gray.shape[0], y2 - frame.roi_offset_y)
                if local_x2 > local_x1 and local_y2 > local_y1:
                    local = gray[local_y1:local_y2, local_x1:local_x2]
            signature = cv2.resize(local, (64, 24), interpolation=cv2.INTER_AREA)
            previous = previous_signatures[variant_index]
            if previous is not None:
                scores_by_variant[variant_index][frame.frame_index] = float(
                    cv2.absdiff(previous, signature).mean()
                )
            previous_signatures[variant_index] = signature

    # Extract intervals independently: every crop has a slightly different
    # robust baseline. Merge by threshold-normalised strength, with support
    # across jitters used as a deterministic tie-breaker.
    merged: dict[int, tuple[float, float, int]] = {}
    for scores in scores_by_variant:
        for normalized, raw_priority, frame_index in _short_event_intervals(
            scores,
            metadata=metadata,
            cached_frame_indices=cached_frame_indices,
            sample_fps=sample_fps,
            min_duration=min_duration,
            change_threshold=change_threshold,
        ):
            previous = merged.get(frame_index)
            if previous is None:
                merged[frame_index] = (normalized, raw_priority, 1)
            else:
                merged[frame_index] = (
                    max(previous[0], normalized),
                    max(previous[1], raw_priority),
                    previous[2] + 1,
                )

    ranked = sorted(
        (normalized, support, raw_priority, frame_index)
        for frame_index, (normalized, raw_priority, support) in merged.items()
    )
    selected: list[int] = []
    duplicate_tolerance = max(1, round(metadata.fps * 0.02))
    for _normalized, _support, _raw_priority, frame_index in reversed(ranked):
        if any(abs(frame_index - existing) <= duplicate_tolerance for existing in selected):
            continue
        if frame_index not in selected and frame_index not in cached_frame_indices:
            selected.append(frame_index)
        if len(selected) >= budget:
            break
    return selected


def _short_event_intervals(
    scores: dict[int, float],
    *,
    metadata: VideoMetadata,
    cached_frame_indices: set[int],
    sample_fps: float,
    min_duration: float,
    change_threshold: float,
) -> list[tuple[float, float, int]]:
    """Extract and normalise stable intervals for one focus variant."""

    if len(scores) < 2:
        return []
    values = list(scores.values())
    baseline = median(values)
    deviation = median(abs(value - baseline) for value in values)
    threshold = max(change_threshold, baseline + max(1.0, deviation * 5.0))
    raw_transitions = [
        frame_index for frame_index, score in scores.items() if score >= threshold
    ]
    if len(raw_transitions) < 2:
        return []

    cluster_gap = max(1, round(metadata.fps * 0.05))
    transitions: list[int] = []
    cluster: list[int] = []
    for frame_index in raw_transitions:
        if cluster and frame_index - cluster[-1] > cluster_gap:
            transitions.append(max(cluster, key=lambda index: scores[index]))
            cluster = []
        cluster.append(frame_index)
    if cluster:
        transitions.append(max(cluster, key=lambda index: scores[index]))
    if len(transitions) < 2:
        return []

    minimum_frames = max(1, math.ceil(min_duration * metadata.fps))
    maximum_uncovered = max(
        minimum_frames,
        math.ceil(metadata.fps / max(0.25, sample_fps) * 1.15),
    )
    intervals: list[tuple[float, float, int]] = []
    for left, right in zip(transitions, transitions[1:]):
        interval_start, interval_end = left, right - 1
        length = interval_end - interval_start + 1
        if length < minimum_frames or length > maximum_uncovered:
            continue
        if any(interval_start <= index <= interval_end for index in cached_frame_indices):
            continue
        representative = (interval_start + interval_end) // 2
        priority = min(scores[left], scores[right])
        intervals.append((priority / max(1.0, threshold), priority, representative))
    return intervals


def _selective_transition_observations(
    frames: list[SampledFrame],
    event: SubtitleItem,
    *,
    direction: str,
    observe: Callable[[SampledFrame], OCRFrameObservation | None],
    cached: dict[int, OCRFrameObservation],
    similarity_threshold: float,
) -> list[OCRFrameObservation]:
    """Locate a transition using visual differences and bounded lazy OCR.

    Coarse sampled frames provide the known positive/negative anchors. Every
    source frame is cheaply compared at low resolution, but ``observe`` is only
    called around the strongest transition and, if budget remains, during a
    binary fallback. A result is returned only after adjacent states converge;
    otherwise the caller deliberately keeps the safe coarse boundary.
    """

    if not frames or direction not in {"start", "end"}:
        return []
    observations: dict[int, OCRFrameObservation] = {}
    states: dict[int, bool] = {}

    def remember(index: int, observation: OCRFrameObservation | None) -> bool | None:
        if observation is None:
            return None
        observations[index] = observation
        state = frame_contains_event(observation, event, similarity_threshold)
        states[index] = state
        return state

    # Populate states only from existing coarse/adjacent-event cache entries;
    # scanning the cache must never spend the boundary OCR budget.
    for index, frame in enumerate(frames):
        existing = cached.get(frame.frame_index)
        if existing is not None:
            remember(index, existing)

    def probe(index: int) -> bool | None:
        if index in states:
            return states[index]
        return remember(index, observe(frames[index]))

    positive = sorted(index for index, state in states.items() if state)
    if not positive:
        expected = len(frames) - 1 if direction == "start" else 0
        if probe(expected) is not True:
            return []
        positive = [expected]

    if direction == "start":
        high = min(positive)
        if high == 0:
            return [observations[high]]
        negative_before = [
            index for index, state in states.items() if not state and index < high
        ]
        low = max(negative_before, default=0)
        # If the first frame is not cached, it is the previous coarse-window
        # side and is a safe conceptual negative anchor.
        states.setdefault(low, False)
    else:
        low = max(positive)
        if low == len(frames) - 1:
            return [observations[low]]
        negative_after = [
            index for index, state in states.items() if not state and index > low
        ]
        high = min(negative_after, default=len(frames) - 1)
        states.setdefault(high, False)

    if high <= low:
        return []
    changes = _visual_change_scores(frames, event)
    transition = max(
        range(low + 1, high + 1),
        key=lambda index: changes.get(index, 0.0),
    )

    # First confirm the two frames straddling the strongest cheap visual change.
    before_index, after_index = transition - 1, transition
    before, after = probe(before_index), probe(after_index)
    if before is False and after is True and direction == "start":
        return [observations[after_index]]
    if before is True and after is False and direction == "end":
        return [observations[before_index]]

    # Tighten anchors using every state learned above, then spend any remaining
    # callback budget on a deterministic binary fallback.
    if direction == "start":
        known_positive = [index for index, state in states.items() if state]
        if not known_positive:
            return []
        high = min(known_positive)
        known_negative = [
            index for index, state in states.items() if not state and index < high
        ]
        low = max(known_negative, default=low)
        while high - low > 1:
            middle = (low + high) // 2
            state = probe(middle)
            if state is None:
                return []
            if state:
                high = middle
            else:
                low = middle
        return [observations[high]] if high in observations else []

    known_positive = [index for index, state in states.items() if state]
    if not known_positive:
        return []
    low = max(known_positive)
    known_negative = [
        index for index, state in states.items() if not state and index > low
    ]
    high = min(known_negative, default=high)
    while high - low > 1:
        middle = (low + high + 1) // 2
        state = probe(middle)
        if state is None:
            return []
        if state:
            low = middle
        else:
            high = middle
    return [observations[low]] if low in observations else []


def _visual_change_scores(
    frames: list[SampledFrame], event: SubtitleItem
) -> dict[int, float]:
    """Return event-local visual change with a weak whole-ROI fallback."""

    local_signatures = []
    whole_signatures = []
    for frame in frames:
        image = frame.image
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image
        whole_signatures.append(
            cv2.resize(gray, (32, 16), interpolation=cv2.INTER_AREA)
        )
        local = gray
        if event.position:
            x1, y1, x2, y2 = event.position
            width, height = max(1, x2 - x1), max(1, y2 - y1)
            pad_x = max(4, round(width * 0.08))
            pad_y = max(4, round(height * 0.30))
            local_x1 = max(0, x1 - frame.roi_offset_x - pad_x)
            local_y1 = max(0, y1 - frame.roi_offset_y - pad_y)
            local_x2 = min(gray.shape[1], x2 - frame.roi_offset_x + pad_x)
            local_y2 = min(gray.shape[0], y2 - frame.roi_offset_y + pad_y)
            if local_x2 > local_x1 and local_y2 > local_y1:
                local = gray[local_y1:local_y2, local_x1:local_x2]
        local_signatures.append(
            cv2.resize(local, (64, 32), interpolation=cv2.INTER_AREA)
        )
    return {
        index: (
            float(cv2.absdiff(
                local_signatures[index - 1], local_signatures[index]
            ).mean()) * 0.88
            + float(cv2.absdiff(
                whole_signatures[index - 1], whole_signatures[index]
            ).mean()) * 0.12
        )
        for index in range(1, len(frames))
    }
