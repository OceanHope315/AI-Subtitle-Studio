from __future__ import annotations

import argparse
import json
import math
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Sequence


DEFAULT_TEXT_THRESHOLD = 0.72


@dataclass(frozen=True, slots=True)
class TimelineEvent:
    text: str
    start_frame: int
    end_frame: int
    source_indices: tuple[int, ...]
    position: tuple[float, float, float, float] | None = None
    verification_tier: str | None = None
    boundary_uncertainty_frames: int = 0

    @property
    def duration_frames(self) -> int:
        return self.end_frame - self.start_frame + 1


@dataclass(frozen=True, slots=True)
class EventMatch:
    truth_index: int
    prediction_index: int
    text_similarity: float
    normalized_exact: bool
    temporal_iou: float


def normalize_text(text: str) -> str:
    """Return a readable normalization suitable for visual-caption comparison."""

    value = unicodedata.normalize("NFKC", str(text)).casefold()
    value = value.translate(
        str.maketrans(
            {
                "\u2018": "'",
                "\u2019": "'",
                "\u201b": "'",
                "\u2032": "'",
                "\u2010": "-",
                "\u2011": "-",
                "\u2012": "-",
                "\u2013": "-",
                "\u2014": "-",
                "\n": " ",
                "\r": " ",
                "/": " ",
                "|": " ",
            }
        )
    )
    value = "".join(character if character.isalnum() else " " for character in value)
    return " ".join(value.split())


def compact_text(text: str) -> str:
    """Remove word boundaries so harmless OCR spacing errors compare as exact."""

    return "".join(normalize_text(text).split())


def text_similarity(expected: str, actual: str) -> float:
    """Character similarity after punctuation and OCR-spacing normalization."""

    left = compact_text(expected)
    right = compact_text(actual)
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    return SequenceMatcher(None, left, right, autojunk=False).ratio()


def evaluate_visual_timeline(
    ground_truth_path: str | Path,
    prediction_path: str | Path,
    *,
    text_threshold: float = DEFAULT_TEXT_THRESHOLD,
    merge_multiline: bool = True,
) -> dict[str, Any]:
    """Evaluate one subtitle/OCR artifact against a ``*.visual.json`` truth file.

    Matching is a maximum-cardinality, maximum-similarity monotonic alignment.
    It never maps one evaluated prediction to more than one truth event. Before
    matching, simultaneous vertically stacked prediction lines can be combined
    into a single semantic event.
    """

    truth_path = Path(ground_truth_path)
    predicted_path = Path(prediction_path)
    if not 0 < text_threshold <= 1:
        raise ValueError("text_threshold must be in the interval (0, 1]")

    truth_payload = _read_json(truth_path)
    fps, truth = _load_truth(truth_payload)
    raw_prediction_payload = _read_json(predicted_path)
    raw_predictions = _load_predictions(raw_prediction_payload, fps=fps)
    predictions = (
        merge_simultaneous_multiline(raw_predictions, fps=fps)
        if merge_multiline
        else raw_predictions
    )
    matches = monotonic_match(truth, predictions, text_threshold=text_threshold)
    return build_report(
        truth=truth,
        predictions=predictions,
        raw_prediction_count=len(raw_predictions),
        matches=matches,
        fps=fps,
        truth_path=truth_path,
        prediction_path=predicted_path,
        text_threshold=text_threshold,
        merge_multiline=merge_multiline,
    )


