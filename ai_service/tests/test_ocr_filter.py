from ai_service.ocr.base import DetectedText
from ai_service.ocr.paddle_engine import PaddleOCREngine, _polygon_to_box


def test_hud_time_and_peripheral_labels_are_rejected() -> None:
    engine = PaddleOCREngine("en", 0.5)
    assert not engine._is_candidate(
        DetectedText("BOUNTY in: 16m 55s", 0.99, (184, 1060, 753, 1128)),
        1080,
        748,
        864,
    )
    assert not engine._is_candidate(
        DetectedText("Snake Pit", 0.99, (10, 1296, 298, 1376)),
        1080,
        748,
        864,
    )


def test_centered_caption_outranks_top_hud() -> None:
    caption = DetectedText("YOU CAN PLAY", 0.995, (304, 1231, 787, 1314))
    hud = DetectedText("Starfruit Supernova", 0.999, (214, 918, 809, 1006))
    engine = PaddleOCREngine("en", 0.5)
    assert engine._is_candidate(caption, 1080, 748, 864)
    assert not engine._is_candidate(hud, 1080, 748, 864)
    assert engine._candidate_score(caption, 1080, 748, 864) > engine._candidate_score(
        hud, 1080, 748, 864
    )


def test_ocr_box_restores_both_global_crop_offsets() -> None:
    assert _polygon_to_box([(1, 2), (11, 2), (11, 12), (1, 12)], 200, 300) == (
        301, 202, 311, 212
    )


def test_manual_roi_bypasses_legacy_layout_heuristic() -> None:
    engine = PaddleOCREngine("en", 0.5)
    edge_caption = DetectedText("PROTECT YOURSELF", 0.99, (305, 202, 495, 222))
    assert not engine._is_candidate(edge_caption, 200, 100, 200, 300)
    assert engine._is_candidate(
        edge_caption,
        200,
        100,
        200,
        300,
        apply_layout_filter=False,
    )


def test_manual_roi_keeps_short_alphabetic_caption_but_not_digits() -> None:
    engine = PaddleOCREngine("en", 0.5)
    short_caption = DetectedText("AND", 0.99, (320, 210, 370, 230))
    assert not engine._is_candidate(short_caption, 200, 100, 200, 300)
    assert engine._is_candidate(
        short_caption,
        200,
        100,
        200,
        300,
        apply_layout_filter=False,
    )
    assert not engine._is_candidate(
        DetectedText("99", 0.99, (320, 210, 350, 230)),
        200,
        100,
        200,
        300,
        apply_layout_filter=False,
    )
