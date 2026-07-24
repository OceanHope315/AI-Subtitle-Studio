"""
Runner for WhisperX worker subprocess.

This module runs WhisperX transcription in an isolated subprocess to avoid
CUDA/cuDNN DLL conflicts with PaddleOCR in the main FastAPI process.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from ai_service.schemas import AudioSubtitle, AudioWord


logger = logging.getLogger(__name__)


class WhisperXWorkerError(RuntimeError):
    """Error during WhisperX worker execution."""
    pass


def run_whisperx_worker(
    video_path: str | Path,
    model_config: dict[str, Any],
    *,
    timeout_seconds: float = 3600,
) -> list[AudioSubtitle]:
    """
    Run WhisperX transcription in an isolated subprocess.

    Args:
        video_path: Path to the audio/video file (supports spaces and Chinese characters)
        model_config: Configuration dict with model, device, compute_type, batch_size, language
        timeout_seconds: Worker process timeout in seconds

    Returns:
        List of AudioSubtitle objects

    Raises:
        WhisperXWorkerError: If worker fails or times out
    """
    video_path = Path(video_path)
    if not video_path.is_file():
        raise WhisperXWorkerError(f"Video file not found: {video_path}")

    # Create temporary directory for request/output files
    request_dir = None
    try:
        request_dir = tempfile.mkdtemp(prefix="asts-whisperx-")
        request_file = Path(request_dir) / "request.json"
        output_file = Path(request_dir) / "output.json"

        # Write request.json
        request_data = {
            "video_path": str(video_path),
            "model_config": model_config,
        }
        with open(request_file, "w", encoding="utf-8") as f:
            json.dump(request_data, f, ensure_ascii=False)

        logger.info(
            f"Starting WhisperX worker for {video_path} (timeout={timeout_seconds}s)"
        )

        # Get the project root for cwd
        service_root = Path(__file__).resolve().parent.parent
        project_root = service_root.parent

        # Build subprocess command
        cmd = [
            sys.executable,
            "-m",
            "ai_service.whisperx.worker",
            "--request",
            str(request_file),
            "--output",
            str(output_file),
        ]

        logger.debug(f"Worker command: {cmd}")

        # Run worker subprocess
        try:
            result = subprocess.run(
                cmd,
                cwd=str(project_root),
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            logger.exception("WhisperX worker timed out after %s seconds", timeout_seconds)
            raise WhisperXWorkerError(
                f"WhisperX worker timed out after {timeout_seconds} seconds"
            ) from exc

        # Log worker output
        if result.stdout:
            logger.debug(f"Worker stdout:\n{result.stdout}")
        if result.stderr:
            logger.debug(f"Worker stderr:\n{result.stderr}")

        # Check worker exit code
        if result.returncode != 0:
            logger.warning(f"Worker exited with code {result.returncode}")

        # Try to read output.json
        if not output_file.is_file():
            stderr_msg = result.stderr or "(no stderr)"
            raise WhisperXWorkerError(
                f"Worker did not generate output.json. Exit code: {result.returncode}, "
                f"stderr: {stderr_msg[:200]}"
            )

        try:
            with open(output_file, "r", encoding="utf-8") as f:
                output_data = json.load(f)
        except json.JSONDecodeError as exc:
            raise WhisperXWorkerError(
                f"output.json is not valid JSON: {exc}"
            ) from exc

        # Parse and validate output
        return _parse_worker_output(output_data)

    finally:
        # Clean up temporary files
        if request_dir:
            try:
                shutil.rmtree(request_dir)
            except Exception:
                logger.exception("Failed to clean up temporary directory")


def _parse_worker_output(output_data: dict[str, Any]) -> list[AudioSubtitle]:
    """
    Parse and validate worker output.

    Args:
        output_data: Dictionary from worker's output.json

    Returns:
        List of AudioSubtitle objects

    Raises:
        WhisperXWorkerError: If output is invalid or contains error
    """
    if not isinstance(output_data, dict):
        raise WhisperXWorkerError("output.json root must be a dict")

    # Check for error
    if not output_data.get("ok"):
        error_msg = output_data.get("error", "Unknown error")
        error_type = output_data.get("error_type", "Exception")
        raise WhisperXWorkerError(f"{error_type}: {error_msg}")

    # Extract subtitles
    subtitles_data = output_data.get("subtitles")
    if not isinstance(subtitles_data, list):
        raise WhisperXWorkerError("subtitles must be a list")

    # Parse and validate each subtitle
    subtitles: list[AudioSubtitle] = []
    for idx, item in enumerate(subtitles_data):
        try:
            # Parse words
            words_data = item.get("words", [])
            words = []
            if isinstance(words_data, list):
                for word_item in words_data:
                    try:
                        word = AudioWord(
                            word=str(word_item.get("word", "")),
                            start=word_item.get("start"),
                            end=word_item.get("end"),
                            confidence=word_item.get("confidence"),
                        )
                        words.append(word)
                    except Exception as exc:
                        logger.warning(f"Failed to parse word {idx}: {exc}")

            # Create AudioSubtitle
            subtitle = AudioSubtitle(
                id=f"audio-{idx}",
                text=str(item.get("text", "")),
                start=float(item.get("start", 0)),
                end=float(item.get("end", 0)),
                words=words,
                confidence=float(item.get("confidence", 0)),
            )
            subtitles.append(subtitle)

        except Exception as exc:
            raise WhisperXWorkerError(f"Failed to parse subtitle {idx}: {exc}") from exc

    logger.info(f"Successfully parsed {len(subtitles)} subtitles from worker output")
    return subtitles