def monotonic_match(
    truth: Sequence[TimelineEvent],
    predictions: Sequence[TimelineEvent],
    *,
    text_threshold: float = DEFAULT_TEXT_THRESHOLD,
) -> list[EventMatch]:
    """Globally align events while preserving both timeline orders."""

    truth_count = len(truth)
    prediction_count = len(predictions)
    # Objective order: match cardinality, text quality, temporal overlap, then
    # lower centre-frame error. This keeps detection metrics stable while using
    # timing to disambiguate repeated phrases.
    zero = (0, 0.0, 0.0, 0)
    scores = [[zero for _ in range(prediction_count + 1)] for _ in range(truth_count + 1)]
    actions = [["" for _ in range(prediction_count + 1)] for _ in range(truth_count + 1)]

    for truth_index in range(1, truth_count + 1):
        actions[truth_index][0] = "skip_truth"
    for prediction_index in range(1, prediction_count + 1):
        actions[0][prediction_index] = "skip_prediction"

    for truth_index in range(1, truth_count + 1):
        expected = truth[truth_index - 1]
        for prediction_index in range(1, prediction_count + 1):
            actual = predictions[prediction_index - 1]
            candidates: list[tuple[tuple[int, float, float, int], int, str]] = [
                (scores[truth_index - 1][prediction_index], 1, "skip_truth"),
                (scores[truth_index][prediction_index - 1], 0, "skip_prediction"),
            ]
            similarity = text_similarity(expected.text, actual.text)
            if similarity >= text_threshold:
                overlap = _temporal_iou(expected, actual)
                centre_error = abs(
                    (expected.start_frame + expected.end_frame)
                    - (actual.start_frame + actual.end_frame)
                )
                previous = scores[truth_index - 1][prediction_index - 1]
                matched_score = (
                    previous[0] + 1,
                    previous[1] + similarity,
                    previous[2] + overlap,
                    previous[3] - centre_error,
                )
                # The priority makes a match win an otherwise exact tie.
                candidates.append((matched_score, 2, "match"))
            score, _, action = max(candidates, key=lambda item: (item[0], item[1]))
            scores[truth_index][prediction_index] = score
            actions[truth_index][prediction_index] = action

    aligned: list[EventMatch] = []
    truth_index = truth_count
    prediction_index = prediction_count
    while truth_index or prediction_index:
        action = actions[truth_index][prediction_index]
        if action == "match":
            expected = truth[truth_index - 1]
            actual = predictions[prediction_index - 1]
            aligned.append(
                EventMatch(
                    truth_index=truth_index - 1,
                    prediction_index=prediction_index - 1,
                    text_similarity=text_similarity(expected.text, actual.text),
                    normalized_exact=compact_text(expected.text) == compact_text(actual.text),
                    temporal_iou=_temporal_iou(expected, actual),
                )
            )
            truth_index -= 1
            prediction_index -= 1
        elif action == "skip_truth":
            truth_index -= 1
        elif action == "skip_prediction":
            prediction_index -= 1
        else:
            raise RuntimeError("invalid monotonic-alignment backtrace")
    aligned.reverse()
    return aligned


def merge_simultaneous_multiline(
    predictions: Sequence[TimelineEvent], *, fps: float
) -> list[TimelineEvent]:
    """Combine simultaneous, vertically stacked OCR lines into semantic cues."""

    if not predictions:
        return []
    merged: list[TimelineEvent] = []
    for event in predictions:
        if merged and _is_multiline_pair(merged[-1], event, fps=fps):
            merged[-1] = _merge_events(merged[-1], event)
        else:
            merged.append(event)
    return merged


