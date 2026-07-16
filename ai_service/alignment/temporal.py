from __future__ import annotations

import re
import uuid
from collections import defaultdict
from dataclasses import dataclass
from difflib import SequenceMatcher
from statistics import median

from ai_service.schemas import SubtitleItem


@dataclass(slots=True)
class OCRObservation:
    timestamp: float
    text: str
    confidence: float
    position: tuple[int, int, int, int]


@dataclass(slots=True)
class OCRFrameObservation:
    """All OCR candidates retained for one source frame."""

    frame_index: int
    timestamp: float
    candidates: list[OCRObservation]


def normalize_text(value: str) -> str:
    # ``\w`` keeps CJK and other Unicode letters. Underscores are separators,
    # not meaningful subtitle characters.
    return re.sub(r"[^\w']+", " ", value.casefold().replace("_", " ")).strip()


def text_similarity(left: str, right: str) -> float:
    left_norm, right_norm = normalize_text(left), normalize_text(right)
    if not left_norm or not right_norm:
        return 0.0
    if left_norm in right_norm or right_norm in left_norm:
        length_ratio = min(len(left_norm), len(right_norm)) / max(len(left_norm), len(right_norm))
        shorter = left_norm if len(left_norm) <= len(right_norm) else right_norm
        # Animated hard captions commonly reveal a phrase word-by-word. Treat a
        # multi-word containment as a strong continuation even while it grows.
        if len(shorter.split()) >= 2:
            return 0.72 + length_ratio * 0.28
        return length_ratio
    return SequenceMatcher(None, left_norm, right_norm).ratio()


def build_ocr_events(
    observations: list[OCRObservation],
    *,
    video_duration: float,
    sample_fps: float,
    similarity_threshold: float,
    max_missing_seconds: float,
    min_duration: float,
) -> list[SubtitleItem]:
    """Associate every OCR candidate into an independent visual track.

    Association happens once per timestamp so two candidates from the same
    frame can never overwrite one another. Tracks survive short OCR dropouts and
    progressive word reveals, but require compatible text and screen position.
    """

    if not observations:
        return []
    if sample_fps <= 0:
        raise ValueError("sample_fps must be greater than zero")
    interval = 1 / sample_fps
    by_time: dict[float, list[OCRObservation]] = defaultdict(list)
    for observation in observations:
        by_time[observation.timestamp].append(observation)

    tracks: list[list[OCRObservation]] = []
    for timestamp in sorted(by_time):
        candidates = by_time[timestamp]
        possible: list[tuple[float, int, int]] = []
        for track_index, track in enumerate(tracks):
            gap = timestamp - track[-1].timestamp
            if gap <= 0 or gap > max_missing_seconds + interval + 1e-6:
                continue
            representative = _representative(track)
            for candidate_index, candidate in enumerate(candidates):
                # Adding/removing an entire visual line is a semantic state
                # transition (for example title -> title/subtitle), not a
                # one-line progressive word reveal.
                if representative.text.count("\n") != candidate.text.count("\n"):
                    continue
                similarity = text_similarity(representative.text, candidate.text)
                representative_tokens = set(_tokens(representative.text))
                candidate_tokens = set(_tokens(candidate.text))
                progressive = bool(
                    representative_tokens
                    and candidate_tokens
                    and (
                        representative_tokens <= candidate_tokens
                        or candidate_tokens <= representative_tokens
                    )
                    and min(len(normalize_text(representative.text)),
                            len(normalize_text(candidate.text))) >= 4
                )
                if similarity < similarity_threshold and not progressive:
                    continue
                if progressive:
                    similarity = max(similarity, 0.70)
                spatial = _spatial_compatibility(representative.position, candidate.position)
                if spatial <= 0:
                    continue
                recency = max(0.0, 1 - gap / max(interval, max_missing_seconds + interval))
                possible.append((similarity * 0.75 + spatial * 0.2 + recency * 0.05,
                                 track_index, candidate_index))

        assigned_tracks: set[int] = set()
        assigned_candidates: set[int] = set()
        for _score, track_index, candidate_index in sorted(possible, reverse=True):
            if track_index in assigned_tracks or candidate_index in assigned_candidates:
                continue
            tracks[track_index].append(candidates[candidate_index])
            assigned_tracks.add(track_index)
            assigned_candidates.add(candidate_index)
        for candidate_index, candidate in enumerate(candidates):
            if candidate_index not in assigned_candidates:
                tracks.append([candidate])

    events: list[SubtitleItem] = []
    for track in tracks:
        representative = _representative(track)
        start = max(0.0, track[0].timestamp)
        end = min(video_duration, track[-1].timestamp + interval)
        if end - start < min_duration:
            continue
        events.append(
            SubtitleItem(
                id=str(uuid.uuid4()),
                text=representative.text,
                start_time=round(start, 3),
                end_time=round(max(end, start + min_duration), 3),
                confidence=round(sum(item.confidence for item in track) / len(track), 4),
                position=list(_union_boxes([item.position for item in track])),
                source="ocr",
            )
        )
    events.sort(key=lambda item: (item.start_time, item.end_time, item.position or []))
    return _merge_duplicate_tracks(events, interval=interval)


