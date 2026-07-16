from ai_service.alignment.temporal import filter_dominant_caption_events
from ai_service.ocr.base import DetectedText
from ai_service.ocr.composition import compose_line_candidates
from ai_service.schemas import SubtitleItem


def candidate(text, confidence, position):
    return DetectedText(text, confidence, position)


def test_same_baseline_fragments_are_composed_left_to_right() -> None:
    composed = compose_line_candidates(
        [
            candidate("THE FIRST", 0.96, (100, 100, 300, 150)),
            candidate("GADGET", 0.98, (285, 101, 450, 151)),
        ]
    )
    assert len(composed) == 1
    assert composed[0].text == "THE FIRST GADGET"
    assert composed[0].position == (100, 100, 450, 151)
    assert 0.96 < composed[0].confidence < 0.98


def test_three_fragments_and_token_overlap_form_one_line() -> None:
    composed = compose_line_candidates(
        [
            candidate("TO WATCH", 0.95, (100, 100, 310, 155)),
            candidate("WATCH", 0.96, (290, 101, 400, 154)),
            candidate("OUT", 0.97, (390, 100, 475, 156)),
        ]
    )
    assert len(composed) == 1
    assert composed[0].text == "TO WATCH OUT"


def test_full_candidate_suppresses_competing_nested_fragments() -> None:
    composed = compose_line_candidates(
        [
            candidate("PROTECT YOURSELF", 0.97, (100, 100, 500, 160)),
            candidate("PROTECT", 0.99, (100, 100, 285, 160)),
            candidate("YOURSELF", 0.98, (300, 100, 500, 160)),
        ]
    )
    assert len(composed) == 1
    assert composed[0].text == "PROTECT YOURSELF"
    assert composed[0].position == (100, 100, 500, 160)


def test_roi_edge_hud_is_not_joined_to_real_caption_on_nearby_baseline() -> None:
    composed = compose_line_candidates(
        [
            candidate("IST", 0.95, (86, 1172, 250, 1288)),
            candidate("BASICALLY SIRIUS", 0.99, (251, 1224, 836, 1319)),
        ],
        roi_bounds=(86, 998, 994, 1459),
    )
    assert [item.text for item in composed] == ["IST", "BASICALLY SIRIUS"]


def test_different_baselines_remain_independent() -> None:
    composed = compose_line_candidates(
        [
            candidate("TOP LINE", 0.97, (100, 100, 350, 150)),
            candidate("BOTTOM LINE", 0.98, (100, 200, 400, 250)),
        ]
    )
    assert len(composed) == 2


def test_equal_size_stacked_caption_lines_form_one_two_line_candidate() -> None:
    composed = compose_line_candidates(
        [
            candidate("HOW TO PLAY", 0.98, (120, 1055, 949, 1230)),
            candidate("SIRIUS", 0.99, (319, 1183, 776, 1359)),
            candidate("BY CREATOR", 0.99, (340, 1402, 745, 1459)),
        ]
    )
    assert len(composed) == 2
    assert composed[0].text == "HOW TO PLAY\nSIRIUS"
    assert composed[0].position == (120, 1055, 949, 1359)
    assert composed[1].text == "BY CREATOR"


def test_high_confidence_body_suppresses_false_multiline_and_attached_hud() -> None:
    composed = compose_line_candidates(
        [
            candidate(
                "RASKET\nEVERYWHERE", 0.8899, (318, 1178, 771, 1309)
            ),
            candidate("Triple-Double", 0.9217, (408, 1297, 825, 1384)),
            candidate("EVERYWHERE", 0.9982, (318, 1234, 772, 1307)),
        ]
    )

    assert [(item.text, item.position) for item in composed] == [
        ("EVERYWHERE", (318, 1234, 772, 1307))
    ]


def test_similarly_confident_progressive_stacked_title_is_preserved() -> None:
    composed = compose_line_candidates(
        [
            candidate("HOW TO PLAY\nSIRIUS", 0.975, (120, 1055, 949, 1359)),
            candidate("SIRIUS", 0.995, (319, 1183, 776, 1359)),
        ]
    )

    assert len(composed) == 1
    assert composed[0].text == "HOW TO PLAY\nSIRIUS"
    assert composed[0].position == (120, 1055, 949, 1359)


