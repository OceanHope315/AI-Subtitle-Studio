from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

import ai_service.main as main_module
import ai_service.pipeline as pipeline_module
import ai_service.progress as progress_module
from ai_service.config import Settings
from ai_service.job_store import JobStore
from ai_service.ocr.base import DetectedText
from ai_service.pipeline import PipelineResult, SubtitlePipeline
from ai_service.progress import EventLogStore, PreviewStore, ProgressPublisher
from ai_service.schemas import JobRecord, NormalizedROI, SubtitleItem, VideoMetadata
from ai_service.video.reader import SampledFrame


RUN_ID = "0123456789abcdef0123456789abcdef"


def _images() -> tuple[np.ndarray, np.ndarray, tuple[int, int, int, int]]:
    full = np.zeros((120, 200, 3), dtype=np.uint8)
    full[:, :, 0] = 24
    full[40:90, 30:170] = (40, 80, 120)
    bounds = (30, 40, 170, 90)
    return full, full[40:90, 30:170], bounds


def test_event_seq_is_strict_and_jsonl_replays_after_restart(tmp_path: Path) -> None:
    store = EventLogStore(tmp_path / "progress", memory_limit=2)
    store.begin_run("event-task", RUN_ID)
    for index in range(3):
        event = store.append(
            "event-task",
            RUN_ID,
            "stage.progress",
            {"index": index},
            progress=index,
            message=f"step {index}",
        )
        assert event.seq == index + 1

    # A fresh object has no hot cache and must recover both replay and next seq
    # from the independent JSONL file.
    recovered = EventLogStore(tmp_path / "progress", memory_limit=2)
    assert [event.seq for event in recovered.read(
        "event-task", RUN_ID, after_seq=1
    )] == [2, 3]
    fourth = recovered.append(
        "event-task",
        RUN_ID,
        "stage.progress",
        {},
        progress=4,
        message="step 4",
    )
    assert fourth.seq == 4
    assert [event.seq for event in recovered.read(
        "event-task", RUN_ID, after_seq=2
    )] == [3, 4]

    recovered.release_hot_cache("event-task", RUN_ID)
    key = ("event-task", RUN_ID)
    assert key not in recovered._events
    assert key not in recovered._next_sequences
    # Disk replay and sequence continuation remain available after release.
    assert [event.seq for event in recovered.read(
        "event-task", RUN_ID, after_seq=3
    )] == [4]


def test_recovery_removes_partial_jsonl_tail_before_next_append(tmp_path: Path) -> None:
    root = tmp_path / "progress"
    store = EventLogStore(root)
    store.begin_run("partial-task", RUN_ID)
    store.append(
        "partial-task", RUN_ID, "stage.progress", {}, progress=1, message="one"
    )
    log = root / "partial-task" / RUN_ID / "events.jsonl"
    with log.open("ab") as stream:
        stream.write(b'{"seq":2,"task_id":"partial-task"')

    recovered = EventLogStore(root)
    second = recovered.append(
        "partial-task", RUN_ID, "stage.progress", {}, progress=2, message="two"
    )
    assert second.seq == 2
    assert [event.seq for event in recovered.read(
        "partial-task", RUN_ID, after_seq=0
    )] == [1, 2]
    assert log.read_bytes().endswith(b"\n")


