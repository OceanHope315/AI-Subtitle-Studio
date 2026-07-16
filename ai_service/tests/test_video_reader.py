from pathlib import Path

import cv2
import numpy as np

from ai_service.schemas import NormalizedROI
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
