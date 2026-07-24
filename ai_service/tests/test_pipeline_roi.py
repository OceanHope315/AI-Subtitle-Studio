from pathlib import Path
import json

import cv2
import numpy as np

from ai_service.alignment.temporal import OCRFrameObservation, OCRObservation
from ai_service.config import Settings
from ai_service.ocr.base import DetectedText
from ai_service.pipeline import (
    SubtitlePipeline,
    _caption_focus_box,
    _selective_transition_observations,
    _short_event_probe_indices,
)
from ai_service.schemas import NormalizedROI, SubtitleItem, VideoMetadata
from ai_service.video.reader import SampledFrame


class RecordingOCR:
    name = "recording"

    def __init__(self) -> None:
        self.calls = []

    def detect(
        self, image, offset_y=0, offset_x=0, *, apply_layout_filter=True
    ):
        self.calls.append((image.shape[:2], offset_x, offset_y, apply_layout_filter))
        return [
            DetectedText("TOP CAPTION", 0.95, (offset_x + 5, offset_y + 5,
                                                offset_x + 45, offset_y + 12)),
            DetectedText("BOTTOM CAPTION", 0.96, (offset_x + 5, offset_y + 48,
                                                   offset_x + 50, offset_y + 55)),
        ]


class BrightCaptionOCR:
    name = "bright-caption"

    def __init__(self) -> None:
        self.call_count = 0

    def detect(
        self, image, offset_y=0, offset_x=0, *, apply_layout_filter=True
    ):
        self.call_count += 1
        if float(image.mean()) < 100:
            return []
        return [
            DetectedText(
                "PROTECT YOURSELF",
                0.98,
                (offset_x + 2, offset_y + 2, offset_x + 58, offset_y + 18),
            )
        ]


class FragmentAndBrandOCR:
    name = "fragments-and-brand"

    def detect(
        self, image, offset_y=0, offset_x=0, *, apply_layout_filter=True
    ):
        return [
            DetectedText("THE FIRST", 0.97, (20, 50, 55, 65)),
            DetectedText("GADGET", 0.98, (53, 50, 85, 65)),
            DetectedText("BRAND", 0.99, (2, 10, 20, 18)),
        ]


class NoisyCaptionOCR:
    name = "noisy-caption"

    def detect(
        self, image, offset_y=0, offset_x=0, *, apply_layout_filter=True
    ):
        return [
            DetectedText(
                "WATCN OUT",
                0.7,
                (offset_x + 10, offset_y + 10, offset_x + 70, offset_y + 30),
            )
        ]


class CorrectingWhisper:
    def transcribe(self, _video_path, language=None):
        return [
            SubtitleItem(
                id="speech",
                text="watch out",
                start_time=0,
                end_time=1,
                confidence=0.95,
                source="whisper",
            )
        ]


def test_pipeline_applies_explicit_roi_and_keeps_every_candidate(tmp_path: Path) -> None:
    path = tmp_path / "pipeline.mp4"
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 10, (100, 100))
    for _ in range(10):
        writer.write(np.zeros((100, 100, 3), dtype=np.uint8))
    writer.release()

    ocr = RecordingOCR()
    configured = Settings(
        data_dir=tmp_path,
        sample_fps=2,
        enable_whisper=False,
        refine_boundaries=True,
    )
    result = SubtitlePipeline(configured, ocr_engine=ocr).process(
        path,
        tmp_path / "output",
        enable_whisper=False,
        roi=NormalizedROI(x=0.2, y=0.2, width=0.6, height=0.6),
    )

    assert result.ocr_event_count == 2
    assert {item.text for item in result.subtitles} == {"TOP CAPTION", "BOTTOM CAPTION"}
    assert ocr.calls
    assert all(call == ((60, 60), 20, 20, False) for call in ocr.calls)
    diagnostics_path = Path(result.artifacts["diagnostics_json"])
    diagnostics = json.loads(diagnostics_path.read_text(encoding="utf-8"))
    assert diagnostics["roi"] == {"x": 0.2, "y": 0.2, "width": 0.6, "height": 0.6}
    assert diagnostics["roi_source"] == "manual"
    assert diagnostics["video"]["source_fps"] == 10
    assert diagnostics["sampling"]["sample_fps"] == 2
    assert diagnostics["sampling"]["coarse_observation_count"] == 4
    assert diagnostics["sampling"]["coarse_event_count"] == 2
    assert diagnostics["boundary_refinement"]["enabled"] is True
    assert diagnostics["boundary_refinement"]["ocr_budget_per_boundary"] == 2
    assert diagnostics["final_ocr_event_count"] == 2
    assert all("start_frame" in event and "confidence" in event
               for event in diagnostics["events"])