def test_preview_rate_limit_jpeg_ring_and_evidence_retention(
    tmp_path: Path, monkeypatch,
) -> None:
    store = PreviewStore(
        tmp_path / "progress",
        min_interval_seconds=1,
        max_previews=2,
        max_long_edge=96,
        jpeg_quality=75,
    )
    full, roi, bounds = _images()
    candidates = [(40, 50, 130, 75)]

    first = store.write(
        "preview-task", RUN_ID, frame_image=full, roi_image=roi,
        roi_bounds=bounds, candidate_positions=candidates, now=0,
    )
    assert first is not None
    assert store.write(
        "preview-task", RUN_ID, frame_image=full, roi_image=roi,
        roi_bounds=bounds, candidate_positions=candidates, now=0.99,
    ) is None
    second = store.write(
        "preview-task", RUN_ID, frame_image=full, roi_image=roi,
        roi_bounds=bounds, candidate_positions=candidates, now=1,
    )
    third = store.write(
        "preview-task", RUN_ID, frame_image=full, roi_image=roi,
        roi_bounds=bounds, candidate_positions=candidates, now=2,
    )
    assert second is not None and third is not None

    # Each retained bundle has a full-frame and ROI JPEG. The oldest bundle is
    # removed as a pair, and no half-written temporary remains.
    assert store.resolve("preview-task", RUN_ID, first.frame.id) is None
    latest_path = store.resolve("preview-task", RUN_ID, third.frame.id)
    assert latest_path is not None
    decoded = cv2.imread(str(latest_path))
    assert decoded is not None and max(decoded.shape[:2]) <= 96
    assert not list((tmp_path / "progress").rglob("*.tmp"))

    evidence = store.write(
        "preview-task", RUN_ID, frame_image=full, roi_image=roi,
        roi_bounds=bounds, candidate_positions=candidates, evidence=True, now=2.1,
    )
    assert evidence is not None
    store.cleanup_transient("preview-task", RUN_ID)
    assert store.resolve("preview-task", RUN_ID, third.frame.id) is None
    assert store.resolve("preview-task", RUN_ID, evidence.frame.id) is not None
    assert store.resolve("preview-task", RUN_ID, evidence.roi.id) is not None

    # A failed manifest commit must roll both JPEGs back; otherwise neither the
    # in-memory nor restart-rebuilt ring index can ever prune the orphan pair.
    transient_dir = tmp_path / "progress" / "preview-task" / RUN_ID / "previews"
    before = set(transient_dir.glob("*.jpg"))

    def fail_manifest(*_args, **_kwargs):
        raise OSError("manifest disk unavailable")

    monkeypatch.setattr(progress_module, "_atomic_json", fail_manifest)
    with pytest.raises(OSError, match="manifest disk unavailable"):
        store.write(
            "preview-task", RUN_ID, frame_image=full, roi_image=roi,
            roi_bounds=bounds, candidate_positions=candidates, now=3,
        )
    assert set(transient_dir.glob("*.jpg")) == before
    assert not list(transient_dir.glob("*.tmp"))


def test_frame_event_has_real_pts_global_candidates_and_two_previews(
    tmp_path: Path,
) -> None:
    event_store = EventLogStore(tmp_path / "progress")
    event_store.begin_run("frame-task", RUN_ID)
    preview_store = PreviewStore(
        tmp_path / "progress", min_interval_seconds=0, max_long_edge=160
    )
    publisher = ProgressPublisher(
        "frame-task", RUN_ID, event_store, preview_store
    )
    full, roi_image, _bounds = _images()
    frame = SampledFrame(
        image=roi_image,
        frame_index=923,
        timestamp=1.538,
        pts=46150,
        duration_pts=500,
        time_base="1/30000",
        roi_offset_y=40,
        roi_offset_x=30,
        source_image=full,
    )
    event = publisher.frame_analyzed(
        stage="coarse_ocr",
        frame=frame,
        metadata=VideoMetadata(
            width=200, height=120, fps=30, frame_count=1000, duration=34
        ),
        roi=NormalizedROI(x=0.15, y=1 / 3, width=0.7, height=5 / 12),
        candidates=[DetectedText("REAL OCR", 0.98, (40, 50, 130, 75))],
        processed=44,
        total=180,
        detected_cue_count=12,
    )
    assert event is not None
    payload = event.payload
    assert (payload["frame_index"], payload["pts"]) == (923, 46150)
    assert (payload["time_base_num"], payload["time_base_den"]) == (1, 30000)
    assert payload["media_time"] == 1.538
    assert payload["pts_source"] == "container"
    assert payload["coordinate_space"] == "video"
    assert payload["candidates"] == [{
        "text": "REAL OCR",
        "confidence": 0.98,
        "position": [40, 50, 130, 75],
        "coordinate_space": "video",
    }]
    assert payload["preview_id"] and payload["roi_preview_id"]
    assert payload["preview"]["frame"]["source_width"] == 200
    assert payload["preview"]["frame"]["source_height"] == 120
    assert payload["preview"]["roi"]["source_width"] == 140
    assert payload["preview"]["roi"]["source_height"] == 50


