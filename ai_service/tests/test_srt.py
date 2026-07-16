from ai_service.schemas import SubtitleItem
from ai_service.subtitle.srt import format_srt_time, render_srt


def test_format_srt_time_handles_rounding() -> None:
    assert format_srt_time(62.3456) == "00:01:02,346"


def test_render_srt_sorts_items() -> None:
    subtitles = [
        SubtitleItem(id="b", text="second", start_time=2, end_time=3),
        SubtitleItem(id="a", text="first", start_time=0, end_time=1),
    ]
    rendered = render_srt(subtitles)
    assert rendered.startswith("1\n00:00:00,000 --> 00:00:01,000\nfirst")
    assert "2\n00:00:02,000 --> 00:00:03,000\nsecond" in rendered

