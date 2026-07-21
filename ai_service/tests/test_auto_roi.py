import json
from pathlib import Path

import pytest

from ai_service.ocr.base import DetectedText
from ai_service.roi.estimator import estimate_roi_from_observations


def _text(text: str, confidence: float, box: tuple[int, int, int, int]) -> DetectedText:
    return DetectedText(text=text, confidence=confidence, position=box)


def test_game_video_prefers_changing_bottom_captions_over_persistent_hud() -> None:
    observations = []
    captions = ["Find the gate", "Find the gate", "Take cover", "Take cover", "Move now"]
    for index in range(16):
        frame = [
            _text("PLAYER STATUS", 0.99, (700, 90, 1220, 145)),
            _text("AMMO READY", 0.98, (760, 970, 1160, 1020)),
        ]
        if 2 <= index <= 11:
            y = 850 + (index % 3 - 1) * 7
            frame.append(
                _text(captions[(index - 2) // 2], 0.92, (510, y, 1410, y + 70))
            )
        observations.append(frame)

    result = estimate_roi_from_observations(
        observations,
        frame_width=1920,
        frame_height=1080,
        confidence_threshold=0.55,
    )

    assert result is not None
    assert result.frame_hits == 10
    assert result.roi.y > 0.70
    assert result.roi.y + result.roi.height < 0.95
    assert result.roi.x < 510 / 1920
    assert result.roi.x + result.roi.width > 1410 / 1920


def test_recorded_game_video_ocr_replay_matches_the_annotated_caption_band() -> None:
    root = Path(__file__).resolve().parents[2]
    events = json.loads(
        (root / "data/subtitles/test-video/ocr_events.json").read_text(encoding="utf-8")
    )
    ground_truth = json.loads(
        (root / "data/ground_truth/test-video.visual.json").read_text(encoding="utf-8")
    )
    duration = ground_truth["video"]["duration"]
    observations = []
    for index in range(16):
        timestamp = index * duration / 15
        observations.append([
            _text(event["text"], event["confidence"], tuple(event["position"]))
            for event in events
            if event["start_time"] <= timestamp < event["end_time"]
        ])

    result = estimate_roi_from_observations(
        observations,
        frame_width=ground_truth["video"]["width"],
        frame_height=ground_truth["video"]["height"],
    )

    assert result is not None
    expected = ground_truth["annotation_roi"]
    expected_bottom = expected["y"] + expected["height"]
    actual_bottom = result.roi.y + result.roi.height
    vertical_intersection = max(
        0,
        min(expected_bottom, actual_bottom) - max(expected["y"], result.roi.y),
    )
    vertical_union = max(expected_bottom, actual_bottom) - min(expected["y"], result.roi.y)
    assert vertical_intersection / vertical_union >= 0.8
    assert result.roi.x == pytest.approx(expected["x"], abs=0.03)
    assert result.roi.width == pytest.approx(expected["width"], abs=0.05)


def test_bottom_subtitle_video_clusters_small_y_jitter_into_one_roi() -> None:
    observations = []
    for index, y in enumerate([850, 860, 845, 854, 848, 858, 851, 846, 856, 849, 853, 847]):
        observations.append([
            _text(f"Caption line {index // 3}", 0.88 + (index % 3) * 0.03, (620, y, 1300, y + 64))
        ])

    result = estimate_roi_from_observations(
        observations,
        frame_width=1920,
        frame_height=1080,
        confidence_threshold=0.55,
    )

    assert result is not None
    assert result.frame_hits == 12
    assert result.mean_confidence > 0.88
    assert 0.72 < result.roi.y < 0.82
    assert result.roi.height >= 0.07


def test_two_line_subtitles_are_merged_into_one_roi() -> None:
    observations = []
    for index in range(12):
        observations.append([
            _text(f"Upper line {index // 3}", 0.94, (560, 720, 1360, 770)),
            _text(f"Lower line {index // 3}", 0.95, (610, 790, 1310, 840)),
        ])

    result = estimate_roi_from_observations(
        observations,
        frame_width=1920,
        frame_height=1080,
    )

    assert result is not None
    assert result.roi.y < 720 / 1080
    assert result.roi.y + result.roi.height > 840 / 1080


def test_video_without_repeated_subtitles_returns_no_estimate() -> None:
    observations = [[] for _ in range(16)]
    observations[2] = [_text("SCENE TITLE", 0.95, (700, 480, 1220, 540))]
    observations[9] = [_text("blurred maybe", 0.55, (600, 860, 1320, 920))]

    assert estimate_roi_from_observations(
        observations,
        frame_width=1920,
        frame_height=1080,
        confidence_threshold=0.55,
    ) is None


def test_static_bottom_hud_is_not_mistaken_for_a_subtitle_band() -> None:
    observations = [
        [_text("AMMO READY", 0.98, (760, 900, 1160, 950))]
        for _ in range(16)
    ]

    assert estimate_roi_from_observations(
        observations,
        frame_width=1920,
        frame_height=1080,
        confidence_threshold=0.55,
    ) is None


def test_three_isolated_bottom_scene_titles_are_insufficient_evidence() -> None:
    observations = [[] for _ in range(16)]
    for index, text in zip([1, 8, 14], ["CHAPTER ONE", "BOSS FIGHT", "THE END"]):
        observations[index] = [_text(text, 0.99, (620, 850, 1300, 920))]

    assert estimate_roi_from_observations(
        observations,
        frame_width=1920,
        frame_height=1080,
    ) is None