def test_progress_and_preview_storage_failures_remain_best_effort(
    tmp_path: Path, monkeypatch,
) -> None:
    events = EventLogStore(tmp_path / "progress")
    events.begin_run("best-effort-task", RUN_ID)
    previews = PreviewStore(tmp_path / "progress", min_interval_seconds=0)
    publisher = ProgressPublisher(
        "best-effort-task", RUN_ID, events, previews
    )

    def fail_event(*_args, **_kwargs):
        raise OSError("event disk unavailable")

    monkeypatch.setattr(events, "append", fail_event)
    assert publisher.stage_progress(
        "probing", "探测", 1, message="仍应继续"
    ) is None

    healthy_events = EventLogStore(tmp_path / "healthy-progress")
    healthy_events.begin_run("best-effort-task", RUN_ID)
    publisher = ProgressPublisher(
        "best-effort-task", RUN_ID, healthy_events, previews
    )

    def fail_preview(*_args, **_kwargs):
        raise OSError("preview disk unavailable")

    monkeypatch.setattr(previews, "write", fail_preview)
    full, roi_image, _bounds = _images()
    event = publisher.frame_analyzed(
        stage="coarse_ocr",
        frame=SampledFrame(
            image=roi_image,
            frame_index=1,
            timestamp=0.1,
            pts=3,
            duration_pts=1,
            time_base="1/30",
            roi_offset_y=40,
            roi_offset_x=30,
            source_image=full,
        ),
        metadata=VideoMetadata(
            width=200, height=120, fps=30, frame_count=30, duration=1
        ),
        roi=NormalizedROI(x=0.15, y=1 / 3, width=0.7, height=5 / 12),
        candidates=[DetectedText("OCR SURVIVES", 0.9, (40, 50, 130, 75))],
        processed=1,
        total=10,
        detected_cue_count=1,
    )
    assert event is not None
    assert event.payload["preview_id"] is None
    assert event.payload["candidates"][0]["text"] == "OCR SURVIVES"


def test_terminal_events_and_legacy_job_progress_remain_compatible(
    tmp_path: Path,
) -> None:
    jobs = JobStore(tmp_path / "jobs")
    jobs.create(JobRecord(
        task_id="terminal-task", filename="x.mp4", video_path="x.mp4"
    ))
    jobs.update_legacy_progress("terminal-task", 37, "旧回调仍可用")
    assert jobs.get("terminal-task").progress == 37
    assert jobs.get("terminal-task").message == "旧回调仍可用"

    events = EventLogStore(tmp_path / "progress")
    events.begin_run("terminal-task", RUN_ID)
    publisher = ProgressPublisher(
        "terminal-task",
        RUN_ID,
        events,
        PreviewStore(tmp_path / "progress"),
        on_event=jobs.update_progress_snapshot,
    )
    frame = publisher.publish(
        "frame.analyzed",
        {"frame_index": 7, "preview_id": "a" * 32},
        progress=37,
        message="真实帧",
    )
    publisher.stage_progress(
        "event_aggregation", "事件聚合", 72, message="正在聚合"
    )
    assert frame is not None
    assert jobs.get("terminal-task").latest_frame_event.seq == frame.seq
    assert jobs.get("terminal-task").latest_preview_event.seq == frame.seq
    no_preview = publisher.publish(
        "frame.analyzed",
        {"frame_index": 8, "preview_id": None},
        progress=38,
        message="限频帧",
    )
    assert no_preview is not None
    assert jobs.get("terminal-task").latest_frame_event.seq == no_preview.seq
    assert jobs.get("terminal-task").latest_preview_event.seq == frame.seq
    completed = publisher.completed(subtitle_count=3, artifacts={"srt": "x.srt"})
    failed = publisher.failed("synthetic failure")
    assert completed is not None and completed.type == "job.completed"
    assert completed.progress == 100
    assert completed.payload["detected_cue_count"] == 3
    assert completed.payload["artifacts"] == ["srt"]
    assert "x.srt" not in json.dumps(completed.public_dict())
    assert failed is not None and failed.type == "job.failed"
    assert failed.seq == completed.seq + 1
    snapshot = jobs.get("terminal-task")
    assert snapshot.latest_seq == failed.seq
    assert snapshot.latest_event.type == "job.failed"
    assert snapshot.latest_frame_event.seq == no_preview.seq
    assert snapshot.latest_preview_event.seq == frame.seq
    disk = json.loads((tmp_path / "jobs" / "terminal-task.json").read_text("utf-8"))
    assert "events" not in disk