def refine_event_boundary(
    event: SubtitleItem,
    *,
    start_frames: list[OCRFrameObservation],
    end_frames: list[OCRFrameObservation],
    source_fps: float,
    video_duration: float,
    min_duration: float,
    similarity_threshold: float = 0.50,
) -> SubtitleItem:
    """Tighten one coarse event to matching source frames without changing text."""

    if source_fps <= 0:
        return event.model_copy(deep=True)
    start_matches = [
        frame for frame in start_frames
        if _frame_contains_event(frame, event, similarity_threshold)
    ]
    end_matches = [
        frame for frame in end_frames
        if _frame_contains_event(frame, event, similarity_threshold)
    ]
    start = min((frame.timestamp for frame in start_matches), default=event.start_time)
    end = max(
        ((frame.frame_index + 1) / source_fps for frame in end_matches),
        default=event.end_time,
    )
    start = max(0.0, min(start, video_duration))
    end = max(start + min_duration, min(end, video_duration))
    # A last-frame caption can leave less than min_duration before EOF. Pydantic
    # still requires a positive interval, so clamp the start rather than exceed
    # the actual video duration.
    if end > video_duration:
        end = video_duration
        start = max(0.0, min(start, end - min_duration))
    return event.model_copy(
        update={"start_time": round(start, 3), "end_time": round(end, 3)},
        deep=True,
    )


def frame_contains_event(
    frame: OCRFrameObservation,
    event: SubtitleItem,
    similarity_threshold: float = 0.50,
) -> bool:
    """Public predicate used by the bounded boundary-search implementation."""

    return _frame_contains_event(frame, event, similarity_threshold)