def build_report(
    *,
    truth: Sequence[TimelineEvent],
    predictions: Sequence[TimelineEvent],
    raw_prediction_count: int,
    matches: Sequence[EventMatch],
    fps: float,
    truth_path: Path,
    prediction_path: Path,
    text_threshold: float,
    merge_multiline: bool,
) -> dict[str, Any]:
    truth_count = len(truth)
    prediction_count = len(predictions)
    matched_count = len(matches)
    precision = _safe_ratio(matched_count, prediction_count)
    recall = _safe_ratio(matched_count, truth_count)
    f1 = _safe_ratio(2 * precision * recall, precision + recall)
    matched_truth = {match.truth_index for match in matches}
    matched_predictions = {match.prediction_index for match in matches}

    match_rows = [
        _match_row(truth[match.truth_index], predictions[match.prediction_index], match)
        for match in matches
    ]
    start_errors = [abs(row["boundary"]["start_error_frames"]) for row in match_rows]
    end_errors = [abs(row["boundary"]["end_error_frames"]) for row in match_rows]
    exact_text_count = sum(match.normalized_exact for match in matches)
    within_uncertainty_count = sum(
        abs(row["boundary"]["start_error_frames"])
        <= row["truth"]["boundary_uncertainty_frames"]
        and abs(row["boundary"]["end_error_frames"])
        <= row["truth"]["boundary_uncertainty_frames"]
        for row in match_rows
    )

    tier_a_truth_indices = [
        index for index, event in enumerate(truth) if event.verification_tier == "A"
    ]
    by_truth_index = {match.truth_index: match for match in matches}
    tier_a_rows = []
    for truth_index in tier_a_truth_indices:
        expected = truth[truth_index]
        match = by_truth_index.get(truth_index)
        if match is None:
            tier_a_rows.append(
                {
                    "truth_index": truth_index,
                    "truth_text": expected.text,
                    "matched": False,
                    "exact_start": False,
                    "exact_end": False,
                    "exact_both": False,
                    "start_error_frames": None,
                    "end_error_frames": None,
                }
            )
            continue
        actual = predictions[match.prediction_index]
        start_error = actual.start_frame - expected.start_frame
        end_error = actual.end_frame - expected.end_frame
        tier_a_rows.append(
            {
                "truth_index": truth_index,
                "truth_text": expected.text,
                "prediction_index": match.prediction_index,
                "prediction_text": actual.text,
                "matched": True,
                "exact_start": start_error == 0,
                "exact_end": end_error == 0,
                "exact_both": start_error == 0 and end_error == 0,
                "start_error_frames": start_error,
                "end_error_frames": end_error,
            }
        )
    tier_a_matched_rows = [row for row in tier_a_rows if row["matched"]]
    tier_a_start_errors = [abs(row["start_error_frames"]) for row in tier_a_matched_rows]
    tier_a_end_errors = [abs(row["end_error_frames"]) for row in tier_a_matched_rows]
    tier_a_exact_both = sum(row["exact_both"] for row in tier_a_rows)

    false_positives = [
        _event_row(event, index=index)
        for index, event in enumerate(predictions)
        if index not in matched_predictions
    ]
    false_negatives = [
        _event_row(event, index=index)
        for index, event in enumerate(truth)
        if index not in matched_truth
    ]

    return {
        "schema_version": 1,
        "ground_truth": str(truth_path.resolve()),
        "prediction": str(prediction_path.resolve()),
        "fps": fps,
        "settings": {
            "text_threshold": text_threshold,
            "merge_simultaneous_multiline": merge_multiline,
        },
        "counts": {
            "truth": truth_count,
            "prediction": raw_prediction_count,
            "evaluated_prediction": prediction_count,
            "multiline_groups_merged": raw_prediction_count - prediction_count,
            "matched": matched_count,
            "false_positive": len(false_positives),
            "false_negative": len(false_negatives),
        },
        "detection": {
            "precision": _rounded(precision),
            "recall": _rounded(recall),
            "f1": _rounded(f1),
        },
        "text": {
            "normalized_exact_count": exact_text_count,
            "normalized_exact_rate": _rounded(_safe_ratio(exact_text_count, matched_count)),
            "mean_similarity": _rounded(
                _safe_mean([match.text_similarity for match in matches])
            ),
            "minimum_similarity": _rounded(
                min((match.text_similarity for match in matches), default=0.0)
            ),
        },
        "boundaries": {
            "start_frame_mae": _rounded(_safe_mean(start_errors)),
            "end_frame_mae": _rounded(_safe_mean(end_errors)),
            "start_seconds_mae": _rounded(_safe_mean(start_errors) / fps),
            "end_seconds_mae": _rounded(_safe_mean(end_errors) / fps),
            "within_truth_uncertainty_count": within_uncertainty_count,
            "within_truth_uncertainty_rate": _rounded(
                _safe_ratio(within_uncertainty_count, matched_count)
            ),
        },
        "tier_a": {
            "truth_count": len(tier_a_rows),
            "matched_count": len(tier_a_matched_rows),
            "exact_start_count": sum(row["exact_start"] for row in tier_a_rows),
            "exact_end_count": sum(row["exact_end"] for row in tier_a_rows),
            "exact_both_count": tier_a_exact_both,
            "start_frame_mae": _rounded(_safe_mean(tier_a_start_errors)),
            "end_frame_mae": _rounded(_safe_mean(tier_a_end_errors)),
            "passed": bool(tier_a_rows) and tier_a_exact_both == len(tier_a_rows),
            "events": tier_a_rows,
        },
        "matches": match_rows,
        "false_positives": false_positives,
        "false_negatives": false_negatives,
    }


