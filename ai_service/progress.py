from __future__ import annotations

from collections import deque
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime, timezone
from fractions import Fraction
import json
import logging
import os
from pathlib import Path
import re
import secrets
import threading
import time
import uuid
from typing import Any

import cv2
import numpy as np

from ai_service.schemas import NormalizedROI, ProgressEvent, SubtitleItem, VideoMetadata


logger = logging.getLogger(__name__)

TASK_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
OPAQUE_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
LOCK_STRIPES = 64


def new_run_id() -> str:
    return uuid.uuid4().hex


def _validate_task_id(task_id: str) -> None:
    if not TASK_ID_PATTERN.fullmatch(task_id):
        raise ValueError("invalid task_id")


def _validate_opaque_id(value: str, label: str) -> None:
    if not OPAQUE_ID_PATTERN.fullmatch(value):
        raise ValueError(f"invalid {label}")


class EventLogStore:
    """Independent append-only JSONL history with a bounded hot cache.

    Job snapshots deliberately do not contain this history. A process restart
    can reconstruct the next sequence number and replay events directly from
    JSONL; an incomplete final line is ignored rather than affecting the job.
    """

    def __init__(self, root: str | Path, *, memory_limit: int = 512) -> None:
        if memory_limit < 1:
            raise ValueError("memory_limit must be positive")
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.memory_limit = memory_limit
        self._events: dict[tuple[str, str], deque[ProgressEvent]] = {}
        self._next_sequences: dict[tuple[str, str], int] = {}
        self._locks = tuple(threading.RLock() for _ in range(LOCK_STRIPES))

    def begin_run(self, task_id: str, run_id: str | None = None) -> str:
        run_id = run_id or new_run_id()
        path = self._run_directory(task_id, run_id)
        path.mkdir(parents=True, exist_ok=True)
        key = (task_id, run_id)
        with self._lock_for(key):
            self._ensure_loaded(key)
        return run_id

    def append(
        self,
        task_id: str,
        run_id: str,
        event_type: str,
        payload: dict[str, Any],
        *,
        progress: int,
        message: str,
    ) -> ProgressEvent:
        key = (task_id, run_id)
        with self._lock_for(key):
            self._run_directory(task_id, run_id).mkdir(parents=True, exist_ok=True)
            self._ensure_loaded(key)
            event = ProgressEvent(
                seq=self._next_sequences[key],
                task_id=task_id,
                run_id=run_id,
                type=event_type,
                occurred_at=datetime.now(timezone.utc),
                payload=payload,
                progress=progress,
                message=message,
            )
            log_path = self._log_path(task_id, run_id)
            encoded = json.dumps(
                event.model_dump(mode="json"), ensure_ascii=False, separators=(",", ":")
            )
            with log_path.open("a", encoding="utf-8", newline="\n") as stream:
                stream.write(encoded)
                stream.write("\n")
                stream.flush()
            self._next_sequences[key] += 1
            self._events[key].append(event)
            return event.model_copy(deep=True)

    def read(
        self,
        task_id: str,
        run_id: str,
        *,
        after_seq: int = 0,
        limit: int = 500,
    ) -> list[ProgressEvent]:
        if after_seq < 0:
            raise ValueError("after_seq must not be negative")
        if not 1 <= limit <= 5000:
            raise ValueError("limit must be between 1 and 5000")
        key = (task_id, run_id)
        with self._lock_for(key):
            self._ensure_loaded(key)
            cached = self._events[key]
            if cached and after_seq >= cached[0].seq - 1:
                return [
                    item.model_copy(deep=True)
                    for item in cached
                    if item.seq > after_seq
                ][:limit]
            return self._read_jsonl(task_id, run_id, after_seq=after_seq, limit=limit)

    def latest_seq(self, task_id: str, run_id: str) -> int:
        key = (task_id, run_id)
        with self._lock_for(key):
            self._ensure_loaded(key)
            return self._next_sequences[key] - 1

    def release_hot_cache(self, task_id: str, run_id: str) -> None:
        """Release bounded in-memory event state after a run terminates.

        The append-only JSONL remains the recovery source, so a later replay
        can lazily reconstruct sequence state without keeping completed runs'
        event objects resident for the process lifetime.
        """

        key = (task_id, run_id)
        with self._lock_for(key):
            self._events.pop(key, None)
            self._next_sequences.pop(key, None)

    def _ensure_loaded(self, key: tuple[str, str]) -> None:
        if key in self._next_sequences:
            return
        task_id, run_id = key
        recent: deque[ProgressEvent] = deque(maxlen=self.memory_limit)
        latest = 0
        path = self._log_path(task_id, run_id)
        if path.is_file():
            try:
                _repair_jsonl_tail(path, task_id=task_id, run_id=run_id)
                with path.open("r", encoding="utf-8") as stream:
                    for line in stream:
                        try:
                            event = ProgressEvent.model_validate_json(line)
                        except ValueError:
                            # A crash may leave one partial line. Valid earlier
                            # events remain replayable and job execution is not
                            # coupled to this recovery path.
                            continue
                        if event.task_id != task_id or event.run_id != run_id:
                            continue
                        if event.seq <= latest:
                            continue
                        latest = event.seq
                        recent.append(event)
            except OSError:
                logger.exception("Unable to recover progress log %s", path)
        self._events[key] = recent
        self._next_sequences[key] = latest + 1

    def _lock_for(self, key: tuple[str, str]) -> threading.RLock:
        return self._locks[hash(key) % len(self._locks)]

    def _read_jsonl(
        self, task_id: str, run_id: str, *, after_seq: int, limit: int
    ) -> list[ProgressEvent]:
        path = self._log_path(task_id, run_id)
        if not path.is_file():
            return []
        result: list[ProgressEvent] = []
        try:
            with path.open("r", encoding="utf-8") as stream:
                for line in stream:
                    try:
                        event = ProgressEvent.model_validate_json(line)
                    except ValueError:
                        continue
                    if (
                        event.task_id == task_id
                        and event.run_id == run_id
                        and event.seq > after_seq
                    ):
                        result.append(event)
                        if len(result) >= limit:
                            break
        except OSError:
            logger.exception("Unable to read progress log %s", path)
            return []
        return result

    def _run_directory(self, task_id: str, run_id: str) -> Path:
        _validate_task_id(task_id)
        _validate_opaque_id(run_id, "run_id")
        return self.root / task_id / run_id

    def _log_path(self, task_id: str, run_id: str) -> Path:
        return self._run_directory(task_id, run_id) / "events.jsonl"