def filter_dominant_caption_events(
    events: list[SubtitleItem],
    *,
    roi_box: tuple[int, int, int, int],
    sample_fps: float,
) -> list[SubtitleItem]:
    """Reject geometry-static ROI noise without assuming a fixed caption style.

    The dominant baseline is inferred from this video's visual tracks. Tiny text
    is removed relative to that inferred height. Persistent compact labels and
    isolated edge labels are removed only when they are also displaced from the
    dominant caption geometry, preserving centered/wide captions that move and
    short words such as ``AND`` at normal subtitle size.
    """

    positioned = [event for event in events if event.position]
    if len(positioned) < 2:
        return events

    def dimensions(event: SubtitleItem) -> tuple[float, float, float, float]:
        box = event.position
        return (
            max(1.0, box[2] - box[0]),
            max(1.0, box[3] - box[1]),
            (box[0] + box[2]) / 2,
            (box[1] + box[3]) / 2,
        )

    seed = max(
        positioned,
        key=lambda candidate: sum(
            min(6.0, dimensions(other)[0] / dimensions(other)[1])
            * max(0.2, other.confidence)
            for other in positioned
            if abs(dimensions(other)[3] - dimensions(candidate)[3])
            <= max(18.0, dimensions(candidate)[1] * 0.55,
                   dimensions(other)[1] * 0.4)
        ),
    )
    seed_height, seed_center_y = dimensions(seed)[1], dimensions(seed)[3]
    dominant = [
        event for event in positioned
        if abs(dimensions(event)[3] - seed_center_y)
        <= max(18.0, seed_height * 0.55, dimensions(event)[1] * 0.4)
    ]
    dominant_center_y = median(dimensions(event)[3] for event in dominant)
    dominant_height = median(dimensions(event)[1] for event in dominant)
    roi_width = max(1.0, roi_box[2] - roi_box[0])
    roi_center_x = (roi_box[0] + roi_box[2]) / 2
    minimum_height = max(6.0, dominant_height * 0.30)
    persistent_seconds = max(1.2, 2.5 / max(0.25, sample_fps))

    output: list[SubtitleItem] = []
    for event in events:
        if not event.position:
            output.append(event)
            continue
        width, height, center_x, center_y = dimensions(event)
        if height < minimum_height:
            continue
        vertical_offset = abs(center_y - dominant_center_y)
        horizontal_offset = abs(center_x - roi_center_x)
        compact = width / height < 2.6
        persistent = event.end_time - event.start_time >= persistent_seconds
        displaced = (
            vertical_offset > dominant_height * 0.25
            or horizontal_offset > roi_width * 0.18
        )
        if persistent and compact and displaced:
            continue
        # Static bylines and team/brand labels can be wide, but are typically
        # materially smaller than the inferred caption font and off its line.
        if (
            persistent
            and height < dominant_height * 0.75
            and vertical_offset > dominant_height * 0.40
        ):
            continue
        if (
            height < dominant_height * 0.55
            and vertical_offset > dominant_height * 0.40
        ):
            continue
        # One-off menu/jersey labels tend to occupy a corner of a broad ROI.
        # Requiring both vertical and horizontal displacement keeps a caption
        # that merely moves up/down or a centered short word.
        if (
            vertical_offset > dominant_height * 0.60
            and horizontal_offset > roi_width * 0.20
            and width < roi_width * 0.55
        ):
            continue
        if (
            horizontal_offset > roi_width * 0.35
            and width < roi_width * 0.16
            and height < dominant_height * 0.80
        ):
            continue
        # A box exactly clipped by a manually drawn horizontal ROI edge is
        # usually partial HUD/menu text. Legitimate captions in a padded ROI
        # retain margin and caption-like height.
        edge_margin = max(3.0, roi_width * 0.01)
        touches_horizontal_edge = min(
            abs(event.position[0] - roi_box[0]),
            abs(roi_box[2] - event.position[2]),
        ) <= edge_margin
        if (
            touches_horizontal_edge
            and width < roi_width * 0.60
            and (
                height < dominant_height * 0.75
                or height > dominant_height * 1.20
            )
        ):
            continue
        output.append(event)
    return _suppress_temporal_caption_competitors(output)


def _suppress_temporal_caption_competitors(
    events: list[SubtitleItem],
) -> list[SubtitleItem]:
    """Drop weak HUD rows that wrap around a stronger caption track.

    A discovery frame can be noisier than the neighbouring coarse frame.  In
    that case Paddle may emit a low-confidence multiline box containing the
    real caption plus an unrelated row, and another attached HUD row.  The
    strong caption is already known temporally, so resolve the competition at
    event level instead of trusting one noisy frame.  Genuine progressive
    two-line titles are retained because their confidence is comparable.
    """

    removed: set[int] = set()
    wins: list[tuple[int, int]] = []
    for left_index, left in enumerate(events):
        if not left.position:
            continue
        for right_index in range(left_index + 1, len(events)):
            right = events[right_index]
            if not right.position or not _events_substantially_overlap(left, right):
                continue
            for expanded_index, strong_index in (
                (left_index, right_index),
                (right_index, left_index),
            ):
                expanded, strong = events[expanded_index], events[strong_index]
                if "\n" not in expanded.text or "\n" in strong.text:
                    continue
                if not _tokens_contained(_tokens(expanded.text), _tokens(strong.text)):
                    continue
                if strong.confidence < 0.96 or strong.confidence - expanded.confidence < 0.06:
                    continue
                if _box_overlap_over_smaller(
                    tuple(expanded.position), tuple(strong.position)
                ) < 0.88:
                    continue
                removed.add(expanded_index)
                wins.append((strong_index, expanded_index))
                break

    for strong_index, expanded_index in wins:
        strong, expanded = events[strong_index], events[expanded_index]
        for candidate_index, candidate in enumerate(events):
            if (
                candidate_index in removed
                or candidate_index in {strong_index, expanded_index}
                or not candidate.position
            ):
                continue
            if strong.confidence - candidate.confidence < 0.06:
                continue
            if not _events_substantially_overlap(strong, candidate):
                continue
            if not _events_substantially_overlap(expanded, candidate):
                continue
            if _box_overlap_over_smaller(
                tuple(expanded.position), tuple(candidate.position)
            ) < 0.08:
                continue
            if _boxes_form_stacked_rows(
                tuple(strong.position), tuple(candidate.position)
            ):
                removed.add(candidate_index)

    return [event for index, event in enumerate(events) if index not in removed]


