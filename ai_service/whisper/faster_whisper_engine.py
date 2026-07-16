from __future__ import annotations

import importlib.util
import math
import re
import uuid

from ai_service.schemas import SubtitleItem


class WhisperUnavailableError(RuntimeError):
    pass


class FasterWhisperEngine:
    name = "faster-whisper"

    def __init__(self, model_name: str, device: str = "cpu", compute_type: str = "int8") -> None:
        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type
        self._model = None

    @staticmethod
    def installed() -> bool:
        return bool(importlib.util.find_spec("faster_whisper"))

    def _load(self):
        if self._model is not None:
            return self._model
        if not self.installed():
            raise WhisperUnavailableError(
                "faster-whisper 未安装；OCR 仍可工作，或执行 pip install -r requirements.txt"
            )
        try:
            from faster_whisper import WhisperModel

            self._model = WhisperModel(
                self.model_name,
                device=self.device,
                compute_type=self.compute_type,
            )
        except Exception as exc:
            raise WhisperUnavailableError(f"Whisper 模型加载失败: {exc}") from exc
        return self._model

    def transcribe(self, video_path: str, language: str | None = None) -> list[SubtitleItem]:
        model = self._load()
        try:
            segments, _ = model.transcribe(
                video_path,
                language=language or None,
                beam_size=5,
                vad_filter=True,
                word_timestamps=True,
                condition_on_previous_text=True,
            )
            raw = list(segments)
        except Exception as exc:
            raise RuntimeError(f"Whisper 转写失败: {exc}") from exc

        output: list[SubtitleItem] = []
        for segment in raw:
            avg_logprob = float(getattr(segment, "avg_logprob", -0.7) or -0.7)
            no_speech_prob = float(getattr(segment, "no_speech_prob", 0) or 0)
            base_confidence = max(
                0.05,
                min(1.0, math.exp(min(0.0, avg_logprob)) * (1 - no_speech_prob)),
            )
            for text, start, end, word_confidence in _split_segment(segment):
                confidence = word_confidence if word_confidence is not None else base_confidence
                output.append(
                    SubtitleItem(
                        id=str(uuid.uuid4()),
                        text=text,
                        start_time=round(start, 3),
                        end_time=round(end, 3),
                        confidence=round(confidence, 4),
                        position=None,
                        source="whisper",
                    )
                )
        return output


def _split_segment(segment) -> list[tuple[str, float, float, float | None]]:
    """Turn Whisper's long decoder segments into editor-friendly subtitle cues."""
    words = list(getattr(segment, "words", None) or [])
    if not words:
        text = str(segment.text).strip()
        start, end = max(0.0, float(segment.start)), float(segment.end)
        return [(text, start, end, None)] if text and end > start else []

    chunks: list[tuple[str, float, float, float | None]] = []
    active: list = []

    def flush() -> None:
        nonlocal active
        if not active:
            return
        text = "".join(str(word.word) for word in active).strip()
        start = max(0.0, float(active[0].start))
        end = float(active[-1].end)
        probabilities = [
            float(word.probability)
            for word in active
            if getattr(word, "probability", None) is not None
        ]
        confidence = sum(probabilities) / len(probabilities) if probabilities else None
        if text and end > start:
            chunks.append((text, start, end, confidence))
        active = []

    for word in words:
        if active:
            pause = float(word.start) - float(active[-1].end)
            active_duration = float(active[-1].end) - float(active[0].start)
            if pause >= 0.32 and active_duration >= 1.1:
                flush()
        active.append(word)
        text = str(word.word).strip()
        duration = float(word.end) - float(active[0].start)
        terminal = bool(re.search(r"[.!?][\"']?$", text))
        soft_boundary = bool(re.search(r"[,;:][\"']?$", text))
        if (terminal and duration >= 0.75) or (soft_boundary and duration >= 1.4) or duration >= 3.1:
            flush()
    flush()
    return _merge_tiny_chunks(chunks)


def _merge_tiny_chunks(
    chunks: list[tuple[str, float, float, float | None]],
) -> list[tuple[str, float, float, float | None]]:
    merged: list[tuple[str, float, float, float | None]] = []
    for text, start, end, confidence in chunks:
        duration = end - start
        if merged and (duration < 0.75 or (len(text.split()) < 3 and duration < 1.0)):
            previous_text, previous_start, _, previous_confidence = merged[-1]
            values = [value for value in (previous_confidence, confidence) if value is not None]
            merged[-1] = (
                f"{previous_text.rstrip()} {text.lstrip()}",
                previous_start,
                end,
                sum(values) / len(values) if values else None,
            )
        else:
            merged.append((text, start, end, confidence))
    return merged
