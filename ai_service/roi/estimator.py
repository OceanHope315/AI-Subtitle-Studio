from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from statistics import fmean, median, pstdev

from ai_service.ocr.base import DetectedText, OCREngine
from ai_service.schemas import NormalizedROI
from ai_service.video.reader import VideoReader


DEFAULT_REPRESENTATIVE_FRAME_COUNT = 16
DEFAULT_Y_CLUSTER_TOLERANCE = 0.06


@dataclass(frozen=True, slots=True)
class RoiEstimate:
    roi: NormalizedROI
    score: float
    frames_analyzed: int
    frame_hits: int
    mean_confidence: float


@dataclass(frozen=True, slots=True)
class _Candidate:
    sample_index: int
    text: str
    confidence: float
    box: tuple[int, int, int, int]
    center_x: float
    center_y: float
    width: float
    height: float


@dataclass(slots=True)
class _ScoredCluster:
    candidates: list[_Candidate]
    score: float
    frame_hits: int
    mean_confidence: float


def estimate_video_roi(
    video_path: str | Path,
    ocr_engine: OCREngine,
    *,
    frame_count: int = DEFAULT_REPRESENTATIVE_FRAME_COUNT,
    confidence_threshold: float = 0.55,
    y_cluster_tolerance: float = DEFAULT_Y_CLUSTER_TOLERANCE,
) -> RoiEstimate | None:
    """Estimate one normalized caption band from representative full frames."""

    if not 10 <= frame_count <= 20:
        raise ValueError("frame_count must be between 10 and 20")
    if not 0 <= confidence_threshold <= 1:
        raise ValueError("confidence_threshold must be between 0 and 1")

    reader = VideoReader(video_path)
    frames = list(reader.representative_frames(frame_count))
    if not frames:
        raise RuntimeError("视频中没有可分析的画面")
    observations: list[list[DetectedText]] = []
    for frame in frames:
        observations.append(
            ocr_engine.detect(
                frame.image,
                offset_y=0,
                offset_x=0,
                apply_layout_filter=False,
            )
        )

    frame_height, frame_width = frames[0].image.shape[:2]

    return estimate_roi_from_observations(
        observations,
        frame_width=frame_width,
        frame_height=frame_height,
        confidence_threshold=confidence_threshold,
        y_cluster_tolerance=y_cluster_tolerance,
    )


def estimate_roi_from_observations(
    observations: list[list[DetectedText]],
    *,
    frame_width: int,
    frame_height: int,
    confidence_threshold: float = 0.55,
    y_cluster_tolerance: float = DEFAULT_Y_CLUSTER_TOLERANCE,
) -> RoiEstimate | None:
    """Cluster OCR boxes by normalized y center and select the caption band.

    Frame frequency is counted once per representative frame, so a single busy
    HUD frame cannot win merely because it contains many labels.
    """

    if frame_width <= 0 or frame_height <= 0:
        raise ValueError("frame dimensions must be positive")
    if not observations:
        return None
    if not 0 <= confidence_threshold <= 1:
        raise ValueError("confidence_threshold must be between 0 and 1")
    if not 0 < y_cluster_tolerance <= 0.25:
        raise ValueError("y_cluster_tolerance must be between 0 and 0.25")

    candidates = _collect_candidates(
        observations,
        frame_width=frame_width,
        frame_height=frame_height,
        confidence_threshold=confidence_threshold,
    )
    if not candidates:
        return None

    minimum_hits = max(2, math.ceil(len(observations) * 0.25))
    scored = [
        cluster
        for members in _merge_cooccurring_lines(
            _cluster_by_y(candidates, y_cluster_tolerance)
        )
        if (
            cluster := _score_cluster(
                members,
                sample_count=len(observations),
                y_tolerance=y_cluster_tolerance,
            )
        ).frame_hits >= minimum_hits
    ]
    if not scored:
        return None

    best = max(
        scored,
        key=lambda cluster: (
            cluster.score,
            cluster.frame_hits,
            cluster.mean_confidence,
            median(candidate.center_y for candidate in cluster.candidates),
        ),
    )
    if best.score < 0.48:
        return None

    roi = _roi_for_cluster(best.candidates, frame_width, frame_height)
    return RoiEstimate(
        roi=roi,
        score=best.score,
        frames_analyzed=len(observations),
        frame_hits=best.frame_hits,
        mean_confidence=best.mean_confidence,
    )


