from pathlib import Path

from fastapi.testclient import TestClient

import ai_service.main as main_module
from ai_service.config import Settings
from ai_service.roi.estimator import RoiEstimate
from ai_service.schemas import NormalizedROI


def test_estimate_roi_api_returns_success_or_exact_no_subtitle_and_cleans_upload(
    tmp_path: Path, monkeypatch
) -> None:
    configured = Settings(data_dir=tmp_path)
    configured.ensure_directories()
    results = [
        RoiEstimate(
            roi=NormalizedROI(x=0.12, y=0.7, width=0.76, height=0.16),
            score=0.81,
            frames_analyzed=16,
            frame_hits=10,
            mean_confidence=0.93,
        ),
        None,
    ]
    observed_uploads: list[Path] = []

    def fake_estimator(video_path, _engine, **kwargs):
        path = Path(video_path)
        assert path.is_file()
        assert path.read_bytes() == b"synthetic-mp4"
        assert kwargs["frame_count"] == 16
        observed_uploads.append(path)
        return results.pop(0)

    monkeypatch.setattr(main_module, "settings", configured)
    monkeypatch.setattr(main_module, "PaddleOCREngine", lambda *_args: object())
    monkeypatch.setattr(main_module, "estimate_video_roi", fake_estimator)
    client = TestClient(main_module.app)

    success = client.post(
        "/estimate-roi",
        files={"video": ("captions.mp4", b"synthetic-mp4", "video/mp4")},
    )
    missing = client.post(
        "/estimate-roi",
        files={"video": ("no-captions.mp4", b"synthetic-mp4", "video/mp4")},
    )
    assert main_module.ocr_work_lock.acquire(blocking=False)
    try:
        busy = client.post(
            "/estimate-roi",
            files={"video": ("busy.mp4", b"synthetic-mp4", "video/mp4")},
        )
    finally:
        main_module.ocr_work_lock.release()

    assert success.status_code == 200
    assert success.json() == {
        "success": True,
        "roi": {"x": 0.12, "y": 0.7, "width": 0.76, "height": 0.16},
    }
    assert missing.status_code == 200
    assert missing.json() == {
        "success": False,
        "reason": "no subtitle detected",
    }
    assert busy.status_code == 503
    assert len(observed_uploads) == 2
    assert all(not path.exists() for path in observed_uploads)