def _events_substantially_overlap(left: SubtitleItem, right: SubtitleItem) -> bool:
    intersection = min(left.end_time, right.end_time) - max(
        left.start_time, right.start_time
    )
    shorter = min(
        left.end_time - left.start_time,
        right.end_time - right.start_time,
    )
    return shorter > 0 and intersection / shorter >= 0.55


def _boxes_form_stacked_rows(
    left: tuple[int, int, int, int], right: tuple[int, int, int, int]
) -> bool:
    top, bottom = sorted((left, right), key=_center_y)
    top_height = max(1, top[3] - top[1])
    bottom_height = max(1, bottom[3] - bottom[1])
    if min(top_height, bottom_height) / max(top_height, bottom_height) < 0.72:
        return False
    center_delta = _center_y(bottom) - _center_y(top)
    if not max(top_height, bottom_height) * 0.52 <= center_delta <= max(
        top_height, bottom_height
    ) * 1.25:
        return False
    horizontal_overlap = max(0, min(top[2], bottom[2]) - max(top[0], bottom[0]))
    smaller_width = max(1, min(top[2] - top[0], bottom[2] - bottom[0]))
    return horizontal_overlap / smaller_width >= 0.60


def fuse_with_whisper(
    ocr_events: list[SubtitleItem], whisper_segments: list[SubtitleItem]
) -> list[SubtitleItem]:
    """Use ASR only as a bounded spelling aid for visual OCR events.

    There is exactly one result per OCR event. OCR timings and positions are
    copied unchanged; unmatched Whisper speech is deliberately ignored so a
    later spoken sentence can never be injected into the current hard caption.
    """

    if not ocr_events:
        return []
    if not whisper_segments:
        result = [item.model_copy(deep=True) for item in ocr_events]
        result.sort(key=lambda item: (item.start_time, item.end_time))
        return _resolve_sequential_overlaps(result)

    result: list[SubtitleItem] = []
    for event in ocr_events:
        best: tuple[float, str] | None = None
        for speech in whisper_segments:
            if not _overlap(
                event.start_time,
                event.end_time,
                max(0.0, speech.start_time - 0.45),
                speech.end_time + 0.45,
            ):
                continue
            match = _bounded_whisper_match(
                event.text, speech.text, ocr_confidence=event.confidence
            )
            if match is not None and (best is None or match[0] > best[0]):
                best = match

        if best is None:
            result.append(event.model_copy(deep=True))
            continue
        _score, correction = best
        # Exact normalized matches merely verify the OCR; retain the visual
        # capitalization and punctuation instead of rewriting it from speech.
        text = event.text if normalize_text(correction) == normalize_text(event.text) else correction
        whisper_confidence = max(
            (
                speech.confidence
                for speech in whisper_segments
                if _overlap(event.start_time, event.end_time,
                            max(0.0, speech.start_time - 0.45), speech.end_time + 0.45)
            ),
            default=0.0,
        )
        result.append(
            event.model_copy(
                update={
                    "text": text,
                    "confidence": round(
                        min(1.0, event.confidence * 0.75 + whisper_confidence * 0.25), 4
                    ),
                    "source": "ocr+whisper",
                },
                deep=True,
            )
        )
    result.sort(key=lambda item: (item.start_time, item.end_time))
    return _resolve_sequential_overlaps(result)