def format_terminal_report(report: dict[str, Any]) -> str:
    counts = report["counts"]
    detection = report["detection"]
    text = report["text"]
    boundaries = report["boundaries"]
    tier_a = report["tier_a"]
    prediction_label = str(counts["prediction"])
    if counts["prediction"] != counts["evaluated_prediction"]:
        prediction_label += f" (semantic: {counts['evaluated_prediction']})"
    lines = [
        "Visual subtitle timeline evaluation",
        f"  Truth: {counts['truth']} | Prediction: {prediction_label} | Matched: {counts['matched']}",
        (
            "  Detection: "
            f"precision={detection['precision']:.4f} "
            f"recall={detection['recall']:.4f} f1={detection['f1']:.4f}"
        ),
        (
            "  Text: "
            f"exact={text['normalized_exact_count']}/{counts['matched']} "
            f"mean_similarity={text['mean_similarity']:.4f}"
        ),
        (
            "  Boundaries: "
            f"start_MAE={boundaries['start_frame_mae']:.3f} frames "
            f"end_MAE={boundaries['end_frame_mae']:.3f} frames"
        ),
        (
            "  Tier A: "
            f"matched={tier_a['matched_count']}/{tier_a['truth_count']} "
            f"exact_both={tier_a['exact_both_count']}/{tier_a['truth_count']} "
            f"result={'PASS' if tier_a['passed'] else 'FAIL'}"
        ),
    ]
    false_positives = report["false_positives"]
    false_negatives = report["false_negatives"]
    lines.append(f"  False positives ({len(false_positives)}):")
    lines.extend(_format_unmatched_row(row) for row in false_positives)
    if not false_positives:
        lines.append("    (none)")
    lines.append(f"  False negatives ({len(false_negatives)}):")
    lines.extend(_format_unmatched_row(row) for row in false_negatives)
    if not false_negatives:
        lines.append("    (none)")
    return "\n".join(lines)


def _load_truth(payload: Any) -> tuple[float, list[TimelineEvent]]:
    if not isinstance(payload, dict):
        raise ValueError("ground truth must be a JSON object")
    video = payload.get("video")
    events = payload.get("events")
    if not isinstance(video, dict) or not isinstance(events, list):
        raise ValueError("ground truth must contain video and events")
    fps = _positive_number(video.get("fps"), "video.fps")
    result: list[TimelineEvent] = []
    for index, item in enumerate(events):
        if not isinstance(item, dict):
            raise ValueError(f"ground-truth event {index} must be an object")
        result.append(
            TimelineEvent(
                text=_non_empty_text(item.get("text"), f"events[{index}].text"),
                start_frame=_non_negative_int(
                    item.get("first_frame"), f"events[{index}].first_frame"
                ),
                end_frame=_non_negative_int(
                    item.get("last_frame"), f"events[{index}].last_frame"
                ),
                source_indices=(index,),
                position=_optional_position(item.get("position"), f"events[{index}].position"),
                verification_tier=(
                    str(item["verification_tier"])
                    if item.get("verification_tier") is not None
                    else None
                ),
                boundary_uncertainty_frames=_non_negative_int(
                    item.get("boundary_uncertainty_frames", 0),
                    f"events[{index}].boundary_uncertainty_frames",
                ),
            )
        )
    _validate_events(result, label="ground-truth")
    return fps, result


def _load_predictions(payload: Any, *, fps: float) -> list[TimelineEvent]:
    if isinstance(payload, list):
        items = payload
    elif isinstance(payload, dict):
        items = next(
            (
                payload[key]
                for key in ("events", "subtitles", "items", "predictions")
                if isinstance(payload.get(key), list)
            ),
            None,
        )
        if items is None:
            raise ValueError("prediction JSON must be a list or contain an event list")
    else:
        raise ValueError("prediction JSON must be a list or object")

    result: list[TimelineEvent] = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise ValueError(f"prediction event {index} must be an object")
        if item.get("first_frame") is not None:
            start_frame = _non_negative_int(
                item.get("first_frame"), f"predictions[{index}].first_frame"
            )
        else:
            start_time = _non_negative_number(
                item.get("start_time"), f"predictions[{index}].start_time"
            )
            start_frame = max(0, int(round(start_time * fps)))
        if item.get("last_frame") is not None:
            end_frame = _non_negative_int(
                item.get("last_frame"), f"predictions[{index}].last_frame"
            )
        else:
            end_time = _non_negative_number(
                item.get("end_time"), f"predictions[{index}].end_time"
            )
            # Prediction end times use the same exclusive convention as SRT.
            end_frame = max(start_frame, int(round(end_time * fps)) - 1)
        result.append(
            TimelineEvent(
                text=_non_empty_text(item.get("text"), f"predictions[{index}].text"),
                start_frame=start_frame,
                end_frame=end_frame,
                source_indices=(index,),
                position=_optional_position(
                    item.get("position"), f"predictions[{index}].position"
                ),
            )
        )
    # OCR engines may emit simultaneous lines in either line order. Stable
    # sorting establishes a timeline while retaining the raw index in reports.
    result.sort(key=lambda event: (event.start_frame, event.end_frame, event.source_indices))
    _validate_events(result, label="prediction", require_non_overlapping=False)
    return result


