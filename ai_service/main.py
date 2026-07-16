from __future__ import annotations

import importlib.util
import logging
import re
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path


if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from ai_service.config import settings
from ai_service.job_store import JobStore
from ai_service.pipeline import SubtitlePipeline
from ai_service.schemas import JobRecord, NormalizedROI


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("ai-subtitle-studio")

settings.ensure_directories()
job_store = JobStore(settings.jobs_dir)
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="subtitle-job")

app = FastAPI(
    title="AI Subtitle Studio - AI Service",
    version="1.0.0",
    description="PaddleOCR-first subtitle extraction with Whisper-assisted correction.",
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
    )
    job_store.create(record)
    executor.submit(
        _run_pipeline,
        safe_task_id,
        video_path,
        language,
        chosen_fps,
        enable_whisper,
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
    roi: NormalizedROI | None,
) -> None:
    try:
        job_store.update(task_id, status="processing", progress=1, message="AI 服务开始处理")
        job_settings = replace(
            settings,
            sample_fps=sample_fps,
            ocr_language=language,
        )
        pipeline = SubtitlePipeline(job_settings)

        def report(value: int, message: str) -> None:
            job_store.update(task_id, progress=value, message=message)

        result = pipeline.process(
            video_path,
            settings.subtitles_dir / task_id,
            enable_whisper=enable_whisper,
            roi=roi,
            progress=report,
        )
        job_store.update(
            task_id,
            status="completed",
            progress=100,
            message=f"处理完成，共生成 {len(result.subtitles)} 条字幕",
            metadata=result.metadata,
            subtitles=result.subtitles,
            artifacts=result.artifacts,
            warnings=result.warnings,
            error=None,
        )
    except Exception as exc:
        logger.exception("Task %s failed", task_id)
        job_store.update(
            task_id,
            status="failed",
            message="AI 处理失败",
            error=str(exc),
        )


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


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
