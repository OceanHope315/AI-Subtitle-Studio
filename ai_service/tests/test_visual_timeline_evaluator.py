import json
from pathlib import Path

import pytest

from ai_service.evaluation.visual_timeline import (
    TimelineEvent,
    compact_text,
    evaluate_visual_timeline,
    main,
    merge_simultaneous_multiline,
    monotonic_match,
    normalize_text,
    text_similarity,
)


def _truth_event(
    text: str,
    first_frame: int,
    last_frame: int,
    *,
    tier: str = "B",
    uncertainty: int = 2,
) -> dict:
    return {
        "text": text,
        "first_frame": first_frame,
        "last_frame": last_frame,
        "start_time": first_frame / 10,
        "end_time": (last_frame + 1) / 10,
        "position": [10, 20, 90, 40],
        "verification_tier": tier,
        "boundary_uncertainty_frames": uncertainty,
    }


def _write_payloads(
    tmp_path: Path, events: list[dict], predictions: list[dict]
) -> tuple[Path, Path]:
    truth_path = tmp_path / "sample.visual.json"
    prediction_path = tmp_path / "subtitle.json"
    truth_path.write_text(
        json.dumps({"video": {"fps": 10}, "events": events}), encoding="utf-8"
    )
    prediction_path.write_text(json.dumps(predictions), encoding="utf-8")
    return truth_path, prediction_path


def test_text_normalization_handles_multiline_punctuation_and_ocr_spacing() -> None:
    assert normalize_text("HOW TO PLAY /\nSIRIUS") == "how to play sirius"
    assert compact_text("Don’t  use-them") == "dontusethem"
    assert text_similarity("SO YOU HAVE TO", "so you ha ave to!") > 0.95
    assert text_similarity("YOU CAN PLAY", "YOUCAN PLA Y") == 1


def test_simultaneous_stacked_lines_are_merged_but_same_baseline_is_not() -> None:
    events = [
        TimelineEvent("HOW TO PLAY", 10, 29, (0,), (10, 100, 90, 140)),
        TimelineEvent("SIRIUS", 10, 29, (1,), (25, 135, 75, 175)),
        TimelineEvent("BY AUTHOR", 20, 29, (2,), (30, 190, 70, 205)),
        TimelineEvent("LEFT", 40, 49, (3,), (10, 300, 45, 330)),
        TimelineEvent("RIGHT", 40, 49, (4,), (50, 300, 90, 330)),
    ]

    merged = merge_simultaneous_multiline(events, fps=10)

    assert [event.text for event in merged] == [
        "HOW TO PLAY / SIRIUS",
        "BY AUTHOR",
        "LEFT",
        "RIGHT",
    ]
    assert merged[0].source_indices == (0, 1)
    assert (merged[0].start_frame, merged[0].end_frame) == (10, 29)


def test_monotonic_matching_uses_timing_to_disambiguate_repeated_text() -> None:
    truth = [
        TimelineEvent("GO", 0, 9, (0,)),
        TimelineEvent("GO", 20, 29, (1,)),
    ]
    prediction = [TimelineEvent("GO", 20, 29, (0,))]

    matches = monotonic_match(truth, prediction)

    assert len(matches) == 1
    assert matches[0].truth_index == 1
    assert matches[0].prediction_index == 0


def test_evaluation_reports_detection_text_boundaries_tier_a_and_unmatched(
    tmp_path: Path,
) -> None:
    truth_path, prediction_path = _write_payloads(
        tmp_path,
        [
            _truth_event("FIRST", 0, 9, tier="A", uncertainty=0),
            _truth_event("HOW TO PLAY / SIRIUS", 10, 29),
            _truth_event("MISSING", 30, 39),
        ],
        [
            {
                "text": "first!",
                "start_time": 0,
                "end_time": 1,
                "position": [20, 50, 80, 70],
            },
            {
                "text": "HOW TO PLAY",
                "start_time": 1,
                "end_time": 3,
                "position": [10, 100, 90, 140],
            },
            {
                "text": "SIRIUS",
                "start_time": 1,
                "end_time": 3,
                "position": [25, 135, 75, 175],
            },
            {
                "text": "EXTRA",
                "start_time": 4,
                "end_time": 5,
                "position": [20, 200, 80, 230],
            },
        ],
    )

    report = evaluate_visual_timeline(truth_path, prediction_path)

    assert report["counts"] == {
        "truth": 3,
        "prediction": 4,
        "evaluated_prediction": 3,
        "multiline_groups_merged": 1,
        "matched": 2,
        "false_positive": 1,
        "false_negative": 1,
    }
    assert report["detection"]["precision"] == pytest.approx(2 / 3, abs=1e-6)
    assert report["detection"]["recall"] == pytest.approx(2 / 3, abs=1e-6)
    assert report["text"]["normalized_exact_count"] == 2
    assert report["boundaries"]["start_frame_mae"] == 0
    assert report["boundaries"]["end_frame_mae"] == 0
    assert report["tier_a"]["passed"] is True
    assert report["tier_a"]["exact_both_count"] == 1
    assert [item["text"] for item in report["false_positives"]] == ["EXTRA"]
    assert [item["text"] for item in report["false_negatives"]] == ["MISSING"]


def test_tier_a_fails_and_reports_signed_boundary_errors(tmp_path: Path) -> None:
    truth_path, prediction_path = _write_payloads(
        tmp_path,
        [_truth_event("PROTECT YOURSELF", 10, 19, tier="A", uncertainty=0)],
        [
            {
                "text": "PROTECTYOURSELF",
                "first_frame": 11,
                "last_frame": 21,
            }
        ],
    )

    report = evaluate_visual_timeline(truth_path, prediction_path)
    tier_event = report["tier_a"]["events"][0]

    assert report["tier_a"]["passed"] is False
    assert tier_event["start_error_frames"] == 1
    assert tier_event["end_error_frames"] == 2
    assert report["boundaries"]["start_seconds_mae"] == 0.1
    assert report["boundaries"]["end_seconds_mae"] == 0.2


def test_cli_writes_json_and_prints_terminal_summary(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    truth_path, prediction_path = _write_payloads(
        tmp_path,
        [_truth_event("CAPTION", 0, 9, tier="A", uncertainty=0)],
        [{"text": "caption", "start_time": 0, "end_time": 1}],
    )
    output_path = tmp_path / "reports" / "evaluation.json"

    result = main([str(truth_path), str(prediction_path), "-o", str(output_path)])

    terminal = capsys.readouterr().out
    assert result == 0
    assert "precision=1.0000" in terminal
    assert "Tier A: matched=1/1 exact_both=1/1 result=PASS" in terminal
    assert json.loads(output_path.read_text(encoding="utf-8"))["counts"]["matched"] == 1


def test_rejects_invalid_threshold_and_missing_times(tmp_path: Path) -> None:
    truth_path, prediction_path = _write_payloads(
        tmp_path, [_truth_event("CAPTION", 0, 9)], [{"text": "CAPTION"}]
    )
    with pytest.raises(ValueError, match="text_threshold"):
        evaluate_visual_timeline(truth_path, prediction_path, text_threshold=0)
    with pytest.raises(ValueError, match="start_time"):
        evaluate_visual_timeline(truth_path, prediction_path)