def test_visual_track_remains_raw_ocr_when_legacy_whisper_corrects_final_track(
    tmp_path: Path,
) -> None:
    path = tmp_path / "independent-tracks.mp4"
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 10, (100, 100))
    for _ in range(10):
        writer.write(np.zeros((100, 100, 3), dtype=np.uint8))
    writer.release()

    configured = Settings(
        data_dir=tmp_path,
        sample_fps=2,
        enable_whisper=True,
        refine_boundaries=False,
        discover_short_events=False,
    )
    result = SubtitlePipeline(
        configured,
        ocr_engine=NoisyCaptionOCR(),
        whisper_engine=CorrectingWhisper(),
    ).process(
        path,
        tmp_path / "independent-output",
        enable_whisper=True,
        roi=NormalizedROI(x=0.1, y=0.5, width=0.8, height=0.3),
    )

    assert result.visual_subtitles[0].text == "WATCN OUT"
    assert result.visual_subtitles[0].bbox is not None
    assert result.subtitles[0].text == "watch out"


def test_selective_refinement_is_frame_accurate_with_bounded_ocr_calls(
    tmp_path: Path,
) -> None:
    path = tmp_path / "transition.mp4"
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 10, (100, 100))
    for frame_index in range(20):
        image = np.zeros((100, 100, 3), dtype=np.uint8)
        if 7 <= frame_index <= 14:
            image[60:80, 20:80] = 255
        writer.write(image)
    writer.release()

    ocr = BrightCaptionOCR()
    configured = Settings(
        data_dir=tmp_path,
        sample_fps=2,
        enable_whisper=False,
        refine_boundaries=True,
        boundary_ocr_budget=2,
    )
    result = SubtitlePipeline(configured, ocr_engine=ocr).process(
        path,
        tmp_path / "transition-output",
        enable_whisper=False,
        roi=NormalizedROI(x=0.2, y=0.6, width=0.6, height=0.2),
    )

    assert len(result.subtitles) == 1
    assert result.subtitles[0].text == "PROTECT YOURSELF"
    assert result.subtitles[0].start_time == 0.7
    assert result.subtitles[0].end_time == 1.5
    # Four coarse samples plus at most two new OCR calls for each boundary.
    assert ocr.call_count <= 4 + 2 * configured.boundary_ocr_budget


def test_boundary_search_prefers_local_caption_change_over_moving_background() -> None:
    event = SubtitleItem(
        id="caption", text="OLD CAPTION", start_time=0, end_time=1,
        confidence=0.95, position=[35, 55, 65, 70]
    )
    frames = []
    for index in range(10):
        image = np.zeros((100, 100, 3), dtype=np.uint8)
        # A much larger gameplay change occurs first, outside the caption box.
        if index >= 2:
            image[:35] = 255
        # The actual caption disappears between frames 4 and 5.
        if index < 5:
            image[58:67, 40:60] = 255
        frames.append(SampledFrame(image, index, index / 10, 0, 0))

    def observed(index: int, present: bool) -> OCRFrameObservation:
        candidates = [] if not present else [
            OCRObservation(index / 10, "OLD CAPTION", 0.95, (35, 55, 65, 70))
        ]
        return OCRFrameObservation(index, index / 10, candidates)

    cache = {0: observed(0, True), 9: observed(9, False)}
    calls = []

    def observe(frame: SampledFrame):
        if len(calls) >= 2:
            return None
        calls.append(frame.frame_index)
        value = observed(frame.frame_index, frame.frame_index < 5)
        cache[frame.frame_index] = value
        return value

    matches = _selective_transition_observations(
        frames,
        event,
        direction="end",
        observe=observe,
        cached=cache,
        similarity_threshold=0.5,
    )
    assert [frame.frame_index for frame in matches] == [4]
    assert calls == [4, 5]


def test_pipeline_composes_fragments_and_drops_persistent_roi_brand(tmp_path: Path) -> None:
    path = tmp_path / "fragment-fixture.mp4"
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 10, (100, 100))
    for _ in range(20):
        writer.write(np.zeros((100, 100, 3), dtype=np.uint8))
    writer.release()
    configured = Settings(
        data_dir=tmp_path,
        sample_fps=2,
        enable_whisper=False,
        refine_boundaries=False,
    )
    result = SubtitlePipeline(configured, ocr_engine=FragmentAndBrandOCR()).process(
        path,
        tmp_path / "fragment-output",
        enable_whisper=False,
        roi=NormalizedROI(x=0, y=0, width=1, height=1),
    )
    assert result.ocr_event_count == 1
    assert [item.text for item in result.subtitles] == ["THE FIRST GADGET"]
    diagnostics = json.loads(
        Path(result.artifacts["diagnostics_json"]).read_text(encoding="utf-8")
    )
    # Three raw boxes per frame become one caption line plus one brand candidate;
    # the persistent off-line brand is then removed at track level.
    assert diagnostics["sampling"]["coarse_observation_count"] == 8
    assert diagnostics["final_ocr_event_count"] == 1