def _collect_candidates(
    observations: list[list[DetectedText]],
    *,
    frame_width: int,
    frame_height: int,
    confidence_threshold: float,
) -> list[_Candidate]:
    candidates: list[_Candidate] = []
    for sample_index, detections in enumerate(observations):
        for detection in detections:
            if not math.isfinite(detection.confidence) or detection.confidence <= confidence_threshold:
                continue
            if not detection.text.strip():
                continue
            try:
                coordinates = [float(value) for value in detection.position]
            except (TypeError, ValueError):
                continue
            if len(coordinates) != 4 or not all(math.isfinite(value) for value in coordinates):
                continue
            raw_x1, raw_y1, raw_x2, raw_y2 = coordinates
            x1 = max(0, min(frame_width, round(raw_x1)))
            y1 = max(0, min(frame_height, round(raw_y1)))
            x2 = max(0, min(frame_width, round(raw_x2)))
            y2 = max(0, min(frame_height, round(raw_y2)))
            if x2 <= x1 or y2 <= y1:
                continue
            width = (x2 - x1) / frame_width
            height = (y2 - y1) / frame_height
            # Reject specks and implausibly tall scene text while retaining
            # compact CJK captions and two-line subtitle boxes.
            if width < 0.01 or not 0.008 <= height <= 0.22:
                continue
            candidates.append(
                _Candidate(
                    sample_index=sample_index,
                    text=detection.text.strip(),
                    confidence=float(detection.confidence),
                    box=(x1, y1, x2, y2),
                    center_x=((x1 + x2) / 2) / frame_width,
                    center_y=((y1 + y2) / 2) / frame_height,
                    width=width,
                    height=height,
                )
            )
    return candidates


def _cluster_by_y(
    candidates: list[_Candidate], tolerance: float
) -> list[list[_Candidate]]:
    clusters: list[list[_Candidate]] = []
    for candidate in sorted(candidates, key=lambda item: item.center_y):
        compatible = [
            cluster
            for cluster in clusters
            if abs(candidate.center_y - median(item.center_y for item in cluster))
            <= max(tolerance, candidate.height * 0.8)
        ]
        if compatible:
            closest = min(
                compatible,
                key=lambda cluster: abs(
                    candidate.center_y - median(item.center_y for item in cluster)
                ),
            )
            closest.append(candidate)
        else:
            clusters.append([candidate])
    return clusters


def _merge_cooccurring_lines(
    clusters: list[list[_Candidate]],
) -> list[list[_Candidate]]:
    """Merge adjacent OCR rows that repeatedly form one multi-line caption."""

    ordered = sorted(
        clusters,
        key=lambda cluster: median(candidate.center_y for candidate in cluster),
    )
    merged: list[list[_Candidate]] = []
    for cluster in ordered:
        if not merged or not _are_caption_lines(merged[-1], cluster):
            merged.append(list(cluster))
            continue
        merged[-1].extend(cluster)
    return merged


def _are_caption_lines(
    upper: list[_Candidate], lower: list[_Candidate]
) -> bool:
    upper_frames = {candidate.sample_index for candidate in upper}
    lower_frames = {candidate.sample_index for candidate in lower}
    overlap = len(upper_frames & lower_frames) / max(
        1, min(len(upper_frames), len(lower_frames))
    )
    if overlap < 0.50:
        return False
    upper_bottom = median(
        candidate.center_y + candidate.height / 2 for candidate in upper
    )
    lower_top = median(
        candidate.center_y - candidate.height / 2 for candidate in lower
    )
    if lower_top - upper_bottom > 0.035:
        return False
    upper_x = median(candidate.center_x for candidate in upper)
    lower_x = median(candidate.center_x for candidate in lower)
    return abs(upper_x - lower_x) <= 0.20


