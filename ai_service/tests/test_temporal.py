from ai_service.alignment.temporal import (
    OCRFrameObservation,
    OCRObservation,
    build_ocr_events,
    fuse_with_whisper,
    refine_event_boundary,
    _merge_duplicate_tracks,
)
from ai_service.schemas import SubtitleItem


def observation(time: float, text: str) -> OCRObservation:
    return OCRObservation(time, text, 0.9, (100, 600, 900, 680))


def test_progressive_caption_is_one_visual_event() -> None:
    events = build_ocr_events(
        [
            observation(0.0, "THE SECOND"),
            observation(0.5, "THE SECOND STAR POWER"),
            observation(1.0, "THE SECOND STAR POWER"),
            observation(1.5, "IS REALLY GOOD"),
        ],
        video_duration=3,
        sample_fps=2,
        similarity_threshold=0.55,
        max_missing_seconds=0.8,
        min_duration=0.2,
    )
    assert len(events) == 2
    assert events[0].text == "THE SECOND STAR POWER"
    assert events[0].position == [100, 600, 900, 680]


def test_whisper_text_is_anchored_to_ocr_event() -> None:
    visual = SubtitleItem(
        id="ocr", text="TODAY I WILL TEACH YOU", start_time=0.2, end_time=1.8,
        confidence=0.95, position=[100, 600, 900, 680], source="ocr"
    )
    speech = SubtitleItem(
        id="asr", text="Today I will teach you how to play Sirius.", start_time=0, end_time=2,
        confidence=0.9, source="whisper"
    )
    fused = fuse_with_whisper([visual], [speech])
    assert len(fused) == 1
    assert fused[0].source == "ocr+whisper"
    assert fused[0].position == visual.position


def test_fusion_resolves_adjacent_ocr_overlap() -> None:
    visual = [
        SubtitleItem(id="o1", text="ONE", start_time=0, end_time=1.4, confidence=0.9),
        SubtitleItem(id="o2", text="TWO", start_time=1.2, end_time=2.5, confidence=0.9),
    ]
    speech = [
        SubtitleItem(id="w1", text="One.", start_time=0, end_time=1, confidence=0.9),
        SubtitleItem(id="w2", text="Two.", start_time=1, end_time=2, confidence=0.9),
    ]
    fused = fuse_with_whisper(visual, speech)
    assert fused[0].end_time <= fused[1].start_time


def test_all_candidates_are_tracked_independently() -> None:
    events = build_ocr_events(
        [
            OCRObservation(0.0, "TOP CAPTION", 0.91, (100, 500, 500, 540)),
            OCRObservation(0.0, "BOTTOM CAPTION", 0.92, (100, 650, 600, 690)),
            OCRObservation(0.5, "TOP CAPTION", 0.93, (102, 502, 502, 542)),
            OCRObservation(0.5, "BOTTOM CAPTION", 0.94, (102, 652, 602, 692)),
        ],
        video_duration=2,
        sample_fps=2,
        similarity_threshold=0.6,
        max_missing_seconds=0.8,
        min_duration=0.2,
    )
    assert {event.text for event in events} == {"TOP CAPTION", "BOTTOM CAPTION"}


def test_frame_level_boundary_refinement_handles_progressive_text() -> None:
    visual = SubtitleItem(
        id="ocr",
        text="PROTECT YOURSELF",
        start_time=1.0,
        end_time=2.0,
        confidence=0.95,
        position=[100, 600, 900, 680],
    )

    def frame(index: int, text: str | None) -> OCRFrameObservation:
        candidates = [] if text is None else [
            OCRObservation(index / 10, text, 0.9, (100, 600, 900, 680))
        ]
        return OCRFrameObservation(index, index / 10, candidates)

    refined = refine_event_boundary(
        visual,
        start_frames=[frame(index, "PROTECT" if index >= 7 else None) for index in range(5, 11)],
        end_frames=[frame(index, "PROTECT YOURSELF" if index <= 14 else None)
                    for index in range(10, 21)],
        source_fps=10,
        video_duration=3,
        min_duration=0.2,
    )
    assert refined.start_time == 0.7
    assert refined.end_time == 1.5


def test_whisper_cannot_expand_protect_yourself_into_later_sentence() -> None:
    visual = SubtitleItem(
        id="ocr",
        text="PROTECT YOURSELF",
        start_time=28.1,
        end_time=29.4,
        confidence=0.97,
        position=[160, 1000, 900, 1080],
        source="ocr",
    )
    speech = SubtitleItem(
        id="asr",
        text="Just to protect yourself from brawlers like Mortis I would say.",
        start_time=27.9,
        end_time=30.2,
        confidence=0.94,
        source="whisper",
    )
    fused = fuse_with_whisper([visual], [speech])
    assert len(fused) == 1
    assert fused[0].text == "PROTECT YOURSELF"
    assert fused[0].start_time == visual.start_time
    assert fused[0].end_time == visual.end_time
    assert fused[0].position == visual.position


