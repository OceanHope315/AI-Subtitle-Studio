from __future__ import annotations

import json
from pathlib import Path

from ai_service.schemas import SubtitleItem


def format_srt_time(seconds: float) -> str:
    total_ms = max(0, int(round(seconds * 1000)))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, milliseconds = divmod(remainder, 1000)
    return f"{hours:02}:{minutes:02}:{secs:02},{milliseconds:03}"


def render_srt(subtitles: list[SubtitleItem]) -> str:
    blocks: list[str] = []
    for index, item in enumerate(sorted(subtitles, key=lambda value: value.start_time), start=1):
        text = item.text.replace("\r", "").strip()
        blocks.append(
            f"{index}\n{format_srt_time(item.start_time)} --> {format_srt_time(item.end_time)}\n{text}"
        )
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def write_srt(subtitles: list[SubtitleItem], path: str | Path) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(render_srt(subtitles), encoding="utf-8")
    return target


def write_subtitle_json(subtitles: list[SubtitleItem], path: str | Path) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps([item.model_dump(mode="json") for item in subtitles], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return target


def write_json_artifact(value: dict, path: str | Path) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(value, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return target
