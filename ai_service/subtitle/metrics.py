from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from ai_service.alignment.temporal import text_similarity
from ai_service.schemas import SubtitleItem


TIME_PATTERN = re.compile(
    r"(?P<start>\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(?P<end>\d{2}:\d{2}:\d{2}[,.]\d{3})"
)


@dataclass(slots=True)
class EvaluationResult:
    reference_count: int
    prediction_count: int
    matched_count: int
    coverage: float
    mean_text_similarity: float
    mean_start_error_seconds: float
    mean_end_error_seconds: float

    def as_dict(self) -> dict[str, int | float]:
        return {
            "reference_count": self.reference_count,
            "prediction_count": self.prediction_count,
            "matched_count": self.matched_count,
            "coverage": round(self.coverage, 4),
            "mean_text_similarity": round(self.mean_text_similarity, 4),
            "mean_start_error_seconds": round(self.mean_start_error_seconds, 4),
            "mean_end_error_seconds": round(self.mean_end_error_seconds, 4),
        }


def parse_srt(path: str | Path) -> list[SubtitleItem]:
    content = Path(path).read_text(encoding="utf-8-sig").replace("\r\n", "\n")
    result: list[SubtitleItem] = []
    for index, block in enumerate(re.split(r"\n\s*\n", content.strip()), start=1):
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        time_index = next((i for i, line in enumerate(lines) if "-->" in line), None)
        if time_index is None:
            continue
        match = TIME_PATTERN.search(lines[time_index])
        if not match:
            continue
        text = " ".join(lines[time_index + 1 :]).strip()
        if text:
            result.append(
                SubtitleItem(
                    id=str(index),
                    text=text,
                    start_time=_parse_time(match.group("start")),
                    end_time=_parse_time(match.group("end")),
                    confidence=1,
                    source="reference",
                )
            )
    return result


def evaluate(reference: list[SubtitleItem], prediction: list[SubtitleItem]) -> EvaluationResult:
    if not reference:
        return EvaluationResult(0, len(prediction), 0, 0, 0, 0, 0)
    used: set[int] = set()
    matches: list[tuple[SubtitleItem, SubtitleItem, float]] = []
    for expected in reference:
        candidates: list[tuple[float, int, SubtitleItem, float]] = []
        for index, actual in enumerate(prediction):
            if index in used:
                continue
            overlap = max(
                0.0,
                min(expected.end_time, actual.end_time) - max(expected.start_time, actual.start_time),
            )
            union = max(expected.end_time, actual.end_time) - min(expected.start_time, actual.start_time)
            time_score = overlap / union if union > 0 else 0
            similarity = text_similarity(expected.text, actual.text)
            score = time_score * 0.6 + similarity * 0.4
            if overlap > 0 or similarity > 0.55:
                candidates.append((score, index, actual, similarity))
        if candidates:
            _, index, actual, similarity = max(candidates, key=lambda item: item[0])
            used.add(index)
            matches.append((expected, actual, similarity))

    count = len(matches)
    return EvaluationResult(
        reference_count=len(reference),
        prediction_count=len(prediction),
        matched_count=count,
        coverage=count / len(reference),
        mean_text_similarity=sum(item[2] for item in matches) / count if count else 0,
        mean_start_error_seconds=(
            sum(abs(expected.start_time - actual.start_time) for expected, actual, _ in matches) / count
            if count
            else 0
        ),
        mean_end_error_seconds=(
            sum(abs(expected.end_time - actual.end_time) for expected, actual, _ in matches) / count
            if count
            else 0
        ),
    )


def _parse_time(value: str) -> float:
    hours, minutes, rest = value.replace(",", ".").split(":")
    return int(hours) * 3600 + int(minutes) * 60 + float(rest)

