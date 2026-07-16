import hashlib
import json
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
GROUND_TRUTH = PROJECT_ROOT / "data" / "ground_truth" / "test-video.visual.json"
OPTIONAL_SOURCE = (
    PROJECT_ROOT
    / "data"
    / "videos"
    / "40bd33ac-d916-4cd6-aa70-4468dfbe7292.mp4"
)


def _load_ground_truth() -> dict:
    return json.loads(GROUND_TRUTH.read_text(encoding="utf-8"))


def test_visual_ground_truth_order_and_frame_time_consistency() -> None:
    payload = _load_ground_truth()
    video = payload["video"]
    events = payload["events"]

    assert payload["schema_version"] == 2
    assert len(video["sha256"]) == 64
    assert payload["scope"]["event_count"] == len(events) == 58
    assert events[0]["first_frame"] == payload["scope"]["first_frame"]
    assert events[-1]["last_frame"] == payload["scope"]["last_frame"]

    annotation_roi = payload["annotation_roi"]
    for key in ("x", "y", "width", "height"):
        assert 0 < annotation_roi[key] <= 1
    assert annotation_roi["x"] + annotation_roi["width"] <= 1
    assert annotation_roi["y"] + annotation_roi["height"] <= 1
    roi_left = annotation_roi["x"] * video["width"]
    roi_top = annotation_roi["y"] * video["height"]
    roi_right = (annotation_roi["x"] + annotation_roi["width"]) * video["width"]
    roi_bottom = (annotation_roi["y"] + annotation_roi["height"]) * video["height"]

    # The large source video is deliberately optional so clean CI validates the
    # lightweight annotation alone. A local checkout containing it also checks
    # that the annotation still targets the intended bytes.
    if OPTIONAL_SOURCE.is_file():
        assert (
            hashlib.sha256(OPTIONAL_SOURCE.read_bytes()).hexdigest().upper()
            == video["sha256"]
        )

    for event in events:
        assert 0 <= event["first_frame"] <= event["last_frame"] < video["frame_count"]
        assert abs(event["start_time"] - event["first_frame"] / video["fps"]) < 1e-6
        assert (
            abs(event["end_time"] - (event["last_frame"] + 1) / video["fps"])
            < 1e-6
        )
        left, top, right, bottom = event["position"]
        assert 0 <= left < right <= video["width"]
        assert 0 <= top < bottom <= video["height"]
        assert roi_left <= left < right <= roi_right
        assert roi_top <= top < bottom <= roi_bottom
        tier = event["verification_tier"]
        assert tier in payload["verification_tiers"]
        assert 0 <= event["confidence"]["text"] <= 1
        assert 0 <= event["confidence"]["boundary"] <= 1
        assert event["boundary_uncertainty_frames"] >= 0
        if tier == "A":
            assert event["boundary_uncertainty_frames"] == 0

    for previous, current in zip(events, events[1:]):
        assert previous["first_frame"] < current["first_frame"]
        assert previous["last_frame"] < current["first_frame"]
        assert previous["start_time"] < current["start_time"]
        assert previous["end_time"] <= current["start_time"]


def test_declared_unannotated_ranges_are_exactly_the_coverage_gaps() -> None:
    payload = _load_ground_truth()
    video = payload["video"]
    events = payload["events"]
    expected_gaps = []
    cursor = 0
    for event in events:
        if cursor < event["first_frame"]:
            expected_gaps.append((cursor, event["first_frame"] - 1))
        cursor = event["last_frame"] + 1
    if cursor < video["frame_count"]:
        expected_gaps.append((cursor, video["frame_count"] - 1))

    declared_gaps = [
        (item["first_frame"], item["last_frame"])
        for item in payload["coverage"]["unannotated_frame_ranges"]
    ]
    assert declared_gaps == expected_gaps == [(0, 12), (144, 148)]
    assert payload["coverage"]["known_boundary_conflicts"] == []


def test_protect_yourself_window_uses_adjacent_frame_truth() -> None:
    payload = _load_ground_truth()
    by_text = {item["text"]: item for item in payload["events"]}
    protected = payload["regression_windows"][0]
    expected = [
        ("JUST TO", 1727, 1770),
        ("PROTECT YOURSELF", 1771, 1817),
        ("FROM BRAWLERS", 1818, 1872),
        ("LIKE MORTIS", 1873, 1917),
        ("I WOULD SAY", 1918, 1953),
    ]

    assert protected["first_frame"] == 1727
    assert protected["last_frame"] == 1953
    assert protected["event_texts"] == [text for text, _, _ in expected]
    for text, first_frame, last_frame in expected:
        event = by_text[text]
        assert (event["first_frame"], event["last_frame"]) == (
            first_frame,
            last_frame,
        )
        assert event["verification_tier"] == "A"

    visual = by_text["PROTECT YOURSELF"]
    assert visual["end_time"] - visual["start_time"] < 0.8
    assert "FROM BRAWLERS" not in visual["text"]
    assert by_text["YOU CAN PLAY"]["first_frame"] == 1954