class FragmentOCR:
    name = "fragment-test"

    def __init__(self) -> None:
        self.calls = 0

    def detect(self, image, offset_y=0, offset_x=0, *, apply_layout_filter=True):
        self.calls += 1
        return [
            DetectedText(
                "TRUE", 0.91,
                (offset_x + 4, offset_y + 5, offset_x + 28, offset_y + 18),
            ),
            DetectedText(
                "FRAME", 0.93,
                (offset_x + 30, offset_y + 5, offset_x + 58, offset_y + 18),
            ),
        ]


def test_pipeline_publishes_post_ocr_frames_stages_cues_and_legacy_callback(
    tmp_path: Path, monkeypatch,
) -> None:
    video = tmp_path / "pipeline.mp4"
    writer = cv2.VideoWriter(
        str(video), cv2.VideoWriter_fourcc(*"mp4v"), 10, (100, 80)
    )
    for index in range(20):
        writer.write(np.full((80, 100, 3), index, dtype=np.uint8))
    writer.release()

    engine = FragmentOCR()
    settings = Settings(
        data_dir=tmp_path,
        sample_fps=2,
        enable_whisper=False,
        refine_boundaries=False,
        discover_short_events=False,
    )
    event_store = EventLogStore(tmp_path / "progress")
    event_store.begin_run("pipeline-task", RUN_ID)
    publisher = ProgressPublisher(
        "pipeline-task",
        RUN_ID,
        event_store,
        PreviewStore(tmp_path / "progress", min_interval_seconds=100),
    )
    aggregate_sizes: list[int] = []
    real_build_ocr_events = pipeline_module.build_ocr_events

    def tracked_build_ocr_events(observations, **kwargs):
        aggregate_sizes.append(len(observations))
        return real_build_ocr_events(observations, **kwargs)

    monkeypatch.setattr(pipeline_module, "build_ocr_events", tracked_build_ocr_events)
    legacy: list[tuple[int, str]] = []
    result = SubtitlePipeline(settings, ocr_engine=engine).process(
        video,
        tmp_path / "output",
        enable_whisper=False,
        roi=NormalizedROI(x=0.2, y=0.5, width=0.6, height=0.3),
        progress=lambda percent, message: legacy.append((percent, message)),
        event_publisher=publisher,
    )

    events = event_store.read("pipeline-task", RUN_ID, limit=5000)
    frames = [event for event in events if event.type == "frame.analyzed"]
    stages = {
        event.payload["stage"] for event in events if event.type == "stage.progress"
    }
    assert len(frames) == engine.calls
    assert frames[0].payload["candidates"][0]["text"] == "TRUE"
    assert frames[0].payload["candidates"][1]["text"] == "FRAME"
    assert frames[0].payload["candidates"][0]["position"][0] == 24
    assert frames[0].payload["candidates"][0]["position"][1] == 45
    assert frames[0].payload["preview"]["frame"]["source_width"] == 100
    assert frames[0].payload["preview"]["frame"]["source_height"] == 80
    assert stages == {
        "probing",
        "coarse_ocr",
        "short_event_discovery",
        "event_aggregation",
        "boundary_refinement",
        "whisper_correction",
        "artifact_generation",
    }
    assert any(event.type == "cue.upserted" for event in events)
    assert result.subtitles[0].text == "TRUE FRAME"
    assert legacy and all(
        isinstance(percent, int) and isinstance(message, str)
        for percent, message in legacy
    )
    assert legacy[-1] == (98, "subtitle.json 与 output.srt 已生成")
    max_observations = max(aggregate_sizes, default=0)
    # Geometric interim checkpoints plus the two required exact aggregates.
    assert len(aggregate_sizes) <= max(1, max_observations).bit_length() + 2


