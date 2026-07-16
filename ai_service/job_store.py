from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path

from ai_service.schemas import JobRecord


class JobStore:
    """Thread-safe job state with JSON snapshots for process restarts."""

    def __init__(self, directory: str | Path) -> None:
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self._records: dict[str, JobRecord] = {}
        self._lock = threading.RLock()
        self._load_existing()

    def _load_existing(self) -> None:
        for path in self.directory.glob("*.json"):
            try:
                record = JobRecord.model_validate_json(path.read_text(encoding="utf-8"))
                if record.status == "processing":
                    record.status = "failed"
                    record.error = "AI 服务重启中断了任务，请重新上传"
                    record.message = "任务已中断"
                self._records[record.task_id] = record
            except (OSError, ValueError, json.JSONDecodeError):
                continue

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

    def _persist(self, record: JobRecord) -> None:
        target = self.directory / f"{record.task_id}.json"
        temporary = target.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(record.model_dump(mode="json"), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temporary.replace(target)

