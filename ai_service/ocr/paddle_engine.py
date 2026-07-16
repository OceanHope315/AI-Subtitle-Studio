from __future__ import annotations

import importlib.util
import math
import os
import re
from collections.abc import Iterable

from .base import DetectedText, OCRUnavailableError


# Paddle 3.x on Windows may otherwise select an unsupported oneDNN PIR path.
os.environ.setdefault("FLAGS_use_mkldnn", "0")
os.environ.setdefault("FLAGS_enable_pir_api", "0")


class PaddleOCREngine:
    name = "paddleocr"

    def __init__(self, language: str = "en", min_confidence: float = 0.55) -> None:
        self.language = language
        self.min_confidence = min_confidence
        self._engine = None
        self._api_version = 3

    @staticmethod
    def installed() -> bool:
        return bool(importlib.util.find_spec("paddleocr") and importlib.util.find_spec("paddle"))

    def _load(self):
        if self._engine is not None:
            return self._engine
        if not self.installed():
            raise OCRUnavailableError(
                "PaddleOCR 未安装；请执行 pip install -r requirements.txt"
            )
        try:
            from paddleocr import PaddleOCR

            try:
                self._engine = PaddleOCR(
                    lang=self.language,
                    use_doc_orientation_classify=False,
                    use_doc_unwarping=False,
                    use_textline_orientation=False,
                    text_detection_model_name="PP-OCRv5_mobile_det",
                    text_recognition_model_name=(
                        "en_PP-OCRv5_mobile_rec" if self.language == "en" else None
                    ),
                    device="cpu",
                    enable_mkldnn=False,
                    cpu_threads=max(1, min(6, os.cpu_count() or 2)),
                    text_det_limit_side_len=960,
                )
                self._api_version = 3
            except (TypeError, ValueError):
                self._engine = PaddleOCR(
                    use_angle_cls=False,
                    lang=self.language,
                    show_log=False,
                    use_gpu=False,
                    enable_mkldnn=False,
                )
                self._api_version = 2
        except Exception as exc:
            raise OCRUnavailableError(f"PaddleOCR 初始化失败: {exc}") from exc
        return self._engine

    def detect(
        self,
        image,
        offset_y: int = 0,
        offset_x: int = 0,
        *,
        apply_layout_filter: bool = True,
    ) -> list[DetectedText]:
        engine = self._load()
        try:
            raw = engine.predict(image) if self._api_version >= 3 else engine.ocr(image, cls=False)
        except Exception as exc:
            raise RuntimeError(f"PaddleOCR 推理失败: {exc}") from exc

        boxes = (
            self._parse_v3(raw, offset_y, offset_x)
            if self._api_version >= 3
            else self._parse_v2(raw, offset_y, offset_x)
        )
        crop_height, frame_width = image.shape[:2]
        boxes = [
            box
            for box in boxes
            if self._is_candidate(
                box,
                frame_width,
                crop_height,
                offset_y,
                offset_x,
                apply_layout_filter=apply_layout_filter,
            )
        ]
        return sorted(
            boxes,
            key=lambda box: self._candidate_score(
                box, frame_width, crop_height, offset_y, offset_x
            ),
            reverse=True,
        )

    def _parse_v3(self, results, offset_y: int, offset_x: int = 0) -> list[DetectedText]:
        parsed: list[DetectedText] = []
        for result in results or []:
            value = result.json if hasattr(result, "json") else result
            if callable(value):
                value = value()
            if not isinstance(value, dict):
                continue
            data = value.get("res", value)
            texts = data.get("rec_texts", [])
            scores = data.get("rec_scores", [])
            polygons = data.get("rec_polys") or data.get("dt_polys") or []
            for text, score, polygon in zip(texts, scores, polygons):
                position = _polygon_to_box(polygon, offset_y, offset_x)
                if position:
                    parsed.append(DetectedText(_clean_text(str(text)), float(score), position))
        return parsed

    def _parse_v2(self, results, offset_y: int, offset_x: int = 0) -> list[DetectedText]:
        parsed: list[DetectedText] = []
        nodes = results or []
        if len(nodes) == 1 and isinstance(nodes[0], list):
            nodes = nodes[0]
        for item in nodes:
            if not isinstance(item, (list, tuple)) or len(item) < 2:
                continue
            polygon, recognition = item[0], item[1]
            if not isinstance(recognition, (list, tuple)) or len(recognition) < 2:
                continue
            position = _polygon_to_box(polygon, offset_y, offset_x)
            if position:
                parsed.append(
                    DetectedText(_clean_text(str(recognition[0])), float(recognition[1]), position)
                )
        return parsed

    def _is_candidate(
        self,
        box: DetectedText,
        frame_width: int,
        crop_height: int,
        offset_y: int,
        offset_x: int = 0,
        *,
        apply_layout_filter: bool = True,
    ) -> bool:
        text = box.text.strip()
        # A user-drawn ROI is already a strong spatial prior. Keep legitimate
        # short visual cues such as "AND", "GO" or "NO" there, while the legacy
        # automatic band retains its stricter anti-HUD length threshold.
        minimum_length = 4 if apply_layout_filter else 2
        if box.confidence < self.min_confidence or len(text) < minimum_length:
            return False
        alphas = sum(character.isalpha() for character in text)
        if alphas < 2 or alphas / max(1, len(text)) < 0.35:
            return False
        compact = re.sub(r"\s+", "", text)
        if compact.isdigit() or re.fullmatch(r"[\d/:%+.-]+", compact):
            return False
        if re.search(r"\b\d+\s*[hms]\b", text, re.IGNORECASE):
            return False
        x1, y1, x2, y2 = box.position
        center_x = ((x1 + x2) / 2 - offset_x) / max(1, frame_width)
        center_y = ((y1 + y2) / 2 - offset_y) / max(1, crop_height)
        width_ratio = (x2 - x1) / max(1, frame_width)
        if not apply_layout_filter:
            return True
        # Game HUD labels cluster at the crop edges and top. Keep wide text,
        # but reject small peripheral labels before they can win top-1.
        if center_y < 0.27 or center_y > 0.84:
            return False
        if not 0.17 <= center_x <= 0.83 and width_ratio < 0.55:
            return False
        return True

    @staticmethod
    def _candidate_score(
        box: DetectedText,
        frame_width: int,
        crop_height: int,
        offset_y: int,
        offset_x: int = 0,
    ) -> float:
        x1, y1, x2, y2 = box.position
        width = max(1, x2 - x1)
        word_bonus = min(1.0, len(box.text.split()) / 5)
        local_y = ((y1 + y2) / 2 - offset_y) / max(1, crop_height)
        center_x = ((x1 + x2) / 2 - offset_x) / max(1, frame_width)
        vertical_score = max(0.0, 1 - abs(local_y - 0.54) / 0.28)
        horizontal_score = max(0.0, 1 - abs(center_x - 0.5) / 0.5)
        return (
            box.confidence * 0.45
            + word_bonus * 0.15
            + min(1.0, width / max(1, frame_width * 0.65)) * 0.15
            + vertical_score * 0.2
            + horizontal_score * 0.05
        )


def _polygon_to_box(
    polygon: Iterable, offset_y: int, offset_x: int = 0
) -> tuple[int, int, int, int] | None:
    try:
        points = list(polygon)
        xs = [float(point[0]) for point in points]
        ys = [float(point[1]) for point in points]
    except (TypeError, ValueError, IndexError):
        return None
    if not xs or not all(math.isfinite(value) for value in [*xs, *ys]):
        return None
    return (
        int(min(xs)) + offset_x,
        int(min(ys)) + offset_y,
        int(max(xs)) + offset_x,
        int(max(ys)) + offset_y,
    )


def _clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("|", "I")).strip()