def test_restart_recovery_persists_failure_publishes_terminal_and_cleans_previews(
    tmp_path: Path, monkeypatch,
) -> None:
    completion_run = "1" * 32
    terminal_run = "2" * 32
    jobs_dir = tmp_path / "jobs"
    progress_dir = tmp_path / "progress"
    original = JobStore(jobs_dir)
    original.create(JobRecord(
        task_id="interrupted-task",
        filename="x.mp4",
        video_path="x.mp4",
        status="processing",
        run_id=RUN_ID,
    ))
    original.create(JobRecord(
        task_id="completion-task",
        filename="complete.mp4",
        video_path="complete.mp4",
        status="processing",
        run_id=completion_run,
        subtitles=[SubtitleItem(
            id="recovered-cue", text="RECOVERED", start_time=0, end_time=1,
        )],
        artifacts={"output_srt": "output.srt"},
        completion_pending=True,
        recovery_pending=True,
    ))
    original.create(JobRecord(
        task_id="terminal-task",
        filename="done.mp4",
        video_path="done.mp4",
        status="completed",
        run_id=terminal_run,
    ))
    previews = PreviewStore(progress_dir, min_interval_seconds=0)
    full, roi, bounds = _images()
    transient = previews.write(
        "interrupted-task", RUN_ID, frame_image=full, roi_image=roi,
        roi_bounds=bounds, candidate_positions=[], now=0,
    )
    evidence = previews.write(
        "interrupted-task", RUN_ID, frame_image=full, roi_image=roi,
        roi_bounds=bounds, candidate_positions=[], evidence=True, now=0,
    )
    assert transient is not None and evidence is not None
    completion_transient = previews.write(
        "completion-task", completion_run, frame_image=full, roi_image=roi,
        roi_bounds=bounds, candidate_positions=[], now=0,
    )
    terminal_transient = previews.write(
        "terminal-task", terminal_run, frame_image=full, roi_image=roi,
        roi_bounds=bounds, candidate_positions=[], now=0,
    )
    terminal_evidence = previews.write(
        "terminal-task", terminal_run, frame_image=full, roi_image=roi,
        roi_bounds=bounds, candidate_positions=[], evidence=True, now=0,
    )
    assert completion_transient is not None
    assert terminal_transient is not None and terminal_evidence is not None

    # Merely constructing/importing a JobStore is read-only. The explicit
    # startup phase durably marks recovery before trying any side effects.
    first_boot = JobStore(jobs_dir)
    first_record = first_boot.get("interrupted-task")
    assert first_record is not None
    assert first_record.status == "processing"
    assert first_record.recovery_pending is False
    first_boot.prepare_restart_recovery()
    first_record = first_boot.get("interrupted-task")
    assert first_record.recovery_pending is True
    assert "recovery_pending" not in first_record.public_dict()
    assert "completion_pending" not in first_record.public_dict()
    persisted = json.loads(
        (jobs_dir / "interrupted-task.json").read_text(encoding="utf-8")
    )
    assert persisted["status"] == "failed"
    assert persisted["recovery_pending"] is True

    # Simulate another crash before the startup recovery side effects run.
    second_boot = JobStore(jobs_dir)
    second_boot.prepare_restart_recovery()
    events = EventLogStore(progress_dir)

    # Simulate the narrower crash window where the terminal append succeeds but
    # its JobStore callback and preview cleanup have not run yet.
    events.append(
        "interrupted-task",
        RUN_ID,
        "job.failed",
        {"error": "AI 服务重启中断了任务，请重新上传"},
        progress=100,
        message="任务已中断",
    )
    second_record = second_boot.get("interrupted-task")
    assert second_record is not None
    assert second_record.latest_event is None
    assert second_record.recovery_pending is True

    recovered_jobs = JobStore(jobs_dir)
    recovered_jobs.prepare_restart_recovery()
    main_module._recover_interrupted_jobs(recovered_jobs, events, previews)

    recovered = recovered_jobs.get("interrupted-task")
    assert recovered is not None
    assert recovered.status == "failed"
    assert recovered.latest_event.type == "job.failed"
    assert "重启中断" in recovered.latest_event.payload["error"]
    assert previews.resolve(
        "interrupted-task", RUN_ID, transient.frame.id
    ) is None
    assert previews.resolve(
        "interrupted-task", RUN_ID, evidence.frame.id
    ) is not None
    assert ("interrupted-task", RUN_ID) not in events._events
    assert events.read("interrupted-task", RUN_ID)[-1].type == "job.failed"
    assert len([
        event for event in events.read("interrupted-task", RUN_ID)
        if event.type == "job.failed"
    ]) == 1

    # A crash after successful result persistence converges to completed, with
    # one terminal event, instead of being rewritten as a failed task.
    completion = recovered_jobs.get("completion-task")
    assert completion is not None
    assert completion.status == "completed"
    assert completion.completion_pending is False
    assert completion.recovery_pending is False
    assert completion.latest_event.type == "job.completed"
    assert completion.latest_event.payload["subtitle_count"] == 1
    assert len([
        event for event in events.read("completion-task", completion_run)
        if event.type == "job.completed"
    ]) == 1
    assert previews.resolve(
        "completion-task", completion_run, completion_transient.frame.id
    ) is None

    # Already-terminal snapshots are swept too, covering a kill between the
    # normal status commit and the worker's finally cleanup.
    assert previews.resolve(
        "terminal-task", terminal_run, terminal_transient.frame.id
    ) is None
    assert previews.resolve(
        "terminal-task", terminal_run, terminal_evidence.frame.id
    ) is not None
    persisted = json.loads(
        (jobs_dir / "interrupted-task.json").read_text(encoding="utf-8")
    )
    assert persisted["recovery_pending"] is False
    assert recovered_jobs.take_interrupted_records() == []

    # A durably precommitted successful result must become publicly completed
    # even when both observability repair and transient cleanup are unavailable.
    degraded_run = "3" * 32
    recovered_jobs.create(JobRecord(
        task_id="degraded-completion",
        filename="degraded.mp4",
        video_path="degraded.mp4",
        status="processing",
        run_id=degraded_run,
        subtitles=[SubtitleItem(
            id="durable-cue", text="DURABLE", start_time=0, end_time=1,
        )],
        completion_pending=True,
        recovery_pending=True,
    ))
    recovered_jobs.prepare_restart_recovery()

    def unavailable(*_args, **_kwargs):
        raise OSError("observability unavailable")

    monkeypatch.setattr(events, "latest_seq", unavailable)
    monkeypatch.setattr(events, "append", unavailable)
    monkeypatch.setattr(previews, "cleanup_transient", unavailable)
    main_module._recover_interrupted_jobs(recovered_jobs, events, previews)

    degraded = recovered_jobs.get("degraded-completion")
    assert degraded is not None
    assert degraded.status == "completed"
    assert degraded.progress == 100
    assert degraded.subtitles[0].text == "DURABLE"
    assert degraded.completion_pending is True
    assert degraded.recovery_pending is True
    assert "completion_pending" not in degraded.public_dict()
    assert "recovery_pending" not in degraded.public_dict()