def _bounded_whisper_match(
    ocr_text: str,
    speech_text: str,
    *,
    ocr_confidence: float = 0.0,
) -> tuple[float, str] | None:
    ocr_tokens = _tokens(ocr_text)
    raw_speech_tokens = re.findall(r"[^\W_]+(?:'[^\W_]+)?", speech_text, re.UNICODE)
    speech_tokens = [normalize_text(token) for token in raw_speech_tokens]
    speech_tokens = [token for token in speech_tokens if token]
    if not ocr_tokens or not speech_tokens:
        return None

    count = len(ocr_tokens)
    # Never search a shorter window: Whisper is not allowed to delete a visual
    # word. A +2 window is considered only for compact-space exact repairs such
    # as BUTONMANY -> but on many.
    lengths = range(count, min(len(speech_tokens), count + 2) + 1)
    candidates: list[tuple[float, float, int, str, str]] = []
    normalized_ocr = " ".join(ocr_tokens)
    compact_ocr = _compact_text(normalized_ocr)
    for length in lengths:
        for start in range(0, len(speech_tokens) - length + 1):
            normalized_candidate = " ".join(speech_tokens[start:start + length])
            char_score = SequenceMatcher(None, normalized_ocr, normalized_candidate).ratio()
            token_score = SequenceMatcher(
                None, ocr_tokens, speech_tokens[start:start + length]
            ).ratio()
            score = char_score * 0.6 + token_score * 0.4
            rendered = " ".join(raw_speech_tokens[start:start + length])
            length_delta = abs(length - count)
            # Shorter windows often win raw edit similarity simply by deleting
            # the noisy OCR token ("T WOULD SAY" -> "would say"). Penalize a
            # token-count mismatch, but only mildly enough that a clearly better
            # count+1 window can still restore one genuinely missed word.
            adjusted_score = score - 0.10 * length_delta
            candidates.append(
                (adjusted_score, score, -length_delta, rendered, normalized_candidate)
            )
    if not candidates:
        return None

    compact_exact = [
        candidate for candidate in candidates
        if _compact_text(candidate[4]) == compact_ocr
    ]
    if compact_exact:
        _adjusted, _score, _length_penalty, rendered, _normalized = max(
            compact_exact, key=lambda item: (item[2], item[0])
        )
        return 1.0, rendered

    # Near-certain visual text may only be reformatted by Whisper (the compact
    # exact branch above).  Even a one-character edit can change meaning, such
    # as plural ``OTHERMAPS`` being rewritten as singular ``other map``.
    if ocr_confidence >= 0.97:
        return None

    if ocr_confidence >= 0.90:
        spelling_repairs = [
            candidate for candidate in candidates
            if _edit_distance(_compact_text(candidate[4]), compact_ocr) <= 1
            and len(candidate[4].split()) >= count
        ]
        if not spelling_repairs:
            return None
        _adjusted, score, _length_penalty, rendered, _normalized = max(
            spelling_repairs, key=lambda item: (item[0], item[1], item[2])
        )
        return score, rendered

    low_confidence_candidates = [
        candidate for candidate in candidates
        if len(candidate[4].split()) <= count + 1
    ]
    if not low_confidence_candidates:
        return None
    _adjusted, score, _length_penalty, rendered, _normalized = max(
        low_confidence_candidates, key=lambda item: (item[0], item[1], item[2])
    )
    if score < 0.72:
        return None
    return score, rendered


def _compact_text(value: str) -> str:
    return re.sub(r"[^\w]+", "", value.casefold(), flags=re.UNICODE)


def _edit_distance(left: str, right: str) -> int:
    if left == right:
        return 0
    if not left:
        return len(right)
    if not right:
        return len(left)
    previous = list(range(len(right) + 1))
    for left_index, left_character in enumerate(left, start=1):
        current = [left_index]
        for right_index, right_character in enumerate(right, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[right_index] + 1,
                    previous[right_index - 1] + (left_character != right_character),
                )
            )
        previous = current
    return previous[-1]


def _tokens(text: str) -> list[str]:
    normalized = normalize_text(text)
    return [token for token in normalized.split() if token]


