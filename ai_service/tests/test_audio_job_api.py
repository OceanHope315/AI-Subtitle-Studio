from __future__ import annotations

from fastapi.testclient import TestClient

import ai_service.main as main_module
from ai_service.config import Settings
from ai_service.job_store import JobStore
from ai_service.schemas import AudioSubtitle, AudioWord, JobRecord, VisualSubtitle


class ImmediateExecutor:
    def submit(self, function, *args, **kwargs):
        function(*args, **kwargs)
        return None


def _configure_audio_api(tmp_path, monkeypatch) -> tuple[JobStore, JobStore]:
    configured = Settings(data_dir=tmp_path, enable_whisperx=True)
    configured.ensure_directories()
    visual_jobs = JobStore(configured.jobs_dir)
    audio_jobs = JobStore(configured.audio_jobs_dir)
    monkeypatch.setattr(main_module, "settings", configured)
    monkeypatch.setattr(main_module, "job_store", visual_jobs)
    monkeypatch.setattr(main_module, "audio_job_store", audio_jobs)
    monkeypatch.setattr(main_module, "audio_executor", ImmediateExecutor())
    return visual_jobs, audio_jobs


def test_audio_job_is_independent_and_exposes_word_timestamps(
    tmp_path, monkeypatch
) -> None:
    visual_jobs, _audio_jobs = _configure_audio_api(tmp_path, monkeypatch)
    visual_jobs.create(
        JobRecord(
            task_id="shared-task",
            kind="visual",
            filename="source.mp4",
            video_path="source.mp4",
            status="completed",
            progress=100,
            visual_subtitles=[
                VisualSubtitle(
                    id="visual-1",
                    task_id="shared-task",
                    text="WATCH OUT",
                    start=1.1,
                    end=1.5,
                    bbox=[10, 20, 100, 40],
                    confidence=0.95,
                )
            ],
        )
    )

    def fake_run_worker(_path, config, *, timeout_seconds=None):
        assert config["language"] == "en"
        return [
            AudioSubtitle(
                id="audio-1",
                text="watch out",
                start=1.05,
                end=1.4,
                confidence=0.9,
                words=[
                    AudioWord(word="watch", start=1.05, end=1.25, confidence=0.92),
                    AudioWord(word=" out", start=1.25, end=1.4, confidence=0.88),
                ],
            )
        ]

    monkeypatch.setattr(main_module, "run_whisperx_worker", fake_run_worker)
    client = TestClient(main_module.app)
    submitted = client.post(
        "/audio-jobs",
        files={"video": ("source.mp4", b"video", "video/mp4")},
        data={"task_id": "shared-task", "language": "en"},
    )
    assert submitted.status_code == 202
    assert submitted.json()["kind"] == "audio"

    audio_job = client.get("/audio-jobs/shared-task")
    assert audio_job.status_code == 200
    assert audio_job.json()["status"] == "completed"
    assert audio_job.json()["progress"] == 100
    audio_track = client.get("/audio-jobs/shared-task/subtitles").json()["subtitles"]
    assert audio_track[0]["taskId"] == "shared-task"
    assert audio_track[0]["words"][0] == {
        "word": "watch",
        "start": 1.05,
        "end": 1.25,
        "confidence": 0.92,
    }

    visual_track = client.get("/jobs/shared-task/visual-subtitles").json()["subtitles"]
    assert visual_track[0]["text"] == "WATCH OUT"
    assert visual_track[0]["bbox"] == [10, 20, 100, 40]


def test_unavailable_whisperx_fails_only_audio_job(tmp_path, monkeypatch) -> None:
    visual_jobs, _audio_jobs = _configure_audio_api(tmp_path, monkeypatch)
    visual_jobs.create(
        JobRecord(
            task_id="visual-safe",
            filename="source.mp4",
            video_path="source.mp4",
            status="completed",
            progress=100,
        )
    )

    def unavailable(*_args, **_kwargs):
        from ai_service.whisperx.runner import WhisperXWorkerError
        raise WhisperXWorkerError("not installed")

    monkeypatch.setattr(main_module, "run_whisperx_worker", unavailable)
    client = TestClient(main_module.app)
    response = client.post(
        "/audio-jobs",
        files={"video": ("source.wav", b"audio", "audio/wav")},
        data={"task_id": "audio-fails"},
    )
    assert response.status_code == 202
    failed = client.get("/audio-jobs/audio-fails").json()
    assert failed["status"] == "failed"
    assert "not installed" in failed["error"]
    assert client.get("/jobs/visual-safe").json()["status"] == "completed"


def test_legacy_job_record_defaults_new_track_fields() -> None:
    restored = JobRecord.model_validate(
        {
            "task_id": "legacy-task",
            "filename": "source.mp4",
            "video_path": "source.mp4",
        }
    )
    assert restored.kind == "visual"
    assert restored.visual_subtitles == []
    assert restored.audio_subtitles == []
