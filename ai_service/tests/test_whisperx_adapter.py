from __future__ import annotations

import types
from pathlib import Path
import sys

import pytest

from ai_service.whisperx import adapter
from ai_service.whisperx.adapter import (
    WhisperXModelConfig,
    WhisperXUnavailableError,
    transcribe_audio,
)


class FakeWhisperModel:
    def __init__(self, calls: list[tuple]) -> None:
        self.calls = calls

    def transcribe(self, audio, *, batch_size: int):
        self.calls.append(("transcribe", audio, batch_size))
        return {
            "language": "en",
            "segments": [
                {"text": "hello world", "start": 1.0, "end": 2.1},
                {"text": "second sentence", "start": 3.0, "end": 4.0},
            ],
        }


def test_transcribe_audio_runs_whisperx_alignment_and_preserves_missing_word_data(
    tmp_path, monkeypatch
) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"media")
    calls: list[tuple] = []

    def load_model(name, device, *, compute_type, language):
        calls.append(("load_model", name, device, compute_type, language))
        return FakeWhisperModel(calls)

    def load_audio(path):
        calls.append(("load_audio", path))
        return "decoded-audio"

    def load_align_model(*, language_code, device):
        calls.append(("load_align_model", language_code, device))
        return "align-model", {"dictionary": True}

    def align(segments, model, metadata, audio, device, *, return_char_alignments):
        calls.append(
            (
                "align",
                segments,
                model,
                metadata,
                audio,
                device,
                return_char_alignments,
            )
        )
        return {
            "segments": [
                {
                    "text": "hello world",
                    # Segment timing deliberately omitted: transcript timing is
                    # the sentence-level fallback.
                    "words": [
                        {"word": "hello", "start": 1.0, "end": 1.4, "score": 1.5},
                        {"word": " world", "score": -0.2},
                        {"word": "!", "start": 2.0, "end": 1.0, "score": "bad"},
                    ],
                },
                {
                    "text": "second sentence",
                    "start": 3.0,
                    "end": 4.0,
                    "confidence": 0.7,
                    "words": [{"word": "second"}, {"word": " sentence"}],
                },
            ]
        }

    fake_module = types.SimpleNamespace(
        load_model=load_model,
        load_audio=load_audio,
        load_align_model=load_align_model,
        align=align,
    )
    monkeypatch.setattr(adapter.importlib, "import_module", lambda name: fake_module)

    result = transcribe_audio(
        source,
        WhisperXModelConfig(
            model_name="tiny",
            device="cpu",
            compute_type="int8",
            batch_size=4,
        ),
    )

    assert [item.text for item in result] == ["hello world", "second sentence"]
    assert (result[0].start, result[0].end) == (1.0, 2.1)
    assert result[0].confidence == 0.5
    assert result[0].words[0].confidence == 1.0
    assert result[0].words[1].start is None
    assert result[0].words[1].confidence == 0.0
    assert result[0].words[2].start is None
    assert result[0].words[2].end is None
    assert result[1].confidence == 0.7
    assert calls[0] == ("load_audio", str(source))
    assert calls[1] == ("load_model", "tiny", "cpu", "int8", None)
    assert ("load_align_model", "en", "cpu") in calls
    assert calls[-1][-1] is False


def test_audio_decode_retries_before_loading_model(tmp_path, monkeypatch) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"media")
    attempts = 0

    def load_audio(_path):
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise RuntimeError("Failed to load audio: ")
        return "decoded-audio"

    calls: list[tuple] = []
    fake_module = types.SimpleNamespace(
        load_audio=load_audio,
        load_model=lambda *args, **kwargs: FakeWhisperModel(calls),
        load_align_model=lambda **kwargs: ("align-model", {}),
        align=lambda segments, *args, **kwargs: {"segments": segments},
    )
    monkeypatch.setattr(adapter.importlib, "import_module", lambda name: fake_module)
    monkeypatch.setattr(adapter.time, "sleep", lambda _delay: None)

    result = transcribe_audio(source, {"model": "tiny", "batch_size": 1})

    assert attempts == 3
    assert len(result) == 2


def test_audio_decode_error_keeps_ffmpeg_exit_code(tmp_path, monkeypatch) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"media")

    def load_audio(_path):
        process_error = adapter.subprocess.CalledProcessError(
            3221225781,
            ["ffmpeg"],
            stderr=b"",
        )
        raise RuntimeError("Failed to load audio: ") from process_error

    fake_module = types.SimpleNamespace(load_audio=load_audio)
    monkeypatch.setattr(adapter.importlib, "import_module", lambda name: fake_module)
    monkeypatch.setattr(adapter.time, "sleep", lambda _delay: None)
    monkeypatch.setattr(adapter.shutil, "which", lambda _name: r"C:\ffmpeg\ffmpeg.exe")

    with pytest.raises(RuntimeError, match="3221225781") as error:
        transcribe_audio(source, {"model": "tiny"})

    assert "已重试 3 次" in str(error.value)
    assert r"C:\ffmpeg\ffmpeg.exe" in str(error.value)


def test_transcribe_audio_is_lazy_when_whisperx_is_not_installed(
    tmp_path, monkeypatch
) -> None:
    source = tmp_path / "source.wav"
    source.write_bytes(b"audio")

    def unavailable(_name):
        raise ModuleNotFoundError("whisperx")

    monkeypatch.setattr(adapter.importlib, "import_module", unavailable)
    with pytest.raises(WhisperXUnavailableError, match="OCR 视觉字幕仍可继续处理"):
        transcribe_audio(source, {"model": "small"})


def test_transcribe_audio_rejects_invalid_config_before_import(tmp_path) -> None:
    source = tmp_path / "source.wav"
    source.write_bytes(b"audio")
    with pytest.raises(ValueError, match="batch_size"):
        transcribe_audio(source, {"batch_size": 0})


def test_external_loader_ignores_local_whisperx_package(tmp_path, monkeypatch) -> None:
    external_package = tmp_path / "whisperx"
    external_package.mkdir()
    (external_package / "__init__.py").write_text(
        "external_marker = 'third-party'\n",
        encoding="utf-8",
    )
    service_root = Path(adapter.__file__).resolve().parent.parent
    monkeypatch.setattr(sys, "path", [str(service_root), str(tmp_path)])
    monkeypatch.delitem(sys.modules, "whisperx", raising=False)

    loaded = adapter._import_whisperx()

    assert loaded.external_marker == "third-party"
    assert Path(loaded.__file__).resolve().parent == external_package.resolve()