def _frame_contains_event(
    frame: OCRFrameObservation,
    event: SubtitleItem,
    similarity_threshold: float,
) -> bool:
    event_box = tuple(event.position) if event.position else None
    event_tokens = set(_tokens(event.text))
    for candidate in frame.candidates:
        similarity = text_similarity(event.text, candidate.text)
        candidate_tokens = set(_tokens(candidate.text))
        progressive = bool(
            candidate_tokens
            and event_tokens
            and candidate_tokens <= event_tokens
            and len(normalize_text(candidate.text)) >= 4
        )
        if similarity < similarity_threshold and not progressive:
            continue
        if event_box is not None and _spatial_compatibility(event_box, candidate.position) <= 0:
            continue
        return True
    return False


def _representative(track: list[OCRObservation]) -> OCRObservation:
    return max(track, key=lambda item: (len(normalize_text(item.text)), item.confidence))


def _spatial_compatibility(
    left: tuple[int, int, int, int], right: tuple[int, int, int, int]
) -> float:
    left_height = max(1, left[3] - left[1])
    right_height = max(1, right[3] - right[1])
    vertical_overlap = max(0, min(left[3], right[3]) - max(left[1], right[1]))
    overlap_ratio = vertical_overlap / min(left_height, right_height)
    y_distance = abs(_center_y(left) - _center_y(right))
    center_tolerance = max(8.0, (left_height + right_height) / 2 * 0.35)
    if overlap_ratio < 0.50 and y_distance > center_tolerance:
        return 0.0
    left_center_x = (left[0] + left[2]) / 2
    right_center_x = (right[0] + right[2]) / 2
    horizontal_tolerance = max(100.0, (left[2] - left[0] + right[2] - right[0]) * 0.75)
    if abs(left_center_x - right_center_x) > horizontal_tolerance:
        return 0.0
    center_score = max(0.0, 1 - y_distance / max(1.0, center_tolerance))
    return max(0.05, overlap_ratio, center_score)


def _merge_duplicate_tracks(
    events: list[SubtitleItem], *, interval: float
) -> list[SubtitleItem]:
    output: list[SubtitleItem] = []
    for event in events:
        duplicate_index = next(
            (
                index for index in range(len(output) - 1, -1, -1)
                if _duplicate_track_kind(output[index], event, interval) is not None
            ),
            None,
        )
        if duplicate_index is None:
            output.append(event)
            continue
        duplicate = output[duplicate_index]
        kind = _duplicate_track_kind(duplicate, event, interval)
        if kind == "contained":
            # A nested word track often lingers one OCR frame beyond the full
            # caption. Prefer the full text track's own timing so it cannot
            # stretch into the next visual cue.
            preferred = max(
                (duplicate, event),
                key=lambda item: (len(_tokens(item.text)), len(normalize_text(item.text))),
            ).model_copy(deep=True)
            preferred.confidence = round(
                max(duplicate.confidence, event.confidence), 4
            )
            if duplicate.position and event.position:
                preferred.position = list(_union_boxes(
                    [tuple(duplicate.position), tuple(event.position)]
                ))
            output[duplicate_index] = preferred
            continue

        duplicate.start_time = min(duplicate.start_time, event.start_time)
        duplicate.end_time = max(duplicate.end_time, event.end_time)
        duplicate.confidence = round(max(duplicate.confidence, event.confidence), 4)
        if len(normalize_text(event.text)) > len(normalize_text(duplicate.text)):
            duplicate.text = event.text
        if duplicate.position and event.position:
            duplicate.position = list(_union_boxes(
                [tuple(duplicate.position), tuple(event.position)]
            ))
    return output


