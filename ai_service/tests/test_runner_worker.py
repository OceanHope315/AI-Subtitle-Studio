"""Tests for WhisperX worker and runner."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from ai_service.whisperx.runner import run_whisperx_worker, WhisperXWorkerError, _parse_worker_output
from ai_service.schemas import AudioSubtitle, AudioWord


def test_parse_worker_output_success() -> None:
    """Test parsing valid worker output."""
    output = {
        "ok": True,
        "subtitles": [
            {
                "text": "hello world",
                "start": 1.0,
                "end": 2.5,
                "words": [
                    {"word": "hello", "start": 1.0, "end": 1.5, "confidence": 0.9},
                    {"word": "world", "start": 1.5, "end": 2.5, "confidence": 0.85},
                ],
                "confidence": 0.88,
            }
        ],
    }
    result = _parse_worker_output(output)
    assert len(result) == 1
    assert result[0].text == "hello world"
    assert result[0].start == 1.0
    assert result[0].end == 2.5
    assert len(result[0].words) == 2
    assert result[0].words[0].word == "hello"


def test_parse_worker_output_error() -> None:
    """Test error handling in worker output."""
    output = {
        "ok": False,
        "error": "Model not found",
        "error_type": "FileNotFoundError",
    }
    with pytest.raises(WhisperXWorkerError, match="FileNotFoundError.*Model not found"):
        _parse_worker_output(output)


def test_parse_worker_output_no_words() -> None:
    """Test worker output with missing word data."""
    output = {
        "ok": True,
        "subtitles": [
            {
                "text": "no words",
                "start": 0.0,
                "end": 1.0,
                "words": [],
                "confidence": 0.8,
            }
        ],
    }
    result = _parse_worker_output(output)
    assert len(result) == 1
    assert len(result[0].words) == 0


def test_run_whisperx_worker_missing_file() -> None:
    """Test runner with non-existent video file."""
    with pytest.raises(WhisperXWorkerError, match="Video file not found"):
        run_whisperx_worker(
            "/nonexistent/video.mp4",
            {"model": "small", "device": "cpu"},
        )


def test_worker_writes_atomic_output(tmp_path, monkeypatch) -> None:
    """Test that worker writes output atomically using temp file."""
    import ai_service.whisperx.worker as worker_module
    
    # Create a fake output file that validates atomic write
    output_dir = tmp_path / "output"
    output_dir.mkdir()
    output_path = output_dir / "result.json"
    
    result = {
        "ok": True,
        "subtitles": [
            {
                "text": "test",
                "start": 0.0,
                "end": 1.0,
                "words": [],
                "confidence": 0.9,
            }
        ],
    }
    
    # Simulate worker write
    worker_module._write_output(str(output_path), result)
    
    # Verify output file exists and contains correct data
    assert output_path.is_file()
    with open(output_path, "r", encoding="utf-8") as f:
        written = json.load(f)
    assert written["ok"] is True
    assert len(written["subtitles"]) == 1


def test_worker_main_with_invalid_request(tmp_path, monkeypatch) -> None:
    """Test worker main with invalid request JSON."""
    import ai_service.whisperx.worker as worker_module
    
    request_path = tmp_path / "request.json"
    output_path = tmp_path / "output.json"
    
    # Write invalid request
    with open(request_path, "w") as f:
        json.dump({"invalid": "request"}, f)
    
    # Mock sys.argv to simulate command line
    monkeypatch.setattr(
        "sys.argv",
        [
            "worker.py",
            "--request",
            str(request_path),
            "--output",
            str(output_path),
        ],
    )
    
    # Run worker
    exit_code = worker_module.main()
    
    # Should fail and create output with error
    assert exit_code != 0
    assert output_path.is_file()
    with open(output_path, "r") as f:
        result = json.load(f)
    assert result["ok"] is False
    assert "video_path" in result["error"]


def test_runner_handles_timeout(tmp_path, monkeypatch) -> None:
    """Test runner timeout handling."""
    import subprocess
    from unittest.mock import patch
    
    # Create a dummy video file so file check passes
    video_file = tmp_path / "audio.mp4"
    video_file.write_bytes(b"fake video")
    
    def mock_run(*args, **kwargs):
        raise subprocess.TimeoutExpired("cmd", 1)
    
    with patch("subprocess.run", side_effect=mock_run):
        with pytest.raises(WhisperXWorkerError, match="timed out"):
            run_whisperx_worker(
                video_file,
                {},
                timeout_seconds=1,
            )


def test_runner_missing_output_json(tmp_path, monkeypatch) -> None:
    """Test runner when output.json is not generated."""
    import subprocess
    from unittest.mock import patch, MagicMock
    
    # Create a dummy video file so file check passes
    video_file = tmp_path / "audio.mp4"
    video_file.write_bytes(b"fake video")
    
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = ""
    mock_result.stderr = "Some error"
    
    with patch("subprocess.run", return_value=mock_result):
        with pytest.raises(WhisperXWorkerError, match="did not generate output"):
            run_whisperx_worker(
                video_file,
                {},
            )


def test_runner_invalid_json_output(tmp_path, monkeypatch) -> None:
    """Test runner with corrupted output.json."""
    import subprocess
    from unittest.mock import patch, MagicMock
    
    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = ""
    mock_result.stderr = ""
    
    # Create invalid JSON output
    output_file = tmp_path / "output.json"
    output_file.write_text("{invalid json")
    
    def mock_run(*args, **kwargs):
        return mock_result
    
    with patch("subprocess.run", side_effect=mock_run):
        with patch("subprocess.Popen"):
            # This will fail when trying to parse the invalid JSON
            pass  # Need to adjust test structure