def test_whisper_never_creates_unanchored_visual_cue() -> None:
    speech = SubtitleItem(
        id="asr", text="Spoken only", start_time=0, end_time=1, confidence=0.9,
        source="whisper"
    )
    assert fuse_with_whisper([], [speech]) == []


def test_single_sample_short_caption_is_emitted() -> None:
    events = build_ocr_events(
        [OCRObservation(8.5, "AND", 0.93, (300, 600, 420, 660))],
        video_duration=10,
        sample_fps=2,
        similarity_threshold=0.6,
        max_missing_seconds=0.8,
        min_duration=0.2,
    )
    assert len(events) == 1
    assert events[0].text == "AND"
    assert events[0].start_time == 8.5
    assert events[0].end_time == 9.0


def test_nested_word_track_is_suppressed_in_favor_of_full_caption() -> None:
    observations = [
        OCRObservation(time, "PROTECT YOURSELF", 0.96, (100, 600, 900, 680))
        for time in (0.851, 1.051, 1.251, 1.451)
    ] + [
        OCRObservation(time, "PROTECT", 0.93, (100, 600, 470, 680))
        for time in (1.451, 1.468)
    ]
    events = build_ocr_events(
        observations,
        video_duration=3,
        sample_fps=5,
        similarity_threshold=0.6,
        max_missing_seconds=0.8,
        min_duration=0.2,
    )
    assert len(events) == 1
    assert events[0].text == "PROTECT YOURSELF"
    assert events[0].start_time == 0.851
    # The nested word's later end must not stretch the full cue.
    assert events[0].end_time == 1.651


def test_sequential_contained_states_are_not_suppressed() -> None:
    short = SubtitleItem(
        id="short", text="PROTECT", start_time=0, end_time=1,
        confidence=0.9, position=[100, 600, 470, 680]
    )
    full = SubtitleItem(
        id="full", text="PROTECT YOURSELF", start_time=0.4, end_time=1.4,
        confidence=0.95, position=[100, 600, 900, 680]
    )
    merged = _merge_duplicate_tracks([short, full], interval=0.2)
    assert [item.text for item in merged] == ["PROTECT", "PROTECT YOURSELF"]


def test_ocr_only_fusion_resolves_same_line_overlap() -> None:
    visual = [
        SubtitleItem(
            id="use", text="USE YOUR GADGET", start_time=0, end_time=1.2,
            confidence=0.9, position=[100, 600, 900, 680]
        ),
        SubtitleItem(
            id="just", text="JUST TAP HIM", start_time=1.117, end_time=2,
            confidence=0.9, position=[100, 602, 900, 682]
        ),
    ]
    fused = fuse_with_whisper(visual, [])
    assert len(fused) == 2
    assert fused[0].end_time == 1.117
    assert fused[0].end_time <= fused[1].start_time


def test_whisper_prefers_same_length_window_over_dropping_visual_word() -> None:
    visual = SubtitleItem(
        id="ocr", text="T WOULD SAY", start_time=3, end_time=4,
        confidence=0.88, position=[100, 600, 700, 680], source="ocr"
    )
    speech = SubtitleItem(
        id="asr", text="I would say", start_time=3, end_time=4,
        confidence=0.95, source="whisper"
    )
    fused = fuse_with_whisper([visual], [speech])
    assert len(fused) == 1
    assert fused[0].text == "I would say"


def test_whisper_can_still_restore_one_clearly_missing_word() -> None:
    visual = SubtitleItem(
        id="ocr", text="PLEASE GO NOW", start_time=3, end_time=4,
        confidence=0.8, position=[100, 600, 700, 680], source="ocr"
    )
    speech = SubtitleItem(
        id="asr", text="Please just go now", start_time=3, end_time=4,
        confidence=0.95, source="whisper"
    )
    fused = fuse_with_whisper([visual], [speech])
    assert fused[0].text == "Please just go now"


def test_stacked_line_addition_is_a_distinct_visual_state() -> None:
    events = build_ocr_events(
        [
            OCRObservation(0.25, "HOW TO PLAY", 0.98, (120, 1055, 949, 1230)),
            OCRObservation(0.5, "HOW TO PLAY\nSIRIUS", 0.99, (120, 1055, 949, 1359)),
            OCRObservation(0.75, "HOW TO PLAY\nSIRIUS", 0.99, (120, 1055, 949, 1359)),
        ],
        video_duration=2,
        sample_fps=4,
        similarity_threshold=0.6,
        max_missing_seconds=0.8,
        min_duration=0.1,
    )
    assert [event.text for event in events] == [
        "HOW TO PLAY", "HOW TO PLAY\nSIRIUS"
    ]