def _validate_events(
    events: Sequence[TimelineEvent], *, label: str, require_non_overlapping: bool = True
) -> None:
    previous: TimelineEvent | None = None
    for index, event in enumerate(events):
        if event.end_frame < event.start_frame:
            raise ValueError(f"{label} event {index} ends before it starts")
        if previous is not None:
            if event.start_frame < previous.start_frame:
                raise ValueError(f"{label} events are not in chronological order")
            if require_non_overlapping and event.start_frame <= previous.end_frame:
                raise ValueError(f"{label} events overlap or are out of order")
        previous = event


def _is_multiline_pair(left: TimelineEvent, right: TimelineEvent, *, fps: float) -> bool:
    if left.position is None or right.position is None:
        return False
    frame_slop = max(2, int(round(fps * 0.06)))
    short_line_limit = max(3, int(round(fps * 0.12)))
    same_start = abs(left.start_frame - right.start_frame) <= frame_slop
    same_end = abs(left.end_frame - right.end_frame) <= frame_slop
    clipped_same_start = same_start and min(left.duration_frames, right.duration_frames) <= short_line_limit
    if not (same_start and (same_end or clipped_same_start)):
        return False

    left_x1, left_y1, left_x2, left_y2 = left.position
    right_x1, right_y1, right_x2, right_y2 = right.position
    left_height = left_y2 - left_y1
    right_height = right_y2 - right_y1
    if left_height <= 0 or right_height <= 0:
        return False
    left_centre_y = (left_y1 + left_y2) / 2
    right_centre_y = (right_y1 + right_y2) / 2
    centre_separation = abs(left_centre_y - right_centre_y)
    # Alternatives from the same OCR line often overlap almost completely;
    # actual stacked caption lines have materially separated vertical centres.
    if centre_separation < 0.65 * min(left_height, right_height):
        return False
    if centre_separation > 1.35 * max(left_height, right_height):
        return False
    vertical_overlap = max(0.0, min(left_y2, right_y2) - max(left_y1, right_y1))
    if vertical_overlap / min(left_height, right_height) > 0.6:
        return False

    horizontal_overlap = max(0.0, min(left_x2, right_x2) - max(left_x1, right_x1))
    narrower_width = min(left_x2 - left_x1, right_x2 - right_x1)
    return narrower_width > 0 and horizontal_overlap / narrower_width >= 0.35


def _merge_events(left: TimelineEvent, right: TimelineEvent) -> TimelineEvent:
    assert left.position is not None and right.position is not None
    ordered = sorted((left, right), key=lambda event: (event.position or (0, 0, 0, 0))[1])
    position = (
        min(left.position[0], right.position[0]),
        min(left.position[1], right.position[1]),
        max(left.position[2], right.position[2]),
        max(left.position[3], right.position[3]),
    )
    return TimelineEvent(
        text=" / ".join(event.text for event in ordered),
        start_frame=min(left.start_frame, right.start_frame),
        end_frame=max(left.end_frame, right.end_frame),
        source_indices=left.source_indices + right.source_indices,
        position=position,
    )


