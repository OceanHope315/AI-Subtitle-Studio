import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

import ai_service.main as main_module
from ai_service.config import Settings
from ai_service.job_store import JobStore
from ai_service.main import _validated_roi
from ai_service.schemas import JobRecord, NormalizedROI


def test_normalized_roi_validates_and_persists_on_job() -> None:
    roi = NormalizedROI(x=0.1, y=0.65, width=0.8, height=0.2)
    record = JobRecord(
        task_id="roi-test",
        filename="test.mp4",
        video_path="test.mp4",
        roi=roi,
    )
    restored = JobRecord.model_validate_json(record.model_dump_json())
    assert restored.roi == roi


@pytest.mark.parametrize(
    "values",
    [
        (-0.1, 0.2, 0.5, 0.2),
        (0.8, 0.2, 0.3, 0.2),
        (0.2, 0.9, 0.5, 0.2),
        (0.2, 0.2, 0.0, 0.2),
    ],
)
def test_normalized_roi_rejects_out_of_frame_rectangles(values) -> None:
    with pytest.raises(ValidationError):
        NormalizedROI(x=values[0], y=values[1], width=values[2], height=values[3])


def test_api_roi_fields_are_all_or_none() -> None:
    with pytest.raises(HTTPException) as error:
        _validated_roi(0.1, 0.2, 0.8, None)
    assert error.value.status_code == 422
    assert _validated_roi(None, None, None, None) is None


def test_post_jobs_accepts_and_persists_normalized_roi(tmp_path, monkeypatch) -> None:
    class CapturingExecutor:
        def __init__(self) -> None:
            self.calls = []

        def submit(self, *args):
            self.calls.append(args)

    configured = Settings(data_dir=tmp_path)
    configured.ensure_directories()
    executor = CapturingExecutor()
    monkeypatch.setattr(main_module, "settings", configured)
    monkeypatch.setattr(main_module, "job_store", JobStore(configured.jobs_dir))
    monkeypatch.setattr(main_module, "executor", executor)

    response = TestClient(main_module.app).post(
        "/jobs",
        files={"video": ("roi.mp4", b"not-decoded-until-worker", "video/mp4")},
        data={
            "task_id": "roi-api-test",
            "roi_x": "0.1",
            "roi_y": "0.65",
            "roi_width": "0.8",
            "roi_height": "0.2",
        },
    )
    assert response.status_code == 202
    assert response.json()["roi"] == {
        "x": 0.1, "y": 0.65, "width": 0.8, "height": 0.2
    }
    assert executor.calls[0][-1] == NormalizedROI(
        x=0.1, y=0.65, width=0.8, height=0.2
    )
