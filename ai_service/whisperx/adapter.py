from __future__ import annotations

import importlib
from importlib.machinery import PathFinder
import logging
import math
import shutil
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from ai_service.schemas import AudioSubtitle, AudioWord


logger = logging.getLogger(__name__)


class WhisperXUnavailableError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class WhisperXModelConfig:
    model_name: str = "small"
    device: str = "cpu"
    compute_type: str = "int8"
    batch_size: int = 8
    language: str | None = None


_SERVICE_ROOT = Path(__file__).resolve().parent.parent
_LOCAL_WHISPERX_ROOT = Path(__file__).resolve().parent


def _external_search_paths() -> list[str]:
    """Return import roots without the local ``ai_service/whisperx`` shadow."""

    paths: list[str] = []
    for entry in sys.path:
        try:
            resolved = Path(entry or Path.cwd()).resolve()
        except (OSError, RuntimeError):
            paths.append(entry)
            continue
        if resolved == _SERVICE_ROOT:
            continue
        paths.append(entry)
    return paths


def _is_local_whisperx(module: Any) -> bool:
    origin = getattr(module, "__file__", None)
    if not origin:
        return False
    try:
        Path(origin).resolve().relative_to(_LOCAL_WHISPERX_ROOT)
        return True
    except (OSError, RuntimeError, ValueError):
        return False


def whisperx_installed() -> bool:
    """Check the third-party distribution without importing a large model stack."""

    spec = PathFinder.find_spec("whisperx", _external_search_paths())
    if spec is None or spec.origin is None:
        return False
    try:
        Path(spec.origin).resolve().relative_to(_LOCAL_WHISPERX_ROOT)
        return False
    except (OSError, RuntimeError, ValueError):
        return True


def _import_whisperx():
    """Import the third-party package even when the service cwd is ``ai_service``."""

    original_path = list(sys.path)
    cached = sys.modules.get("whisperx")
    removed_local = cached if cached is not None and _is_local_whisperx(cached) else None
    if removed_local is not None:
        sys.modules.pop("whisperx", None)
    try:
        sys.path[:] = _external_search_paths()
        module = importlib.import_module("whisperx")
    except (ImportError, ModuleNotFoundError):
        if removed_local is not None:
            sys.modules["whisperx"] = removed_local
        raise
    finally:
        sys.path[:] = original_path
    if _is_local_whisperx(module):
        raise ModuleNotFoundError("third-party whisperx distribution is not installed")
    return module


def transcribe_audio(
    video_path: str | Path,
    model_config: WhisperXModelConfig | Mapping[str, Any],
) -> list[AudioSubtitle]:
    """Transcribe and align one media file without importing WhisperX at startup.

    The adapter deliberately returns an audio-only model. It never reads OCR
    cues and never calls the legacy OCR/Whisper correction code.
    """

    config = _coerce_config(model_config)
    source = Path(video_path)
    if not source.is_file():
        raise FileNotFoundError(f"media file not found: {source}")

    try:
        whisperx = _import_whisperx()
    except Exception as exc:
        raise WhisperXUnavailableError(
            "WhisperX 未安装；音频字幕轨不可用，但 OCR 视觉字幕仍可继续处理"
        ) from exc

    try:
        # Decode before allocating the WhisperX model on the GPU.  On Windows,
        # ffmpeg can occasionally exit without stderr while OCR is starting in
        # parallel.  Retrying this small, isolated step avoids failing the whole
        # audio track for a transient decoder startup error.
        audio = _load_audio_with_retry(whisperx, source)
        model = whisperx.load_model(
            config.model_name,
            config.device,
            compute_type=config.compute_type,
            language=config.language,
        )
        transcription = model.transcribe(audio, batch_size=config.batch_size)
        transcript_segments = _segments_from(transcription)
        detected_language = _clean_language(
            _mapping_value(transcription, "language") or config.language
        )
        if not detected_language:
            raise RuntimeError("WhisperX 未返回可用于词级对齐的语言")
        align_model, align_metadata = whisperx.load_align_model(
            language_code=detected_language,
            device=config.device,
        )
        aligned = whisperx.align(
            transcript_segments,
            align_model,
            align_metadata,
            audio,
            config.device,
            return_char_alignments=False,
        )
    except WhisperXUnavailableError:
        raise
    except Exception as exc:
        raise RuntimeError(f"WhisperX 转写或词级对齐失败: {exc}") from exc

    aligned_segments = _segments_from(aligned)
    return _normalize_segments(aligned_segments, transcript_segments)


def _load_audio_with_retry(
    whisperx: Any,
    source: Path,
    *,
    retry_delays: tuple[float, ...] = (0.5, 1.5),
) -> Any:
    """Load media audio and retry transient ffmpeg failures on Windows."""

    attempts = len(retry_delays) + 1
    for attempt in range(1, attempts + 1):
        try:
            return whisperx.load_audio(str(source))
        except Exception as exc:
            if attempt >= attempts:
                details = _audio_error_details(exc)
                raise RuntimeError(
                    f"音频解码失败（已重试 {attempts} 次）: {details}"
                ) from exc
            delay = retry_delays[attempt - 1]
            logger.warning(
                "WhisperX audio decode attempt %s/%s failed for %s: %s; "
                "retrying in %.1fs",
                attempt,
                attempts,
                source,
                _audio_error_details(exc),
                delay,
            )
            time.sleep(delay)

    raise AssertionError("unreachable")


