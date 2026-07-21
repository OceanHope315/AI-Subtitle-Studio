from __future__ import annotations

import importlib.util
import logging
import re
import sys
import uuid
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from threading import Lock


if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from ai_service.config import settings
from ai_service.job_store import JobStore
from ai_service.ocr.base import OCRUnavailableError
from ai_service.ocr.paddle_engine import PaddleOCREngine
from ai_service.pipeline import SubtitlePipeline
from ai_service.progress import EventLogStore, PreviewStore, ProgressPublisher, new_run_id
from ai_service.roi.estimator import estimate_video_roi
from ai_service.schemas import JobRecord, NormalizedROI


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("ai-subtitle-studio")

settings.ensure_directories()
job_store = JobStore(settings.jobs_dir)
event_store = EventLogStore(settings.progress_dir)
preview_store = PreviewStore(
    settings.progress_dir,
    min_interval_seconds=settings.preview_interval_seconds,
    max_previews=settings.preview_ring_size,
    max_long_edge=settings.preview_max_long_edge,
    jpeg_quality=settings.preview_jpeg_quality,
)


def _recover_interrupted_jobs(
    jobs: JobStore,
    events: EventLogStore,
    previews: PreviewStore,
) -> None:
    """Persist and publish a terminal state for work lost on process exit."""

    for record in jobs.take_interrupted_records():
        if record.run_id is None:
            continue
        terminal_type = "job.completed" if record.completion_pending else "job.failed"
        if record.completion_pending:
            try:
                # The result itself was durably precommitted before the crash.
                # Make that core outcome public immediately; JSONL repair and
                # preview cleanup remain retryable best-effort side effects.
                jobs.update(
                    record.task_id,
                    status="completed",
                    progress=100,
                    message=f"处理完成，共生成 {len(record.subtitles)} 条字幕",
                    error=None,
                )
            except Exception:
                logger.exception(
                    "Unable to expose recovered completion for %s",
                    record.task_id,
                )
        event_recovered = bool(
            record.latest_event is not None
            and record.latest_event.run_id == record.run_id
            and record.latest_event.type == terminal_type
        )
        cleanup_recovered = False
        # A process can exit after the append-only terminal event reaches disk
        # but before its lightweight job snapshot is persisted. Consult the log
        # tail before publishing so a later boot does not create a second
        # terminal event for the same interrupted run.
        if not event_recovered:
            try:
                latest_seq = events.latest_seq(record.task_id, record.run_id)
                tail = events.read(
                    record.task_id,
                    record.run_id,
                    after_seq=max(0, latest_seq - 1),
                    limit=1,
                )
                if tail and tail[-1].type == terminal_type:
                    event_recovered = True
                    jobs.update_progress_snapshot(tail[-1], persist_interval=0)
            except Exception:
                logger.exception(
                    "Unable to inspect restart recovery log for %s",
                    record.task_id,
                )
        try:
            if not event_recovered:
                publisher = ProgressPublisher(
                    record.task_id,
                    record.run_id,
                    events,
                    previews,
                    on_event=jobs.update_progress_snapshot,
                )
                if record.completion_pending:
                    terminal = publisher.completed(
                        subtitle_count=len(record.subtitles),
                        artifacts=record.artifacts,
                    )
                else:
                    terminal = publisher.failed(
                        record.error or "AI 服务重启中断了任务"
                    )
                event_recovered = terminal is not None
        except Exception:
            logger.exception("Unable to publish restart recovery for %s", record.task_id)
        try:
            previews.cleanup_transient(record.task_id, record.run_id)
            cleanup_recovered = True
        except Exception:
            logger.exception(
                "Unable to clean interrupted previews for %s", record.task_id
            )
        events.release_hot_cache(record.task_id, record.run_id)
        if event_recovered and cleanup_recovered:
            try:
                changes: dict[str, object] = {"recovery_pending": False}
                if record.completion_pending:
                    changes.update(
                        completion_pending=False,
                    )
                jobs.update(record.task_id, **changes)
            except Exception:
                logger.exception(
                    "Unable to finish restart recovery for %s", record.task_id
                )
        else:
            logger.warning(
                "Restart recovery remains pending for %s (event=%s, cleanup=%s)",
                record.task_id,
                event_recovered,
                cleanup_recovered,
            )


    # A normal worker can be killed after its terminal snapshot reaches disk
    # but before its finally block removes transient previews. Sweep every
    # terminal run on startup; evidence previews remain untouched.
    for record in jobs.list_records():
        if record.status not in {"completed", "failed"} or record.run_id is None:
            continue
        try:
            previews.cleanup_transient(record.task_id, record.run_id)
        except Exception:
            logger.exception(
                "Unable to sweep terminal previews for %s", record.task_id
            )
        events.release_hot_cache(record.task_id, record.run_id)


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    # Keep import/pytest collection read-only with respect to existing jobs.
    # Recovery is an application-start operation, not a module-import action.
    job_store.prepare_restart_recovery()
    _recover_interrupted_jobs(job_store, event_store, preview_store)
    yield


executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="subtitle-job")
ocr_work_lock = Lock()

app = FastAPI(
    title="AI Subtitle Studio - AI Service",
    version="1.0.0",
    description="PaddleOCR-first subtitle extraction with Whisper-assisted correction.",
    lifespan=_lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in settings.cors_origins.split(",") if origin.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "ai-subtitle-studio-ai",
        "paddleocr_installed": bool(importlib.util.find_spec("paddleocr")),
        "paddlepaddle_installed": bool(importlib.util.find_spec("paddle")),
        "faster_whisper_installed": bool(importlib.util.find_spec("faster_whisper")),
        "data_dir": str(settings.data_dir),
    }


@app.post("/estimate-roi")
def estimate_roi(
    video: UploadFile = File(...),
    language: str = Form(default="en"),
    frame_count: int = Form(default=16),
    confidence_threshold: float | None = Form(default=None),
) -> dict:
    """Run bounded PaddleOCR sampling without creating an analysis job."""

    filename = Path(video.filename or "video.mp4").name
    if Path(filename).suffix.lower() != ".mp4":
        raise HTTPException(status_code=415, detail="仅支持 MP4 视频")
    if not re.fullmatch(r"[A-Za-z0-9_-]{2,12}", language):
        raise HTTPException(status_code=422, detail="language 格式无效")
    if not 10 <= frame_count <= 20:
        raise HTTPException(status_code=422, detail="frame_count 必须在 10 到 20 之间")
    chosen_threshold = (
        settings.min_ocr_confidence
        if confidence_threshold is None
        else confidence_threshold
    )
    if not 0 <= chosen_threshold <= 1:
        raise HTTPException(
            status_code=422,
            detail="confidence_threshold 必须在 0 到 1 之间",
        )

    temporary_path = settings.videos_dir / f".roi-estimate-{uuid.uuid4().hex}.mp4"
    maximum = settings.max_upload_mb * 1024 * 1024
    size = 0
    lock_acquired = False
    try:
        lock_acquired = ocr_work_lock.acquire(blocking=False)
        if not lock_acquired:
            raise HTTPException(status_code=503, detail="AI 服务正忙，请使用人工字幕区域")
        with temporary_path.open("wb") as target:
            while chunk := video.file.read(1024 * 1024):
                size += len(chunk)
                if size > maximum:
                    raise HTTPException(
                        status_code=413,
                        detail=f"视频超过 {settings.max_upload_mb} MB 限制",
                    )
                target.write(chunk)

        engine = PaddleOCREngine(
            language,
            chosen_threshold,
            settings.ocr_device,
        )
        result = estimate_video_roi(
            temporary_path,
            engine,
            frame_count=frame_count,
            confidence_threshold=chosen_threshold,
        )
    except HTTPException:
        raise
    except OCRUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Automatic ROI estimation failed")
        raise HTTPException(status_code=500, detail="字幕区域估计失败") from exc
    finally:
        if lock_acquired:
            ocr_work_lock.release()
        video.file.close()
        temporary_path.unlink(missing_ok=True)

    if result is None:
        return {"success": False, "reason": "no subtitle detected"}
    return {
        "success": True,
        "roi": result.roi.model_dump(mode="json"),
    }


