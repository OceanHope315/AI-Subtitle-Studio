from __future__ import annotations

import argparse
import json
import sys
import uuid
from dataclasses import replace
from pathlib import Path


if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ai_service.config import settings
from ai_service.pipeline import SubtitlePipeline
from ai_service.schemas import NormalizedROI
from ai_service.subtitle.metrics import evaluate, parse_srt


def main() -> None:
    parser = argparse.ArgumentParser(description="AI Subtitle Studio local processor")
    parser.add_argument("video", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--task-id", default=f"cli-{uuid.uuid4().hex[:8]}")
    parser.add_argument("--language", default="en")
    parser.add_argument("--sample-fps", type=float, default=settings.sample_fps)
    parser.add_argument("--no-whisper", action="store_true")
    parser.add_argument(
        "--roi",
        type=float,
        nargs=4,
        metavar=("X", "Y", "WIDTH", "HEIGHT"),
        help="normalized subtitle crop rectangle; defaults to OCR_ROI_TOP/BOTTOM",
    )
    parser.add_argument("--ground-truth", type=Path)
    args = parser.parse_args()

    if not args.video.is_file():
        parser.error(f"video not found: {args.video}")
    output = args.output or settings.subtitles_dir / args.task_id
    configured = replace(
        settings,
        sample_fps=args.sample_fps,
        ocr_language=args.language,
    )
    try:
        roi = NormalizedROI(
            x=args.roi[0], y=args.roi[1], width=args.roi[2], height=args.roi[3]
        ) if args.roi else None
    except ValueError as exc:
        parser.error(f"invalid --roi: {exc}")
    result = SubtitlePipeline(configured).process(
        args.video,
        output,
        enable_whisper=not args.no_whisper,
        roi=roi,
        progress=lambda value, message: print(f"[{value:3}%] {message}", flush=True),
    )
    summary = {
        "video": result.metadata.model_dump(mode="json"),
        "subtitle_count": len(result.subtitles),
        "ocr_event_count": result.ocr_event_count,
        "whisper_segment_count": result.whisper_segment_count,
        "artifacts": result.artifacts,
        "warnings": result.warnings,
    }
    if args.ground_truth:
        summary["evaluation"] = evaluate(
            parse_srt(args.ground_truth), result.subtitles
        ).as_dict()
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