@dataclass(frozen=True, slots=True)
class PreviewAsset:
    id: str
    width: int
    height: int
    source_width: int
    source_height: int
    mime_type: str = "image/jpeg"

    def as_payload(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "width": self.width,
            "height": self.height,
            "source_width": self.source_width,
            "source_height": self.source_height,
            "mime_type": self.mime_type,
        }


@dataclass(frozen=True, slots=True)
class PreviewBundle:
    frame: PreviewAsset
    roi: PreviewAsset
    evidence: bool

    def as_payload(self) -> dict[str, Any]:
        return {
            "frame": self.frame.as_payload(),
            "roi": self.roi.as_payload(),
            "evidence": self.evidence,
        }


class PreviewStore:
    """Rate-limited atomic JPEG storage with transient and evidence tiers."""

    def __init__(
        self,
        root: str | Path,
        *,
        min_interval_seconds: float = 1.0,
        max_previews: int = 8,
        max_long_edge: int = 800,
        jpeg_quality: int = 80,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if min_interval_seconds < 0:
            raise ValueError("min_interval_seconds must not be negative")
        if max_previews < 1:
            raise ValueError("max_previews must be positive")
        if max_long_edge < 64:
            raise ValueError("max_long_edge must be at least 64")
        if not 1 <= jpeg_quality <= 100:
            raise ValueError("jpeg_quality must be between 1 and 100")
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.min_interval_seconds = min_interval_seconds
        self.max_previews = max_previews
        self.max_long_edge = max_long_edge
        self.jpeg_quality = jpeg_quality
        self.clock = clock
        self._last_write: dict[tuple[str, str], float] = {}
        self._bundles: dict[tuple[str, str], deque[tuple[Path, Path, Path]]] = {}
        self._locks = tuple(threading.RLock() for _ in range(LOCK_STRIPES))

    def write(
        self,
        task_id: str,
        run_id: str,
        *,
        frame_image: np.ndarray,
        roi_image: np.ndarray,
        roi_bounds: tuple[int, int, int, int],
        candidate_positions: Iterable[Iterable[int]],
        evidence: bool = False,
        now: float | None = None,
    ) -> PreviewBundle | None:
        key = (task_id, run_id)
        with self._lock_for(key):
            directory = self._tier_directory(task_id, run_id, evidence=evidence)
            directory.mkdir(parents=True, exist_ok=True)
            timestamp = self.clock() if now is None else now
            if not evidence:
                last = self._last_write.get(key)
                if last is not None and timestamp - last < self.min_interval_seconds:
                    return None
                self._last_write[key] = timestamp
                self._ensure_bundle_index(key)

            full = _normalise_bgr(frame_image).copy()
            crop = _normalise_bgr(roi_image).copy()
            left, top, right, bottom = roi_bounds
            cv2.rectangle(full, (left, top), (max(left, right - 1), max(top, bottom - 1)),
                          (52, 211, 153), 2)
            for raw_position in candidate_positions:
                position = [int(value) for value in raw_position]
                if len(position) != 4:
                    continue
                x1, y1, x2, y2 = position
                cv2.rectangle(full, (x1, y1), (x2, y2), (48, 135, 255), 2)
                local_x1, local_y1 = x1 - left, y1 - top
                local_x2, local_y2 = x2 - left, y2 - top
                cv2.rectangle(
                    crop,
                    (max(0, local_x1), max(0, local_y1)),
                    (min(crop.shape[1] - 1, local_x2), min(crop.shape[0] - 1, local_y2)),
                    (48, 135, 255),
                    2,
                )

            full_source_height, full_source_width = full.shape[:2]
            roi_source_height, roi_source_width = crop.shape[:2]
            full = _fit_long_edge(full, self.max_long_edge)
            crop = _fit_long_edge(crop, self.max_long_edge)
            frame_id, roi_id = secrets.token_hex(16), secrets.token_hex(16)
            frame_path = directory / f"{frame_id}.jpg"
            roi_path = directory / f"{roi_id}.jpg"
            _atomic_jpeg(frame_path, full, self.jpeg_quality)
            try:
                _atomic_jpeg(roi_path, crop, self.jpeg_quality)
            except Exception:
                frame_path.unlink(missing_ok=True)
                raise

            bundle = PreviewBundle(
                frame=PreviewAsset(
                    frame_id,
                    full.shape[1],
                    full.shape[0],
                    full_source_width,
                    full_source_height,
                ),
                roi=PreviewAsset(
                    roi_id,
                    crop.shape[1],
                    crop.shape[0],
                    roi_source_width,
                    roi_source_height,
                ),
                evidence=evidence,
            )
            if not evidence:
                manifest_path = directory / f"{frame_id}.bundle.json"
                try:
                    _atomic_json(
                        manifest_path,
                        {
                            "frame_id": frame_id,
                            "roi_id": roi_id,
                            "created_at": datetime.now(timezone.utc).isoformat(),
                        },
                    )
                except Exception:
                    # Without the manifest the ring index cannot discover or
                    # prune this pair after restart. Roll the JPEGs back as one
                    # failed bundle so repeated write failures stay bounded.
                    frame_path.unlink(missing_ok=True)
                    roi_path.unlink(missing_ok=True)
                    manifest_path.unlink(missing_ok=True)
                    raise
                self._bundles[key].append((frame_path, roi_path, manifest_path))
                self._prune(key)
            return bundle

    def resolve(
        self, task_id: str, run_id: str, preview_id: str
    ) -> Path | None:
        _validate_task_id(task_id)
        _validate_opaque_id(run_id, "run_id")
        _validate_opaque_id(preview_id, "preview_id")
        run_directory = self._run_directory(task_id, run_id).resolve()
        root = self.root.resolve()
        if not run_directory.is_relative_to(root):
            return None
        for tier in ("previews", "evidence"):
            tier_directory = (run_directory / tier).resolve()
            if not tier_directory.is_relative_to(run_directory):
                continue
            target = (tier_directory / f"{preview_id}.jpg").resolve()
            if target.parent != tier_directory:
                return None
            if target.is_file():
                return target
        return None

    def cleanup_transient(self, task_id: str, run_id: str) -> None:
        key = (task_id, run_id)
        with self._lock_for(key):
            directory = self._tier_directory(task_id, run_id, evidence=False)
            if directory.is_dir():
                for path in directory.iterdir():
                    if path.is_file():
                        path.unlink(missing_ok=True)
            self._bundles.pop(key, None)
            self._last_write.pop(key, None)

    def _ensure_bundle_index(self, key: tuple[str, str]) -> None:
        if key in self._bundles:
            return
        task_id, run_id = key
        directory = self._tier_directory(task_id, run_id, evidence=False)
        bundles: list[tuple[float, Path, Path, Path]] = []
        if directory.is_dir():
            for manifest in directory.glob("*.bundle.json"):
                try:
                    payload = json.loads(manifest.read_text(encoding="utf-8"))
                    frame_id, roi_id = payload["frame_id"], payload["roi_id"]
                    _validate_opaque_id(frame_id, "preview_id")
                    _validate_opaque_id(roi_id, "preview_id")
                    frame_path = directory / f"{frame_id}.jpg"
                    roi_path = directory / f"{roi_id}.jpg"
                    if frame_path.is_file() and roi_path.is_file():
                        bundles.append(
                            (manifest.stat().st_mtime, frame_path, roi_path, manifest)
                        )
                except (KeyError, OSError, ValueError, json.JSONDecodeError):
                    continue
        bundles.sort(key=lambda item: item[0])
        self._bundles[key] = deque((item[1], item[2], item[3]) for item in bundles)
        self._prune(key)

    def _lock_for(self, key: tuple[str, str]) -> threading.RLock:
        return self._locks[hash(key) % len(self._locks)]

    def _prune(self, key: tuple[str, str]) -> None:
        while len(self._bundles[key]) > self.max_previews:
            for path in self._bundles[key].popleft():
                path.unlink(missing_ok=True)

    def _run_directory(self, task_id: str, run_id: str) -> Path:
        _validate_task_id(task_id)
        _validate_opaque_id(run_id, "run_id")
        return self.root / task_id / run_id

    def _tier_directory(self, task_id: str, run_id: str, *, evidence: bool) -> Path:
        return self._run_directory(task_id, run_id) / (
            "evidence" if evidence else "previews"
        )


class ProgressPublisher:
    """Translate real pipeline state into persisted structured events."""

    def __init__(
        self,
        task_id: str,
        run_id: str,
        event_store: EventLogStore,
        preview_store: PreviewStore,
        *,
        on_event: Callable[[ProgressEvent], None] | None = None,
    ) -> None:
        _validate_task_id(task_id)
        _validate_opaque_id(run_id, "run_id")
        self.task_id = task_id
        self.run_id = run_id
        self.event_store = event_store
        self.preview_store = preview_store
        self.on_event = on_event
        self.progress = 0
        self.message = ""

    def publish(
        self,
        event_type: str,
        payload: dict[str, Any],
        *,
        progress: int | None = None,
        message: str | None = None,
    ) -> ProgressEvent | None:
        if progress is not None:
            self.progress = max(0, min(100, int(progress)))
        if message is not None:
            self.message = message
        try:
            event = self.event_store.append(
                self.task_id,
                self.run_id,
                event_type,
                payload,
                progress=self.progress,
                message=self.message,
            )
        except Exception:
            # Progress observability is deliberately not on the task's critical
            # path. OCR/artifact generation must still be able to complete.
            logger.exception(
                "Unable to append %s for task %s", event_type, self.task_id
            )
            return None
        if self.on_event is not None:
            try:
                self.on_event(event.model_copy(deep=True))
            except Exception:
                logger.exception("Unable to update progress snapshot for %s", self.task_id)
        return event

    def stage_progress(
        self,
        stage: str,
        stage_label: str,
        overall_progress: int,
        *,
        processed: int = 0,
        total: int = 0,
        detected_cue_count: int | None = None,
        message: str,
    ) -> ProgressEvent | None:
        payload: dict[str, Any] = {
            "stage": stage,
            "stage_label": stage_label,
            "overall_progress": overall_progress,
            "processed": processed,
            "total": total,
            "message": message,
        }
        if detected_cue_count is not None:
            payload["detected_cue_count"] = max(0, int(detected_cue_count))
        return self.publish(
            "stage.progress",
            payload,
            progress=overall_progress,
            message=message,
        )

    def frame_analyzed(
        self,
        *,
        stage: str,
        frame: Any,
        metadata: VideoMetadata,
        roi: NormalizedROI,
        candidates: Iterable[Any],
        processed: int,
        total: int,
        detected_cue_count: int,
        evidence: bool = False,
        ocr_error: str | None = None,
    ) -> ProgressEvent | None:
        candidate_payload = [_candidate_payload(item) for item in candidates]
        roi_image = np.asarray(frame.image)
        source = getattr(frame, "source_image", None)
        if source is None:
            if (
                frame.roi_offset_x == 0
                and frame.roi_offset_y == 0
                and roi_image.shape[1] == metadata.width
                and roi_image.shape[0] == metadata.height
            ):
                source = roi_image
            else:
                source = np.zeros((metadata.height, metadata.width, 3), dtype=np.uint8)
                top, left = frame.roi_offset_y, frame.roi_offset_x
                bottom = min(metadata.height, top + roi_image.shape[0])
                right = min(metadata.width, left + roi_image.shape[1])
                source[top:bottom, left:right] = roi_image[: bottom - top, : right - left]
        roi_bounds = (
            int(frame.roi_offset_x),
            int(frame.roi_offset_y),
            int(frame.roi_offset_x + roi_image.shape[1]),
            int(frame.roi_offset_y + roi_image.shape[0]),
        )
        preview: PreviewBundle | None = None
        try:
            preview = self.preview_store.write(
                self.task_id,
                self.run_id,
                frame_image=np.asarray(source),
                roi_image=roi_image,
                roi_bounds=roi_bounds,
                candidate_positions=(item["position"] for item in candidate_payload),
                evidence=evidence,
            )
        except Exception:
            logger.exception("Unable to create preview for task %s", self.task_id)
        numerator, denominator = _time_base_parts(getattr(frame, "time_base", None))
        payload: dict[str, Any] = {
            "stage": stage,
            "frame_index": int(frame.frame_index),
            "pts": getattr(frame, "pts", None),
            "pts_source": "container" if getattr(frame, "pts", None) is not None else None,
            "time_base_num": numerator,
            "time_base_den": denominator,
            "media_time": float(frame.timestamp),
            "media_time_source": "pts" if getattr(frame, "pts", None) is not None else "reader",
            "processed": int(processed),
            "total": int(total),
            "detected_cue_count": int(detected_cue_count),
            "preview_id": preview.frame.id if preview else None,
            "roi_preview_id": preview.roi.id if preview else None,
            "preview": preview.as_payload() if preview else None,
            "roi": roi.model_dump(mode="json"),
            "video_width": metadata.width,
            "video_height": metadata.height,
            "coordinate_space": "video",
            "candidates": candidate_payload,
            "evidence": evidence,
        }
        if ocr_error:
            payload["ocr_error"] = ocr_error
        return self.publish("frame.analyzed", payload)

    def cue_upserted(
        self,
        cue: SubtitleItem,
        *,
        stage: str,
        detected_cue_count: int,
    ) -> ProgressEvent | None:
        return self.publish(
            "cue.upserted",
            {
                "stage": stage,
                "detected_cue_count": max(0, int(detected_cue_count)),
                "cue": cue.model_dump(mode="json"),
            },
        )

    def completed(
        self, *, subtitle_count: int, artifacts: dict[str, str]
    ) -> ProgressEvent | None:
        message = f"处理完成，共生成 {subtitle_count} 条字幕"
        return self.publish(
            "job.completed",
            {
                "subtitle_count": subtitle_count,
                "detected_cue_count": subtitle_count,
                # Event payloads cross the service boundary. Only expose
                # logical artifact names; filesystem paths remain private in
                # the job record and dedicated download endpoints.
                "artifacts": sorted(str(name) for name in artifacts),
            },
            progress=100,
            message=message,
        )

    def failed(self, error: str) -> ProgressEvent | None:
        return self.publish(
            "job.failed", {"error": error}, message="AI 处理失败"
        )


def _candidate_payload(candidate: Any) -> dict[str, Any]:
    position = [int(value) for value in candidate.position]
    return {
        "text": str(candidate.text),
        "confidence": float(candidate.confidence),
        "position": position,
        "coordinate_space": "video",
    }


def _time_base_parts(value: str | None) -> tuple[int | None, int | None]:
    if not value:
        return None, None
    try:
        fraction = Fraction(value)
    except (ValueError, ZeroDivisionError):
        return None, None
    return fraction.numerator, fraction.denominator


def _normalise_bgr(image: np.ndarray) -> np.ndarray:
    value = np.asarray(image)
    if value.ndim == 2:
        return cv2.cvtColor(value, cv2.COLOR_GRAY2BGR)
    if value.ndim != 3:
        raise ValueError("preview image must have two or three dimensions")
    if value.shape[2] == 4:
        return cv2.cvtColor(value, cv2.COLOR_BGRA2BGR)
    if value.shape[2] != 3:
        raise ValueError("preview image must have 1, 3 or 4 channels")
    return value


def _fit_long_edge(image: np.ndarray, limit: int) -> np.ndarray:
    height, width = image.shape[:2]
    longest = max(height, width)
    if longest <= limit:
        return image
    scale = limit / longest
    return cv2.resize(
        image,
        (max(1, round(width * scale)), max(1, round(height * scale))),
        interpolation=cv2.INTER_AREA,
    )


def _atomic_jpeg(path: Path, image: np.ndarray, quality: int) -> None:
    success, encoded = cv2.imencode(
        ".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), quality]
    )
    if not success:
        raise RuntimeError("unable to encode preview JPEG")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    try:
        with temporary.open("xb") as stream:
            stream.write(encoded.tobytes())
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _repair_jsonl_tail(path: Path, *, task_id: str, run_id: str) -> None:
    """Make a crash-interrupted JSONL tail safe for the next append.

    A fully encoded event that only missed its newline is preserved by adding
    the delimiter. A genuinely partial JSON object is truncated back to the
    previous newline, preventing the next valid event from being concatenated
    into the damaged line and lost during recovery.
    """

    with path.open("r+b") as stream:
        stream.seek(0, os.SEEK_END)
        size = stream.tell()
        if size == 0:
            return
        stream.seek(-1, os.SEEK_END)
        if stream.read(1) == b"\n":
            return

        last_newline = -1
        cursor = size
        while cursor > 0 and last_newline < 0:
            chunk_start = max(0, cursor - 8192)
            stream.seek(chunk_start)
            chunk = stream.read(cursor - chunk_start)
            relative = chunk.rfind(b"\n")
            if relative >= 0:
                last_newline = chunk_start + relative
                break
            cursor = chunk_start
        tail_start = last_newline + 1
        stream.seek(tail_start)
        tail = stream.read(size - tail_start)
        valid_tail = False
        try:
            event = ProgressEvent.model_validate_json(tail.decode("utf-8"))
            valid_tail = event.task_id == task_id and event.run_id == run_id
        except (UnicodeDecodeError, ValueError):
            pass
        if valid_tail:
            stream.seek(0, os.SEEK_END)
            stream.write(b"\n")
        else:
            stream.truncate(tail_start)
        stream.flush()
        os.fsync(stream.fileno())