@app.post("/jobs", status_code=202)
def create_job(
    video: UploadFile = File(...),
    task_id: str | None = Form(default=None),
    language: str = Form(default="en"),
    sample_fps: float | None = Form(default=None),
    enable_whisper: bool | None = Form(default=None),
    roi_x: float | None = Form(default=None),
    roi_y: float | None = Form(default=None),
    roi_width: float | None = Form(default=None),
    roi_height: float | None = Form(default=None),
) -> dict:
    filename = Path(video.filename or "video.mp4").name
    if Path(filename).suffix.lower() != ".mp4":
        raise HTTPException(status_code=415, detail="仅支持 MP4 视频")
    safe_task_id = task_id or str(uuid.uuid4())
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", safe_task_id):
        raise HTTPException(status_code=422, detail="task_id 格式无效")
    if job_store.get(safe_task_id):
        raise HTTPException(status_code=409, detail="task_id 已存在")
    chosen_fps = sample_fps if sample_fps is not None else settings.sample_fps
    if not 0.25 <= chosen_fps <= 10:
        raise HTTPException(status_code=422, detail="sample_fps 必须在 0.25 到 10 之间")
    if not re.fullmatch(r"[A-Za-z0-9_-]{2,12}", language):
        raise HTTPException(status_code=422, detail="language 格式无效")
    roi = _validated_roi(roi_x, roi_y, roi_width, roi_height)
    run_id = new_run_id()

    video_directory = settings.videos_dir / safe_task_id
    video_directory.mkdir(parents=True, exist_ok=False)
    video_path = video_directory / "source.mp4"
    maximum = settings.max_upload_mb * 1024 * 1024
    size = 0
    try:
        with video_path.open("wb") as target:
            while chunk := video.file.read(1024 * 1024):
                size += len(chunk)
                if size > maximum:
                    raise HTTPException(
                        status_code=413,
                        detail=f"视频超过 {settings.max_upload_mb} MB 限制",
                    )
                target.write(chunk)
    except Exception:
        video_path.unlink(missing_ok=True)
        video_directory.rmdir()
        raise
    finally:
        video.file.close()

    record = JobRecord(
        task_id=safe_task_id,
        filename=filename,
        video_path=str(video_path),
        roi=roi,
        status="queued",
        progress=0,
        message="视频已接收，等待 AI 处理",
        run_id=run_id,
    )
    job_store.create(record)
    executor.submit(
        _run_pipeline,
        safe_task_id,
        video_path,
        language,
        chosen_fps,
        enable_whisper,
        run_id,
        roi,
    )
    return record.public_dict()


@app.get("/jobs/{task_id}")
def get_job(task_id: str) -> dict:
    record = job_store.get(task_id)
    if record is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    return record.public_dict()


@app.get("/jobs/{task_id}/subtitles")
def get_subtitles(task_id: str) -> dict:
    record = job_store.get(task_id)
    if record is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    return {"task_id": task_id, "subtitles": [item.model_dump(mode="json") for item in record.subtitles]}


@app.get("/jobs/{task_id}/events")
def get_events(
    task_id: str,
    after_seq: int = Query(default=0, ge=0),
) -> dict:
    _validate_task_id(task_id)
    record = job_store.get(task_id)
    if record is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    if record.run_id is None:
        return {
            "task_id": task_id,
            "run_id": None,
            "latest_seq": 0,
            "events": [],
            "has_more": False,
        }
    events = event_store.read(task_id, record.run_id, after_seq=after_seq)
    latest_seq = event_store.latest_seq(task_id, record.run_id)
    returned_seq = events[-1].seq if events else after_seq
    response = {
        "task_id": task_id,
        "run_id": record.run_id,
        "latest_seq": latest_seq,
        "events": [event.public_dict() for event in events],
        "has_more": returned_seq < latest_seq,
    }
    # A terminal replay is disk-backed and short-lived. Do not let a final
    # Express poll repopulate completed-run objects after worker cleanup.
    terminal_replay = record.status in {"completed", "failed"} or any(
        event.type in {"job.completed", "job.failed"} for event in events
    )
    if not terminal_replay:
        latest_record = job_store.get(task_id)
        terminal_replay = latest_record is not None and latest_record.status in {
            "completed",
            "failed",
        }
    if terminal_replay:
        event_store.release_hot_cache(task_id, record.run_id)
    return response


@app.get("/jobs/{task_id}/previews/{preview_id}")
def get_preview(task_id: str, preview_id: str, run_id: str = Query(...)):
    _validate_task_id(task_id)
    if not re.fullmatch(r"[0-9a-f]{32}", run_id):
        raise HTTPException(status_code=422, detail="run_id 格式无效")
    if not re.fullmatch(r"[0-9a-f]{32}", preview_id):
        raise HTTPException(status_code=422, detail="preview_id 格式无效")
    record = job_store.get(task_id)
    if record is None or record.run_id != run_id:
        raise HTTPException(status_code=404, detail="预览不存在")
    path = preview_store.resolve(task_id, run_id, preview_id)
    if path is None:
        raise HTTPException(status_code=404, detail="预览不存在")
    return FileResponse(
        path,
        media_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=300, immutable"},
    )