def test_ai_event_and_preview_http_contract(tmp_path: Path, monkeypatch) -> None:
    jobs = JobStore(tmp_path / "jobs")
    jobs.create(JobRecord(
        task_id="api-progress",
        filename="x.mp4",
        video_path="x.mp4",
        status="processing",
        run_id=RUN_ID,
    ))
    events = EventLogStore(tmp_path / "progress")
    events.begin_run("api-progress", RUN_ID)
    events.append(
        "api-progress", RUN_ID, "stage.progress", {"stage": "probing"},
        progress=1, message="probe",
    )
    previews = PreviewStore(tmp_path / "progress", min_interval_seconds=0)
    full, roi, bounds = _images()
    bundle = previews.write(
        "api-progress", RUN_ID, frame_image=full, roi_image=roi,
        roi_bounds=bounds, candidate_positions=[], now=0,
    )
    assert bundle is not None
    monkeypatch.setattr(main_module, "job_store", jobs)
    monkeypatch.setattr(main_module, "event_store", events)
    monkeypatch.setattr(main_module, "preview_store", previews)
    client = TestClient(main_module.app)

    response = client.get("/jobs/api-progress/events?after_seq=0")
    assert response.status_code == 200
    assert response.json()["latest_seq"] == 1
    assert response.json()["events"][0]["seq"] == 1
    assert client.get("/jobs/api-progress/events?after_seq=1").json()["events"] == []
    image = client.get(
        f"/jobs/api-progress/previews/{bundle.frame.id}?run_id={RUN_ID}"
    )
    assert image.status_code == 200
    assert image.headers["content-type"] == "image/jpeg"
    assert image.content.startswith(b"\xff\xd8")
    assert client.get(
        f"/jobs/api-progress/previews/not-an-id?run_id={RUN_ID}"
    ).status_code == 422
    assert client.get(
        f"/jobs/api-progress/previews/{bundle.frame.id}?run_id={'f' * 32}"
    ).status_code == 404

    events.append(
        "api-progress", RUN_ID, "job.completed",
        {"subtitle_count": 1}, progress=100, message="done",
    )
    terminal_while_snapshot_is_processing = client.get(
        "/jobs/api-progress/events?after_seq=1"
    )
    assert terminal_while_snapshot_is_processing.status_code == 200
    assert terminal_while_snapshot_is_processing.json()["events"][0]["type"] == (
        "job.completed"
    )
    assert ("api-progress", RUN_ID) not in events._events

    jobs.update("api-progress", status="completed")
    terminal_replay = client.get("/jobs/api-progress/events?after_seq=0")
    assert terminal_replay.status_code == 200
    assert terminal_replay.json()["events"][0]["seq"] == 1
    assert ("api-progress", RUN_ID) not in events._events
    assert ("api-progress", RUN_ID) not in events._next_sequences