def test_overlap_resolution_does_not_trim_different_lines_or_simultaneous_boxes() -> None:
    hud = SubtitleItem(
        id="hud", text="TEAM LABEL", start_time=21.021, end_time=22.522,
        confidence=0.99, position=[257, 1111, 494, 1145]
    )
    caption = SubtitleItem(
        id="caption", text="FOR THE CLONES", start_time=21.438, end_time=21.722,
        confidence=0.99, position=[267, 1232, 821, 1314]
    )
    left = SubtitleItem(
        id="left", text="LEFT", start_time=23, end_time=23.5,
        confidence=0.9, position=[200, 1230, 450, 1315]
    )
    right = SubtitleItem(
        id="right", text="RIGHT", start_time=23, end_time=23.5,
        confidence=0.9, position=[430, 1230, 750, 1315]
    )
    fused = fuse_with_whisper([hud, caption, left, right], [])
    by_id = {event.id: event for event in fused}
    assert by_id["caption"].end_time == 21.722
    assert by_id["left"].end_time == 23.5


def test_high_confidence_visual_text_rejects_whisper_semantic_substitutions() -> None:
    cases = [
        ("THE SECOND STARPOWER", "The second star"),
        ("YOUDON'T HAVE", "don't have"),
        ("FOR THE CLONES", "out the clones"),
        ("SOOP RIGHT NOW", "pure right now"),
        ("HE'S REALLY GOOD", "is really good"),
    ]
    for index, (visual_text, speech_text) in enumerate(cases):
        visual = SubtitleItem(
            id=f"ocr-{index}", text=visual_text, start_time=index,
            end_time=index + 0.9, confidence=0.98,
            position=[100, 600, 900, 680], source="ocr"
        )
        speech = SubtitleItem(
            id=f"asr-{index}", text=speech_text, start_time=index,
            end_time=index + 0.9, confidence=0.95, source="whisper"
        )
        assert fuse_with_whisper([visual], [speech])[0].text == visual_text


def test_high_confidence_visual_text_accepts_compact_space_repairs() -> None:
    cases = [
        ("THE SECOND STARPOWER", "The second star power"),
        ("YOUCAN PLAY", "You can play"),
        ("BUTONMANY", "But on many"),
    ]
    for index, (visual_text, speech_text) in enumerate(cases):
        visual = SubtitleItem(
            id=f"ocr-space-{index}", text=visual_text, start_time=index,
            end_time=index + 0.9, confidence=0.99,
            position=[100, 600, 900, 680], source="ocr"
        )
        speech = SubtitleItem(
            id=f"asr-space-{index}", text=speech_text, start_time=index,
            end_time=index + 0.9, confidence=0.95, source="whisper"
        )
        assert fuse_with_whisper([visual], [speech])[0].text == speech_text


def test_near_certain_visual_plural_rejects_whisper_singular_repair() -> None:
    visual = SubtitleItem(
        id="ocr-plural", text="OTHERMAPS", start_time=0,
        end_time=0.9, confidence=0.9995,
        position=[100, 600, 900, 680], source="ocr"
    )
    speech = SubtitleItem(
        id="asr-singular", text="other map", start_time=0,
        end_time=0.9, confidence=0.95, source="whisper"
    )

    assert fuse_with_whisper([visual], [speech])[0].text == "OTHERMAPS"


def test_medium_confidence_visual_plural_allows_one_character_repair() -> None:
    visual = SubtitleItem(
        id="ocr-plural", text="OTHERMAPS", start_time=0,
        end_time=0.9, confidence=0.96,
        position=[100, 600, 900, 680], source="ocr"
    )
    speech = SubtitleItem(
        id="asr-singular", text="other map", start_time=0,
        end_time=0.9, confidence=0.95, source="whisper"
    )

    assert fuse_with_whisper([visual], [speech])[0].text == "other map"


def test_overlap_resolution_closes_centered_caption_stream_after_vertical_jump() -> None:
    also = SubtitleItem(
        id="also", text="ALSO", start_time=22.122, end_time=23.022,
        confidence=0.99, position=[446, 1234, 638, 1310]
    )
    raised = SubtitleItem(
        id="raised", text="WHEN YOU DIE", start_time=22.689, end_time=23.390,
        confidence=0.99, position=[305, 1088, 789, 1168]
    )
    fused = fuse_with_whisper([also, raised], [])
    assert fused[0].end_time == 22.689


def test_small_hud_does_not_define_a_moved_caption_stream() -> None:
    hud = SubtitleItem(
        id="hud", text="TEAM", start_time=21, end_time=22.5,
        confidence=0.99, position=[322, 1106, 518, 1141]
    )
    caption = SubtitleItem(
        id="caption", text="ALSO", start_time=22.1, end_time=22.7,
        confidence=0.99, position=[446, 1234, 638, 1310]
    )
    fused = fuse_with_whisper([hud, caption], [])
    assert fused[0].end_time == 22.5