@app.get("/jobs/{task_id}/artifacts/{artifact_name}")
def get_artifact(task_id: str, artifact_name: str):
    record = job_store.get(task_id)
    if record is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    mapping = {
        "ocr_events.json": "ocr_events_json",
        "subtitle.json": "subtitle_json",
        "output.srt": "output_srt",
        "diagnostics.json": "diagnostics_json",
    }
    key = mapping.get(artifact_name)
    path = Path(record.artifacts.get(key, "")) if key else None
    if not path or not path.is_file():
        raise HTTPException(status_code=404, detail="产物尚未生成")
    media_type = "application/x-subrip" if path.suffix == ".srt" else "application/json"
    return FileResponse(path, media_type=media_type, filename=artifact_name)


def _run_pipeline(
    task_id: str,
    video_path: Path,
    language: str,
    sample_fps: float,
    enable_whisper: bool | None,
    run_id: str,
    roi: NormalizedROI | None,
) -> None:
    # Construct the best-effort publisher before the first mutable job action,
    # so even an early worker-start failure can attempt a terminal event.
    publisher = ProgressPublisher(
        task_id,
        run_id,
        event_store,
        preview_store,
        on_event=job_store.update_progress_snapshot,
    )
    try:
        job_store.update(
            task_id,
            status="processing",
            progress=1,
            message="AI 服务开始处理",
            run_id=run_id,
            latest_seq=0,
            latest_event=None,
            latest_frame_event=None,
            latest_preview_event=None,
            error=None,
        )
        try:
            event_store.begin_run(task_id, run_id)
        except Exception:
            # The publisher is best-effort by design; a progress filesystem
            # problem must not put OCR and artifact generation on a failure path.
            logger.exception("Unable to initialize progress log for %s", task_id)
        job_settings = replace(
            settings,
            sample_fps=sample_fps,
            ocr_language=language,
        )
        pipeline = SubtitlePipeline(job_settings)

        def report(value: int, message: str) -> None:
            job_store.update_legacy_progress(task_id, value, message)

        with ocr_work_lock:
            result = pipeline.process(
                video_path,
                settings.subtitles_dir / task_id,
                enable_whisper=enable_whisper,
                roi=roi,
                progress=report,
                event_publisher=publisher,
            )
        completion_message = f"处理完成，共生成 {len(result.subtitles)} 条字幕"
        # Write the complete successful result before its terminal event. If
        # the process exits anywhere in the following commit window, startup
        # can publish/reuse job.completed and finish the same outcome instead
        # of turning an already-completed run into a failure.
        job_store.update(
            task_id,
            progress=99,
            message="正在提交处理结果",
            metadata=result.metadata,
            subtitles=result.subtitles,
            artifacts=result.artifacts,
            warnings=result.warnings,
            error=None,
            completion_pending=True,
            recovery_pending=True,
        )
        # Publish first: once the job snapshot becomes terminal, its
        # latest_event and replay log are guaranteed to already contain the
        # terminal event. Express may safely stop polling at that point.
        publisher.completed(
            subtitle_count=len(result.subtitles), artifacts=result.artifacts
        )
        try:
            job_store.update(
                task_id,
                status="completed",
                progress=100,
                message=completion_message,
                completion_pending=False,
                recovery_pending=False,
            )
        except Exception:
            # JobStore updates memory before its atomic file replace. Keep the
            # successful outcome in-process; the durable pending snapshot lets
            # the next startup finish the commit if persistence failed.
            logger.exception("Unable to finalize completed task %s", task_id)
    except Exception as exc:
        logger.exception("Task %s failed", task_id)
        publisher.failed(str(exc))
        try:
            job_store.update(
                task_id,
                status="failed",
                message="AI 处理失败",
                error=str(exc),
                completion_pending=False,
                recovery_pending=False,
            )
        except Exception:
            # The append-only terminal event and any earlier job snapshot are
            # enough for startup recovery to converge on a failed state.
            logger.exception("Unable to finalize failed task %s", task_id)
    finally:
        try:
            preview_store.cleanup_transient(task_id, run_id)
        except Exception:
            logger.exception("Unable to clean transient previews for %s", task_id)
        event_store.release_hot_cache(task_id, run_id)


def _validated_roi(
    x: float | None,
    y: float | None,
    width: float | None,
    height: float | None,
) -> NormalizedROI | None:
    values = (x, y, width, height)
    if all(value is None for value in values):
        return None
    if any(value is None for value in values):
        raise HTTPException(
            status_code=422,
            detail="roi_x、roi_y、roi_width、roi_height 必须同时提供",
        )
    try:
        return NormalizedROI(x=x, y=y, width=width, height=height)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"字幕区域无效: {exc}") from exc


def _validate_task_id(task_id: str) -> None:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", task_id):
        raise HTTPException(status_code=422, detail="task_id 格式无效")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