def test_change_discovery_finds_caption_between_two_coarse_samples(tmp_path: Path) -> None:
    path = tmp_path / "short-between-samples.mp4"
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 20, (100, 100))
    for frame_index in range(30):
        image = np.zeros((100, 100, 3), dtype=np.uint8)
        if 4 <= frame_index <= 8:
            image[60:80, 20:80] = 255
        writer.write(image)
    writer.release()

    configured = Settings(
        data_dir=tmp_path,
        sample_fps=2,
        enable_whisper=False,
        refine_boundaries=True,
        boundary_ocr_budget=2,
        discover_short_events=True,
        discovery_ocr_budget=4,
        discovery_change_threshold=2,
    )
    result = SubtitlePipeline(configured, ocr_engine=BrightCaptionOCR()).process(
        path,
        tmp_path / "short-output",
        enable_whisper=False,
        roi=NormalizedROI(x=0.2, y=0.6, width=0.6, height=0.2),
    )
    assert len(result.subtitles) == 1
    assert result.subtitles[0].text == "PROTECT YOURSELF"
    assert result.subtitles[0].start_time == 0.2
    assert result.subtitles[0].end_time == 0.45
    diagnostics = json.loads(
        Path(result.artifacts["diagnostics_json"]).read_text(encoding="utf-8")
    )
    assert diagnostics["short_event_discovery"]["new_ocr_call_count"] == 1
    assert diagnostics["short_event_discovery"]["new_ocr_call_count"] <= 4


def test_discovery_focus_stays_on_dominant_band_despite_vertical_outliers() -> None:
    metadata = VideoMetadata(
        width=1080, height=1920, fps=60, frame_count=2400, duration=40
    )
    events = [
        SubtitleItem(
            id=f"normal-{index}", text="NORMAL", start_time=index, end_time=index + 1,
            confidence=0.99, position=[250, 1230, 830, 1315]
        )
        for index in range(3)
    ] + [
        SubtitleItem(
            id="stacked", text="TITLE\nSUBTITLE", start_time=0, end_time=2,
            confidence=0.99, position=[120, 1055, 949, 1359]
        ),
        SubtitleItem(
            id="raised", text="RAISED", start_time=20, end_time=21,
            confidence=0.99, position=[300, 1084, 790, 1171]
        ),
    ]
    focus = _caption_focus_box(
        events,
        metadata,
        NormalizedROI(x=0.08, y=0.52, width=0.84, height=0.24),
    )
    assert focus == (86, 1200, 994, 1345)


def test_discovery_focus_jitter_finds_one_pixel_edge_short_state() -> None:
    class MemoryReader:
        def __init__(self, frames):
            self.frames = frames

        def frames_between(self, _start, _end, *, roi):
            yield from self.frames

    frames = []
    for index in range(8):
        image = np.zeros((10, 20, 3), dtype=np.uint8)
        # The cue is one pixel above the nominal crop. Only a jittered band can
        # see both its appearance and disappearance transitions.
        if 2 <= index <= 3:
            image[2, :] = 255
        frames.append(SampledFrame(image, index, index / 10, 0, 0))
    metadata = VideoMetadata(
        width=20, height=10, fps=10, frame_count=8, duration=0.8
    )
    indices = _short_event_probe_indices(
        MemoryReader(frames),
        metadata=metadata,
        roi=NormalizedROI(x=0, y=0, width=1, height=1),
        focus_box=(0, 3, 20, 7),
        cached_frame_indices=set(),
        sample_fps=2,
        min_duration=0.1,
        change_threshold=2,
        budget=4,
    )
    assert indices == [2]


def test_default_discovery_budget_can_rank_more_than_twelve_intervals(tmp_path: Path) -> None:
    class MemoryReader:
        def __init__(self, frames):
            self.frames = frames

        def frames_between(self, _start, _end, *, roi):
            yield from self.frames

    frames = []
    for index in range(80):
        value = 255 if (index // 2) % 2 else 0
        image = np.full((20, 40, 3), value, dtype=np.uint8)
        frames.append(SampledFrame(image, index, index / 10, 0, 0))
    metadata = VideoMetadata(
        width=40, height=20, fps=10, frame_count=80, duration=8
    )
    configured = Settings(data_dir=tmp_path)
    assert configured.discovery_ocr_budget == 24
    indices = _short_event_probe_indices(
        MemoryReader(frames),
        metadata=metadata,
        roi=NormalizedROI(x=0, y=0, width=1, height=1),
        focus_box=None,
        cached_frame_indices=set(),
        sample_fps=2,
        min_duration=0.1,
        change_threshold=2,
        budget=configured.discovery_ocr_budget,
    )
    assert len(indices) == 24
    assert len(indices) > 12
    assert indices == sorted(indices)
