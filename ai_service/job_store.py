from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from ai_service.schemas import JobRecord, ProgressEvent


class JobStore:
    """Thread-safe job state with JSON snapshots for process restarts."""

    def __init__(self, directory: str | Path) -> None:
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self._records: dict[str, JobRecord] = {}
        self._lock = threading.RLock()
        self._last_snapshot_persist: dict[str, float] = {}
        self._interrupted_records: list[JobRecord] = []
        self._load_existing()

    def _load_existing(self) -> None:
        for path in self.directory.glob("*.json"):
            try:
                record = JobRecord.model_validate_json(path.read_text(encoding="utf-8"))
                self._records[record.task_id] = record
            except (OSError, ValueError, json.JSONDecodeError):
                continue

    def prepare_restart_recovery(self) -> None:
        """Durably classify interrupted runs during application startup.

        Loading a JobStore remains read-only. This explicit startup step keeps
        test collection and utility imports from mutating live job data.
        """

        with self._lock:
            self._interrupted_records.clear()
            for task_id, current in list(self._records.items()):
                record = current
                # Legacy jobs predate run-scoped progress. Leave them exactly
                # as stored because there is no safe replay identity.
                if (
                    record.status in {"queued", "processing"}
                    and record.run_id is not None
                    and not record.recovery_pending
                ):
                    if record.completion_pending:
                        record = record.model_copy(
                            update={
                                "recovery_pending": True,
                                "updated_at": datetime.now(timezone.utc),
                            },
                            deep=True,
                        )
                    else:
                        record = record.model_copy(
                            update={
                                "status": "failed",
                                "error": "AI 服务重启中断了任务，请重新上传",
                                "message": "任务已中断",
                                "recovery_pending": True,
                                "updated_at": datetime.now(timezone.utc),
                            },
                            deep=True,
                        )
                    self._records[task_id] = record
                    self._persist(record)
                if record.recovery_pending:
                    self._interrupted_records.append(record.model_copy(deep=True))

    def take_interrupted_records(self) -> list[JobRecord]:
        """Return crash-interrupted jobs once for startup event recovery."""

        with self._lock:
            records = [record.model_copy(deep=True) for record in self._interrupted_records]
            self._interrupted_records.clear()
            return records

    def create(self, record: JobRecord) -> JobRecord:
        with self._lock:
            if record.task_id in self._records:
                raise ValueError("task_id already exists")
            self._records[record.task_id] = record
            self._persist(record)
            return record.model_copy(deep=True)

    def get(self, task_id: str) -> JobRecord | None:
        with self._lock:
            record = self._records.get(task_id)
            return record.model_copy(deep=True) if record else None

    def list_records(self) -> list[JobRecord]:
        with self._lock:
            return [
                record.model_copy(deep=True)
                for record in self._records.values()
            ]

    def update(self, task_id: str, **changes) -> JobRecord:
        with self._lock:
            current = self._records.get(task_id)
            if current is None:
                raise KeyError(task_id)
            changes["updated_at"] = datetime.now(timezone.utc)
            updated = current.model_copy(update=changes, deep=True)
            self._records[task_id] = updated
            self._persist(updated)
            return updated.model_copy(deep=True)

    def update_progress_snapshot(
        self,
        event: ProgressEvent,
        *,
        persist_interval: float = 1.0,
    ) -> JobRecord:
        """Update the hot snapshot without rewriting the job file per frame."""

        if persist_interval < 0:
            raise ValueError("persist_interval must not be negative")
        with self._lock:
            current = self._records.get(event.task_id)
            if current is None:
                raise KeyError(event.task_id)
            updated = current.model_copy(
                update={
                    "progress": event.progress,
                    "message": event.message,
                    "run_id": event.run_id,
                    "latest_seq": event.seq,
                    "latest_event": event,
                    "latest_frame_event": (
                        event
                        if event.type == "frame.analyzed"
                        else current.latest_frame_event
                        if current.run_id == event.run_id
                        else None
                    ),
                    "latest_preview_event": (
                        event
                        if event.type == "frame.analyzed"
                        and bool(event.payload.get("preview_id"))
                        else current.latest_preview_event
                        if current.run_id == event.run_id
                        else None
                    ),
                    "updated_at": datetime.now(timezone.utc),
                },
                deep=True,
            )
            self._records[event.task_id] = updated
            now = time.monotonic()
            last = self._last_snapshot_persist.get(event.task_id)
            terminal = event.type in {"job.completed", "job.failed"}
            if terminal or last is None or now - last >= persist_interval:
                self._persist(updated)
                self._last_snapshot_persist[event.task_id] = now
            return updated.model_copy(deep=True)

    def update_legacy_progress(
        self,
        task_id: str,
        progress: int,
        message: str,
        *,
        persist_interval: float = 1.0,
    ) -> JobRecord:
        """Keep the original percent/message contract without write churn."""

        if persist_interval < 0:
            raise ValueError("persist_interval must not be negative")
        with self._lock:
            current = self._records.get(task_id)
            if current is None:
                raise KeyError(task_id)
            updated = current.model_copy(
                update={
                    "progress": max(0, min(100, int(progress))),
                    "message": message,
                    "updated_at": datetime.now(timezone.utc),
                },
                deep=True,
            )
            self._records[task_id] = updated
            now = time.monotonic()
            last = self._last_snapshot_persist.get(task_id)
            if last is None or now - last >= persist_interval:
                self._persist(updated)
                self._last_snapshot_persist[task_id] = now
            return updated.model_copy(deep=True)

    def _persist(self, record: JobRecord) -> None:
        target = self.directory / f"{record.task_id}.json"
        temporary = target.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(record.model_dump(mode="json"), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temporary.replace(target)