def _duplicate_track_kind(
    left: SubtitleItem, right: SubtitleItem, interval: float
) -> str | None:
    if left.text.count("\n") != right.text.count("\n"):
        return None
    if not _overlap(left.start_time, left.end_time, right.start_time, right.end_time):
        return None
    if left.position and right.position:
        if _box_overlap_over_smaller(tuple(left.position), tuple(right.position)) < 0.45:
            return None
    elif left.position != right.position:
        return None

    if text_similarity(left.text, right.text) >= 0.92:
        return "same"

    left_tokens, right_tokens = _tokens(left.text), _tokens(right.text)
    if not _tokens_contained(left_tokens, right_tokens):
        return None
    intersection = min(left.end_time, right.end_time) - max(left.start_time, right.start_time)
    shorter_duration = min(
        left.end_time - left.start_time,
        right.end_time - right.start_time,
    )
    if shorter_duration <= 0 or intersection / shorter_duration < 0.60:
        return None
    longer = max(
        (left, right),
        key=lambda item: (len(_tokens(item.text)), len(normalize_text(item.text))),
    )
    shorter = right if longer is left else left
    # If the short form clearly starts first, it is a sequential progressive
    # state rather than a nested same-frame Paddle detection.
    if shorter.start_time + interval * 0.5 < longer.start_time:
        return None
    return "contained"


def _tokens_contained(left: list[str], right: list[str]) -> bool:
    if not left or not right or left == right:
        return False
    shorter, longer = (left, right) if len(left) < len(right) else (right, left)
    if len(shorter) == len(longer):
        return False
    return any(
        longer[index:index + len(shorter)] == shorter
        for index in range(len(longer) - len(shorter) + 1)
    )


def _box_overlap_over_smaller(
    left: tuple[int, int, int, int], right: tuple[int, int, int, int]
) -> float:
    intersection_width = max(0, min(left[2], right[2]) - max(left[0], right[0]))
    intersection_height = max(0, min(left[3], right[3]) - max(left[1], right[1]))
    intersection = intersection_width * intersection_height
    left_area = max(1, left[2] - left[0]) * max(1, left[3] - left[1])
    right_area = max(1, right[2] - right[0]) * max(1, right[3] - right[1])
    return intersection / min(left_area, right_area)


def _resolve_sequential_overlaps(items: list[SubtitleItem]) -> list[SubtitleItem]:
    """Resolve coarse overlap only for captions occupying the same visual line."""

    for previous, current in zip(items, items[1:]):
        same_line = (
            not previous.position
            or not current.position
            or _spatial_compatibility(tuple(previous.position), tuple(current.position)) > 0
        )
        same_stream = (
            bool(previous.position and current.position)
            and _same_caption_stream(
                tuple(previous.position), tuple(current.position)
            )
        )
        simultaneous = abs(previous.start_time - current.start_time) <= 0.005
        if (
            (same_line or same_stream)
            and not simultaneous
            and previous.end_time > current.start_time
        ):
            previous.end_time = round(
                max(previous.start_time + 0.05, current.start_time), 3
            )
    return items


def _same_caption_stream(
    left: tuple[int, int, int, int], right: tuple[int, int, int, int]
) -> bool:
    """Recognize a sequential caption row that jumps vertically at a scene cut."""

    left_width, right_width = max(1, left[2] - left[0]), max(1, right[2] - right[0])
    left_height, right_height = max(1, left[3] - left[1]), max(1, right[3] - right[1])
    if min(left_height, right_height) / max(left_height, right_height) < 0.72:
        return False
    center_y_delta = abs(_center_y(left) - _center_y(right))
    if center_y_delta > (left_height + right_height) / 2 * 2.5:
        return False
    left_center_x = (left[0] + left[2]) / 2
    right_center_x = (right[0] + right[2]) / 2
    if abs(left_center_x - right_center_x) > max(24.0, min(left_width, right_width) * 0.25):
        return False
    horizontal_overlap = max(0, min(left[2], right[2]) - max(left[0], right[0]))
    return horizontal_overlap / min(left_width, right_width) >= 0.50


def _overlap(left_start: float, left_end: float, right_start: float, right_end: float) -> bool:
    return min(left_end, right_end) > max(left_start, right_start)


def _center_y(box: tuple[int, int, int, int]) -> float:
    return (box[1] + box[3]) / 2


def _union_boxes(boxes: list[tuple[int, int, int, int]]) -> tuple[int, int, int, int]:
    return (
        min(box[0] for box in boxes),
        min(box[1] for box in boxes),
        max(box[2] for box in boxes),
        max(box[3] for box in boxes),
    )