def _audio_error_details(exc: Exception) -> str:
    """Preserve ffmpeg diagnostics that WhisperX omits from its message."""

    parts: list[str] = []
    message = str(exc).strip()
    if message:
        parts.append(message)

    current: BaseException | None = exc
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, subprocess.CalledProcessError):
            parts.append(f"ffmpeg exit code={current.returncode}")
            stderr = current.stderr
            if isinstance(stderr, bytes):
                stderr = stderr.decode(errors="replace")
            stderr_text = str(stderr or "").strip()
            if stderr_text:
                parts.append(stderr_text)
            break
        current = current.__cause__ or current.__context__

    ffmpeg_path = shutil.which("ffmpeg")
    parts.append(f"ffmpeg={ffmpeg_path or 'PATH 中未找到'}")
    return "; ".join(parts)


def _coerce_config(
    value: WhisperXModelConfig | Mapping[str, Any],
) -> WhisperXModelConfig:
    if isinstance(value, WhisperXModelConfig):
        config = value
    elif isinstance(value, Mapping):
        raw_batch_size = value.get("batch_size")
        config = WhisperXModelConfig(
            model_name=str(value.get("model_name") or value.get("model") or "small"),
            device=str(value.get("device") or "cpu"),
            compute_type=str(value.get("compute_type") or "int8"),
            batch_size=int(8 if raw_batch_size is None else raw_batch_size),
            language=_clean_language(value.get("language")),
        )
    else:
        raise TypeError("model_config must be WhisperXModelConfig or a mapping")
    if not config.model_name.strip():
        raise ValueError("WhisperX model_name must not be empty")
    if config.batch_size < 1:
        raise ValueError("WhisperX batch_size must be at least 1")
    return config


def _segments_from(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, Mapping):
        segments = value.get("segments", [])
    else:
        segments = getattr(value, "segments", [])
    return [dict(segment) for segment in segments or [] if isinstance(segment, Mapping)]


def _normalize_segments(
    aligned_segments: list[dict[str, Any]],
    transcript_segments: list[dict[str, Any]],
) -> list[AudioSubtitle]:
    output: list[AudioSubtitle] = []
    source_segments = aligned_segments or transcript_segments
    for index, segment in enumerate(source_segments):
        fallback = transcript_segments[index] if index < len(transcript_segments) else {}
        words = _normalize_words(segment.get("words") or [])
        text = str(segment.get("text") or fallback.get("text") or "").strip()
        if not text:
            text = "".join(word.word for word in words).strip()
        if not text:
            continue

        timed_words = [
            word for word in words if word.start is not None and word.end is not None
        ]
        start = _finite_nonnegative(segment.get("start"))
        if start is None:
            start = _finite_nonnegative(fallback.get("start"))
        if start is None and timed_words:
            start = timed_words[0].start
        end = _finite_nonnegative(segment.get("end"))
        if end is None:
            end = _finite_nonnegative(fallback.get("end"))
        if end is None and timed_words:
            end = timed_words[-1].end
        if start is None or end is None or end <= start:
            # Sentence timing is required for an editable subtitle cue. Missing
            # word timings remain valid, but a wholly untimed sentence cannot
            # safely be offered to the final SRT track.
            continue

        word_confidences = [
            word.confidence for word in words if word.confidence is not None
        ]
        segment_confidence = _normalized_confidence(
            segment.get("score", segment.get("confidence", segment.get("probability")))
        )
        if word_confidences:
            confidence = sum(word_confidences) / len(word_confidences)
        elif segment_confidence is not None:
            confidence = segment_confidence
        else:
            confidence = 0.0

        output.append(
            AudioSubtitle(
                id=str(uuid.uuid4()),
                text=text,
                start=round(start, 3),
                end=round(end, 3),
                words=words,
                confidence=round(confidence, 4),
            )
        )
    output.sort(key=lambda item: (item.start, item.end))
    return output


def _normalize_words(values: Any) -> list[AudioWord]:
    output: list[AudioWord] = []
    for value in values if isinstance(values, list) else []:
        if not isinstance(value, Mapping):
            continue
        word = str(value.get("word") or value.get("text") or "")
        if not word.strip():
            continue
        start = _finite_nonnegative(value.get("start"))
        end = _finite_nonnegative(value.get("end"))
        if start is not None and end is not None and end < start:
            start = None
            end = None
        confidence = _normalized_confidence(
            value.get("score", value.get("confidence", value.get("probability")))
        )
        output.append(
            AudioWord(
                word=word,
                start=round(start, 3) if start is not None else None,
                end=round(end, 3) if end is not None else None,
                confidence=round(confidence, 4) if confidence is not None else None,
            )
        )
    return output


def _finite_nonnegative(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(parsed) or parsed < 0:
        return None
    return parsed


def _normalized_confidence(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(parsed):
        return None
    return max(0.0, min(1.0, parsed))


def _mapping_value(value: Any, key: str) -> Any:
    if isinstance(value, Mapping):
        return value.get(key)
    return getattr(value, key, None)


def _clean_language(value: Any) -> str | None:
    if value is None:
        return None
    cleaned = str(value).strip()
    return cleaned or None