def test_worker_terminal_status_always_contains_terminal_latest_event(
    tmp_path: Path, monkeypatch
) -> None:
    configured = Settings(data_dir=tmp_path, enable_whisper=False)
    configured.ensure_directories()
    jobs = JobStore(configured.jobs_dir)
    jobs.create(JobRecord(
        task_id="worker-terminal",
        filename="x.mp4",
        video_path=str(tmp_path / "x.mp4"),
        run_id=RUN_ID,
    ))
    events = EventLogStore(configured.progress_dir)
    previews = PreviewStore(configured.progress_dir)

    class SuccessfulPipeline:
        def __init__(self, _settings) -> None:
            pass

        def process(self, *_args, **_kwargs):
            subtitle = SubtitleItem(
                id="cue", text="DONE", start_time=0, end_time=1
            )
            return PipelineResult(
                metadata=VideoMetadata(
                    width=100, height=80, fps=10, frame_count=10, duration=1
                ),
                subtitles=[subtitle],
                ocr_event_count=1,
                whisper_segment_count=0,
                artifacts={"output_srt": str(tmp_path / "output.srt")},
                warnings=[],
            )

    monkeypatch.setattr(main_module, "settings", configured)
    monkeypatch.setattr(main_module, "job_store", jobs)
    monkeypatch.setattr(main_module, "event_store", events)
    monkeypatch.setattr(main_module, "preview_store", previews)
    monkeypatch.setattr(main_module, "SubtitlePipeline", SuccessfulPipeline)
    main_module._run_pipeline(
        "worker-terminal",
        tmp_path / "x.mp4",
        "en",
        2,
        False,
        RUN_ID,
        None,
    )
    completed = jobs.get("worker-terminal")
    assert completed.status == "completed"
    assert completed.latest_event.type == "job.completed"
    assert completed.latest_event.payload["artifacts"] == ["output_srt"]
    assert completed.artifacts["output_srt"] == str(tmp_path / "output.srt")
    assert ("worker-terminal", RUN_ID) not in events._events
    assert completed.latest_seq == events.latest_seq("worker-terminal", RUN_ID)

    failed_run = "fedcba9876543210fedcba9876543210"
    jobs.create(JobRecord(
        task_id="worker-failed",
        filename="x.mp4",
        video_path=str(tmp_path / "x.mp4"),
        run_id=failed_run,
    ))

    class FailedPipeline:
        def __init__(self, _settings) -> None:
            pass

        def process(self, *_args, **_kwargs):
            raise RuntimeError("expected failure")

    monkeypatch.setattr(main_module, "SubtitlePipeline", FailedPipeline)
    main_module._run_pipeline(
        "worker-failed",
        tmp_path / "x.mp4",
        "en",
        2,
        False,
        failed_run,
        None,
    )
    failed = jobs.get("worker-failed")
    assert failed.status == "failed"
    assert failed.latest_event.type == "job.failed"
    assert failed.latest_event.payload["error"] == "expected failure"
    assert ("worker-failed", failed_run) not in events._events