def _match_row(
    expected: TimelineEvent, actual: TimelineEvent, match: EventMatch
) -> dict[str, Any]:
    return {
        "truth": _event_row(expected, index=match.truth_index),
        "prediction": _event_row(actual, index=match.prediction_index),
        "text": {
            "similarity": _rounded(match.text_similarity),
            "normalized_exact": match.normalized_exact,
            "truth_normalized": normalize_text(expected.text),
            "prediction_normalized": normalize_text(actual.text),
        },
        "boundary": {
            "start_error_frames": actual.start_frame - expected.start_frame,
            "end_error_frames": actual.end_frame - expected.end_frame,
            "temporal_iou": _rounded(match.temporal_iou),
        },
    }


def _event_row(event: TimelineEvent, *, index: int) -> dict[str, Any]:
    row: dict[str, Any] = {
        "index": index,
        "source_indices": list(event.source_indices),
        "text": event.text,
        "start_frame": event.start_frame,
        "end_frame": event.end_frame,
    }
    if event.verification_tier is not None:
        row["verification_tier"] = event.verification_tier
        row["boundary_uncertainty_frames"] = event.boundary_uncertainty_frames
    if event.position is not None:
        row["position"] = list(event.position)
    return row


def _temporal_iou(left: TimelineEvent, right: TimelineEvent) -> float:
    overlap = max(
        0,
        min(left.end_frame, right.end_frame) - max(left.start_frame, right.start_frame) + 1,
    )
    union = max(left.end_frame, right.end_frame) - min(left.start_frame, right.start_frame) + 1
    return overlap / union if union > 0 else 0.0


def _format_unmatched_row(row: dict[str, Any]) -> str:
    return (
        f"    [{row['index']}] {row['start_frame']}-{row['end_frame']} "
        f"{row['text']}"
    )


def _read_json(path: Path) -> Any:
    if not path.is_file():
        raise ValueError(f"JSON file not found: {path}")
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON in {path}: {exc}") from exc


def _non_empty_text(value: Any, label: str) -> str:
    text = str(value).strip() if value is not None else ""
    if not text:
        raise ValueError(f"{label} must be non-empty")
    return text


def _positive_number(value: Any, label: str) -> float:
    number = _finite_number(value, label)
    if number <= 0:
        raise ValueError(f"{label} must be positive")
    return number


def _non_negative_number(value: Any, label: str) -> float:
    number = _finite_number(value, label)
    if number < 0:
        raise ValueError(f"{label} must be non-negative")
    return number


def _finite_number(value: Any, label: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{label} must be a finite number")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} must be a finite number") from exc
    if not math.isfinite(number):
        raise ValueError(f"{label} must be a finite number")
    return number


def _non_negative_int(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{label} must be a non-negative integer")
    return value


def _optional_position(
    value: Any, label: str
) -> tuple[float, float, float, float] | None:
    if value is None:
        return None
    if not isinstance(value, list) or len(value) != 4:
        raise ValueError(f"{label} must contain four numbers")
    position = tuple(_finite_number(item, label) for item in value)
    if position[0] >= position[2] or position[1] >= position[3]:
        raise ValueError(f"{label} must be [left, top, right, bottom]")
    return position  # type: ignore[return-value]


def _safe_ratio(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator else 0.0


def _safe_mean(values: Sequence[float | int]) -> float:
    return sum(values) / len(values) if values else 0.0


def _rounded(value: float) -> float:
    return round(value, 6)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Evaluate visual subtitle timing against *.visual.json ground truth"
    )
    parser.add_argument("ground_truth", type=Path)
    parser.add_argument("prediction", type=Path)
    parser.add_argument("--output", "-o", type=Path, help="write the full JSON report")
    parser.add_argument(
        "--text-threshold",
        type=float,
        default=DEFAULT_TEXT_THRESHOLD,
        help=f"minimum normalized text similarity (default: {DEFAULT_TEXT_THRESHOLD})",
    )
    parser.add_argument(
        "--no-merge-multiline",
        action="store_true",
        help="evaluate simultaneous OCR lines separately",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="print the full JSON report instead of the terminal summary",
    )
    args = parser.parse_args(argv)
    try:
        report = evaluate_visual_timeline(
            args.ground_truth,
            args.prediction,
            text_threshold=args.text_threshold,
            merge_multiline=not args.no_merge_multiline,
        )
    except ValueError as exc:
        parser.error(str(exc))

    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(format_terminal_report(report))
        if args.output:
            print(f"  JSON report: {args.output.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
