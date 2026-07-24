"""
Independent WhisperX worker subprocess to isolate CUDA/cuDNN from main FastAPI process.

Usage:
    python -m ai_service.whisperx.worker --request request.json --output output.json

This module is designed to run as a standalone subprocess to avoid GPU memory/DLL
conflicts when PaddleOCR and WhisperX are used in the same FastAPI process.
"""

from __future__ import annotations

import argparse
import gc
import json
import logging
import sys
import tempfile
import traceback
from pathlib import Path
from typing import Any

# Setup stderr logging before any heavy imports
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    stream=sys.stderr,
    force=True,
)
logger = logging.getLogger("ai-subtitle-studio-worker")


def _load_request(request_path: str) -> dict[str, Any]:
    """Load and validate the request JSON file."""
    try:
        with open(request_path, "r", encoding="utf-8") as f:
            request = json.load(f)
        return request
    except Exception as exc:
        raise ValueError(f"Failed to load request.json: {exc}") from exc


def _validate_request(request: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """Extract and validate required request fields."""
    if not isinstance(request, dict):
        raise ValueError("request must be a dict")
    
    video_path = request.get("video_path")
    if not video_path:
        raise ValueError("video_path is required")
    
    model_config = request.get("model_config", {})
    if not isinstance(model_config, dict):
        raise ValueError("model_config must be a dict")
    
    return str(video_path), model_config


def _write_output(
    output_path: str,
    result: dict[str, Any],
) -> None:
    """Write output JSON using atomic write (tempfile + replace) pattern."""
    try:
        output_dir = Path(output_path).parent
        output_dir.mkdir(parents=True, exist_ok=True)
        
        # Use a temporary file in the same directory to ensure atomic write
        with tempfile.NamedTemporaryFile(
            mode="w",
            dir=output_dir,
            prefix=".tmp-",
            suffix=".json",
            delete=False,
            encoding="utf-8",
        ) as tmp:
            json.dump(result, tmp, ensure_ascii=False)
            tmp_path = tmp.name
        
        # Atomic replace
        Path(tmp_path).replace(output_path)
    except Exception as exc:
        logger.exception("Failed to write output.json")
        raise


def _cleanup_cuda() -> None:
    """Best-effort GPU memory cleanup."""
    try:
        import torch

        torch.cuda.empty_cache()
        logger.info("CUDA cache cleared")
    except Exception:
        pass

    try:
        gc.collect()
        logger.info("Garbage collection completed")
    except Exception:
        pass


def main() -> int:
    """Main worker entry point. Returns exit code (0 for success, non-0 for failure)."""
    parser = argparse.ArgumentParser(
        description="WhisperX worker subprocess"
    )
    parser.add_argument(
        "--request",
        required=True,
        help="Path to request.json",
    )
    parser.add_argument(
        "--output",
        required=True,
        help="Path to output.json",
    )
    args = parser.parse_args()

    output_path = args.output
    result: dict[str, Any] = {
        "ok": False,
        "error": "Unknown error",
        "error_type": "Exception",
    }

    try:
        # Load and validate request
        logger.info(f"Loading request from {args.request}")
        request = _load_request(args.request)
        video_path, model_config = _validate_request(request)
        
        # Check if video file exists
        if not Path(video_path).is_file():
            raise FileNotFoundError(f"Video file not found: {video_path}")
        
        logger.info(f"Starting WhisperX transcription for {video_path}")
        
        # Import transcribe_audio only in the worker subprocess
        # This ensures torch/pyannote/torchaudio are loaded only here
        from ai_service.whisperx.adapter import (
            WhisperXModelConfig,
            transcribe_audio,
        )
        
        # Coerce model_config
        config = WhisperXModelConfig(
            model_name=str(model_config.get("model", "small")),
            device=str(model_config.get("device", "cpu")),
            compute_type=str(model_config.get("compute_type", "int8")),
            batch_size=int(model_config.get("batch_size", 8)),
            language=model_config.get("language") or None,
        )
        
        logger.info(f"Using config: {config}")
        
        # Call transcribe_audio
        subtitles = transcribe_audio(video_path, config)
        
        logger.info(f"Transcription successful, generated {len(subtitles)} subtitles")
        
        # Build success result
        result = {
            "ok": True,
            "subtitles": [
                {
                    "text": sub.text,
                    "start": sub.start,
                    "end": sub.end,
                    "words": [
                        {
                            "word": word.word,
                            "start": word.start,
                            "end": word.end,
                            "confidence": word.confidence,
                        }
                        for word in sub.words
                    ],
                    "confidence": sub.confidence,
                }
                for sub in subtitles
            ],
        }

    except FileNotFoundError as exc:
        logger.exception("File not found")
        result = {
            "ok": False,
            "error": str(exc),
            "error_type": "FileNotFoundError",
        }
    except ValueError as exc:
        logger.exception("Validation error")
        result = {
            "ok": False,
            "error": str(exc),
            "error_type": "ValueError",
        }
    except Exception as exc:
        logger.exception("Unexpected error during transcription")
        # Truncate long error messages to avoid polluting task JSON
        error_msg = str(exc)
        if len(error_msg) > 500:
            error_msg = error_msg[:500] + "... (truncated)"
        result = {
            "ok": False,
            "error": error_msg,
            "error_type": type(exc).__name__,
        }

    finally:
        # Always clean up GPU memory
        try:
            _cleanup_cuda()
        except Exception:
            logger.exception("Cleanup failed")
            # Don't override the original error
            if not result["ok"]:
                pass  # Keep original error
        
        # Write output file
        try:
            logger.info(f"Writing output to {output_path}")
            _write_output(output_path, result)
        except Exception:
            logger.exception("Failed to write output file")
            # Output write failure is critical but we already cleaned up
            return 1

    # Return exit code based on success
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