def test_dominant_line_filter_removes_static_tiny_noise_but_keeps_moved_short_cue() -> None:
    captions = [
        SubtitleItem(
            id=f"caption-{index}", text=f"CAPTION {index}",
            start_time=index, end_time=index + 0.8, confidence=0.95,
            position=[250, 600, 750, 680]
        )
        for index in range(4)
    ]
    moved_short = SubtitleItem(
        id="moved", text="AND", start_time=4, end_time=4.4, confidence=0.99,
        position=[450, 450, 550, 530]
    )
    static_brand = SubtitleItem(
        id="brand", text="BRAND", start_time=0, end_time=3, confidence=0.99,
        position=[20, 500, 180, 580]
    )
    tiny_label = SubtitleItem(
        id="tiny", text="MENU", start_time=1, end_time=2, confidence=0.99,
        position=[500, 700, 560, 710]
    )
    filtered = filter_dominant_caption_events(
        [*captions, moved_short, static_brand, tiny_label],
        roi_box=(0, 400, 1000, 800),
        sample_fps=2,
    )
    ids = {event.id for event in filtered}
    assert {event.id for event in captions} <= ids
    assert "moved" in ids
    assert "brand" not in ids
    assert "tiny" not in ids


def test_dominant_filter_rejects_small_static_and_roi_edge_hud_tracks() -> None:
    captions = [
        SubtitleItem(
            id=f"normal-{index}", text=f"NORMAL {index}", start_time=index,
            end_time=index + 0.7, confidence=0.98,
            position=[240, 1230, 840, 1315]
        )
        for index in range(5)
    ]
    raised_caption = SubtitleItem(
        id="raised", text="WHEN YOU MOVE", start_time=6, end_time=6.7,
        confidence=0.98, position=[300, 1084, 790, 1171]
    )
    byline = SubtitleItem(
        id="byline", text="BY CREATOR", start_time=0.5, end_time=2.4,
        confidence=0.99, position=[340, 1402, 745, 1459]
    )
    small_static = SubtitleItem(
        id="team", text="TEAM LABEL", start_time=13.5, end_time=16,
        confidence=0.99, position=[322, 1106, 518, 1141]
    )
    clipped_edge = SubtitleItem(
        id="edge", text="PARTIAL MENU", start_time=1, end_time=1.5,
        confidence=0.99, position=[86, 1163, 525, 1303]
    )
    transient_small_hud = SubtitleItem(
        id="transient-team", text="TEAM LABEL", start_time=22.5, end_time=23,
        confidence=0.99, position=[264, 1324, 473, 1360]
    )
    noisy_wide_caption = SubtitleItem(
        id="noisy-caption", text="NOISE BASICALLY SIRIUS", start_time=34,
        end_time=34.5, confidence=0.96, position=[86, 1172, 836, 1319]
    )
    filtered = filter_dominant_caption_events(
        [
            *captions, raised_caption, byline, small_static, clipped_edge,
            transient_small_hud, noisy_wide_caption,
        ],
        roi_box=(86, 998, 994, 1459),
        sample_fps=2,
    )
    ids = {event.id for event in filtered}
    assert {event.id for event in captions} <= ids
    assert "raised" in ids
    assert "byline" not in ids
    assert "team" not in ids
    assert "transient-team" not in ids
    assert "edge" not in ids
    assert "noisy-caption" in ids


def test_dominant_filter_uses_strong_temporal_track_to_drop_noisy_discovery_rows() -> None:
    normal = [
        SubtitleItem(
            id=f"normal-{index}", text=f"NORMAL {index}", start_time=index,
            end_time=index + 0.7, confidence=0.99,
            position=[240, 1230, 840, 1315],
        )
        for index in range(4)
    ]
    everywhere = SubtitleItem(
        id="everywhere", text="EVERYWHERE", start_time=34.201, end_time=34.651,
        confidence=0.9982, position=[318, 1234, 772, 1307],
    )
    false_expansion = SubtitleItem(
        id="expansion", text="RASKET\nEVERYWHERE", start_time=34.351,
        end_time=34.851, confidence=0.8899,
        position=[318, 1178, 771, 1309],
    )
    attached_hud = SubtitleItem(
        id="attached", text="Triple-Double", start_time=34.351,
        end_time=34.851, confidence=0.9217,
        position=[408, 1297, 825, 1384],
    )

    filtered = filter_dominant_caption_events(
        [*normal, everywhere, false_expansion, attached_hud],
        roi_box=(86, 998, 994, 1459),
        sample_fps=2,
    )

    assert {event.id for event in filtered} == {
        *(event.id for event in normal),
        "everywhere",
    }


def test_temporal_competition_keeps_comparably_confident_progressive_title() -> None:
    title = SubtitleItem(
        id="title", text="HOW TO PLAY", start_time=0.2, end_time=0.5,
        confidence=0.98, position=[120, 1055, 949, 1230],
    )
    stacked = SubtitleItem(
        id="stacked", text="HOW TO PLAY\nSIRIUS", start_time=0.35, end_time=2.4,
        confidence=0.99, position=[120, 1055, 949, 1359],
    )

    filtered = filter_dominant_caption_events(
        [title, stacked], roi_box=(86, 998, 994, 1459), sample_fps=2
    )

    assert [event.id for event in filtered] == ["title", "stacked"]