def _score_cluster(
    candidates: list[_Candidate], *, sample_count: int, y_tolerance: float
) -> _ScoredCluster:
    by_frame: dict[int, list[_Candidate]] = defaultdict(list)
    for candidate in candidates:
        by_frame[candidate.sample_index].append(candidate)
    frame_indices = sorted(by_frame)
    frame_hits = len(frame_indices)
    frame_confidences = [
        fmean(candidate.confidence for candidate in by_frame[index])
        for index in frame_indices
    ]
    mean_confidence = fmean(frame_confidences)
    frequency = frame_hits / sample_count
    center_y = median(candidate.center_y for candidate in candidates)
    bottom_weight = _clamp((center_y - 0.25) / 0.70)
    spread = pstdev(candidate.center_y for candidate in candidates)
    concentration = 1 - min(1.0, spread / y_tolerance)
    horizontal_centering = fmean(
        max(0.0, 1 - abs(candidate.center_x - 0.5) / 0.5)
        for candidate in candidates
    )
    continuity = _continuity_score(frame_indices, sample_count)
    variation, dominant_text_ratio = _text_variation(by_frame)
    # Persistent watermarks and HUD labels can otherwise look like a perfect
    # subtitle cluster. A dominant unchanged string is negative evidence; a
    # real caption band normally changes text or disappears across 16 samples.
    static_text_penalty = (
        0.5 if frequency >= 0.60 and dominant_text_ratio >= 0.80 else 0.0
    )
    score = (
        frequency * 0.24
        + mean_confidence * 0.16
        + bottom_weight * 0.25
        + concentration * 0.12
        + horizontal_centering * 0.08
        + continuity * 0.07
        + variation * 0.08
        - static_text_penalty
    )
    return _ScoredCluster(candidates, score, frame_hits, mean_confidence)


def _continuity_score(frame_indices: list[int], sample_count: int) -> float:
    if not frame_indices:
        return 0.0
    longest_run = 1
    current_run = 1
    for previous, current in zip(frame_indices, frame_indices[1:]):
        if current == previous + 1:
            current_run += 1
            longest_run = max(longest_run, current_run)
        else:
            current_run = 1
    density = len(frame_indices) / (frame_indices[-1] - frame_indices[0] + 1)
    return (longest_run / sample_count + density) / 2


def _text_variation(
    by_frame: dict[int, list[_Candidate]],
) -> tuple[float, float]:
    frame_texts = []
    for candidates in by_frame.values():
        ordered = sorted(candidates, key=lambda candidate: candidate.box[0])
        text = " ".join(candidate.text for candidate in ordered).casefold()
        frame_texts.append(re.sub(r"\W+", "", text, flags=re.UNICODE))
    counts = Counter(text for text in frame_texts if text)
    unique_count = len(counts)
    target = max(2.0, len(frame_texts) * 0.35)
    dominant_ratio = max(counts.values(), default=0) / max(1, len(frame_texts))
    return min(1.0, unique_count / target), dominant_ratio


def _roi_for_cluster(
    candidates: list[_Candidate], frame_width: int, frame_height: int
) -> NormalizedROI:
    central = [
        candidate
        for candidate in candidates
        if 0.08 <= candidate.center_x <= 0.92 or candidate.width >= 0.30
    ] or candidates
    left = _percentile([candidate.box[0] / frame_width for candidate in central], 0.03)
    right = _percentile([candidate.box[2] / frame_width for candidate in central], 0.97)
    top = _percentile([candidate.box[1] / frame_height for candidate in candidates], 0.03)
    bottom = _percentile([candidate.box[3] / frame_height for candidate in candidates], 0.97)
    typical_height = median(candidate.height for candidate in candidates)

    horizontal_padding = max(0.04, typical_height * 1.2)
    vertical_padding = max(0.012, typical_height * 0.45)
    center_x = (left + right) / 2
    width = min(0.92, max(0.40, right - left + horizontal_padding * 2))
    x = _clamp(center_x - width / 2, 0, 1 - width)

    center_y = (top + bottom) / 2
    height = min(0.36, max(0.07, bottom - top + vertical_padding * 2))
    y = _clamp(center_y - height / 2, 0, 1 - height)
    return NormalizedROI(
        x=round(x, 6),
        y=round(y, 6),
        width=round(width, 6),
        height=round(height, 6),
    )


def _percentile(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * quantile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def _clamp(value: float, minimum: float = 0.0, maximum: float = 1.0) -> float:
    return min(maximum, max(minimum, value))
