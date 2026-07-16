# Visual-caption ground truth

`test-video.visual.json` annotates the visible hard captions in the bundled
39.7063-second, 2,380-frame test video. It contains 58 semantic caption states
from source frame 13 through frame 2379. Frames 0-12 contain no caption;
frames 144-148 are a motion-blurred edit with no stable phrase.

The annotation uses inclusive `last_frame` values and exclusive `end_time`
values. Times are derived from source-frame indices and the stored source FPS,
not from the container audio duration.

## Verification tiers

- Tier A: five transitions around `PROTECT YOURSELF` were checked on both
  adjacent source frames. The verified sequence is frames 1727-1953. Direct
  inspection corrected the old `I WOULD SAY` end from frame 1959 to frame 1953;
  `YOU CAN PLAY` begins on frame 1954.
- Tier B: all remaining captions have manually confirmed text, but their
  boundaries are estimates. They combine the retained 2 FPS strict OCR output,
  the old aligned SRT, a 4 FPS full-video contact sheet, and cheap visual-change
  candidates over every source frame. Their declared uncertainty is +/-18
  source frames (about 0.30 seconds), so they must not be described as exact.

The semantic-state policy treats a completed edited phrase as one event. Word
entrance animation, colour highlighting, and motion blur do not create extra
events. This is why OCR fragments such as `JUST 3-` and `TAP` are represented as
the single state `JUST 3-TAP THEM`.

## ROI and remaining uncertainty

The final full-video inference uses the manually selected normalized ROI
`{x:0.08,y:0.52,width:0.84,height:0.24}`. It includes the opening title and the
raised `WHEN YOU DIE`, `ALL YOUR SHADOWS`, and `DISAPPEAR` states. The JSON also
retains older production/annotation ROI fields as annotation provenance; they
are not the current default inference ROI.

The only final false negative is frames 13-21: a roughly 0.15-second
`HOW TO PLAY` entrance state whose stylised letters are still animating and
were not completely readable by OCR. The system deliberately does not infer
the missing text from later frames. Its manually annotated pixel box is a
contact-sheet estimate; the remaining boxes come from OCR frame candidates or
targeted OCR reads.

Run `python -m pytest ai_service/tests/test_visual_ground_truth.py -q` to check
schema, event order, frame/time conversion, positions, declared coverage gaps,
verification tiers, and the adjacent-frame regression window. The test does
not require the 27 MB video in clean CI; when the video is present locally it
also verifies the SHA-256 digest.

## Evaluating generated timelines

Use the reusable evaluator with either `subtitle.json` or `ocr_events.json`:

```powershell
python scripts/evaluate-visual-timeline.py `
  data/ground_truth/test-video.visual.json `
  data/subtitles/test-video/subtitle.json `
  --output data/subtitles/test-video/visual-evaluation.json
```

The terminal summary reports raw and semantic prediction counts, precision,
recall, normalized text accuracy, start/end frame MAE, strict Tier A boundary
status, and false-positive/false-negative captions. The JSON report additionally
contains every monotonic one-to-one match and its signed frame errors.

The retained final report matches 57 of 58 truth states with precision 1.0000,
recall 0.9828, and F1 0.9913. All 57 matched normalized texts are exact; start
MAE is 1.053 frames, final end MAE is 0.351 frames, all five Tier A events are
exact, and there are no false positives or final timeline overlaps. These
figures do not make all Tier B boundaries exact: their declared uncertainty
remains +/-18 source frames.

Comparison ignores case, punctuation, line separators, and harmless OCR word
spacing. Simultaneous vertically stacked OCR lines are combined into one
semantic cue before matching; pass `--no-merge-multiline` to inspect raw lines
instead. Use `--json` to print the complete report to standard output and
`--text-threshold` to override the default `0.72` match threshold.
