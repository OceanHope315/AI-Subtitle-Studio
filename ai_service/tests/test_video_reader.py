from pathlib import Path
from fractions import Fraction

import av
import cv2
import numpy as np
import pytest

from ai_service.schemas import NormalizedROI, SubtitleItem
from ai_service.video.reader import VideoReader


def test_probe_and_sample(tmp_path: Path) -> None:
    path = tmp_path / "tiny.mp4"
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 10, (160, 120))
    for _ in range(20):
        writer.write(np.zeros((120, 160, 3), dtype=np.uint8))
    writer.release()

    reader = VideoReader(path)
    metadata = reader.probe()
    frames = list(reader.sampled_frames(2, 0.5, 1.0))
    assert metadata.width == 160
    assert metadata.height == 120
    assert metadata.duration == 2
    assert 3 <= len(frames) <= 5
    assert frames[0].image.shape[:2] == (60, 160)


def test_arbitrary_normalized_roi_has_global_offsets(tmp_path: Path) -> None:
    path = tmp_path / "crop.mp4"
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 10, (160, 120))
    writer.write(np.zeros((120, 160, 3), dtype=np.uint8))
    writer.release()

    roi = NormalizedROI(x=0.25, y=0.2, width=0.5, height=0.4)
    frame = next(VideoReader(path).sampled_frames(2, roi=roi))
    assert frame.image.shape[:2] == (48, 80)
    assert frame.roi_offset_x == 40
    assert frame.roi_offset_y == 24

    exact_frames = list(VideoReader(path).frames_between(0, 0, roi=roi))
    assert len(exact_frames) == 1
    assert exact_frames[0].image.shape[:2] == (48, 80)


def _write_cfr(path: Path, rate: Fraction, frame_count: int = 12) -> None:
    frame_time_base = Fraction(rate.denominator, rate.numerator)
    with av.open(str(path), "w") as container:
        stream = container.add_stream("libx264", rate=rate)
        stream.width = 64
        stream.height = 48
        stream.pix_fmt = "yuv420p"
        stream.time_base = frame_time_base
        stream.codec_context.time_base = frame_time_base
        for index in range(frame_count):
            frame = av.VideoFrame.from_ndarray(
                np.full((48, 64, 3), index, dtype=np.uint8), format="bgr24"
            )
            frame.pts = index
            frame.time_base = frame_time_base
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)


@pytest.mark.parametrize("rate", [Fraction(30000, 1001), Fraction(60000, 1001)])
def test_fractional_cfr_uses_exact_pts_without_linear_drift(
    tmp_path: Path, rate: Fraction
) -> None:
    path = tmp_path / f"cfr-{rate.numerator}.mp4"
    _write_cfr(path, rate)
    reader = VideoReader(path)
    metadata = reader.probe()
    frames = list(reader.sampled_frames(float(rate)))

    assert metadata.fps == pytest.approx(float(rate), rel=1e-6)
    assert metadata.variable_frame_rate is False
    assert metadata.time_base is not None
    assert frames[-1].timestamp == pytest.approx(float(Fraction(11, 1) / rate), abs=1e-9)
    assert metadata.duration == pytest.approx(float(Fraction(12, 1) / rate), abs=1e-9)


def test_nonzero_pts_and_vfr_cues_keep_exclusive_raw_boundaries(tmp_path: Path) -> None:
    path = tmp_path / "nonzero-vfr.mp4"
    source_time_base = Fraction(1, 1000)
    with av.open(str(path), "w") as container:
        stream = container.add_stream("libx264", rate=30)
        stream.width = 64
        stream.height = 48
        stream.pix_fmt = "yuv420p"
        stream.time_base = source_time_base
        stream.codec_context.time_base = source_time_base
        for pts in [100, 133, 183, 216]:
            frame = av.VideoFrame.from_ndarray(
                np.zeros((48, 64, 3), dtype=np.uint8), format="bgr24"
            )
            frame.pts = pts
            frame.time_base = source_time_base
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)

    reader = VideoReader(path)
    metadata = reader.probe()
    frames = [reader.frame_at_index(index) for index in range(4)]
    assert metadata.start_pts != 0
    assert metadata.start_time > 0
    assert metadata.variable_frame_rate is True
    assert [frame.timestamp for frame in frames] == pytest.approx([0, 0.033, 0.083, 0.116])

    [cue] = reader.attach_timebase([
        SubtitleItem(id="cue", text="PTS", start_time=0.083, end_time=0.116)
    ])
    assert cue.start_frame == 2
    assert cue.end_frame_exclusive == 3
    assert cue.start_pts == frames[2].pts
    assert cue.end_pts == frames[3].pts
    assert cue.time_base == metadata.time_base
    assert cue.start_time == pytest.approx(0.083)
    assert cue.end_time == pytest.approx(0.116)
