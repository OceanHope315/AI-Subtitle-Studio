import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatSrtTimestamp,
  normalizeSubtitles,
  subtitlesToSrt,
} from "../services/subtitleService.js";

test("SRT formatting rounds milliseconds and supports long videos", () => {
  assert.equal(formatSrtTimestamp(0), "00:00:00,000");
  assert.equal(formatSrtTimestamp(3661.2346), "01:01:01,235");
  const normalized = normalizeSubtitles([
    { text: "second", start_time: 2, end_time: 3 },
    { text: "first\r\nline", start_time: 0, end_time: 1.5 },
  ]);
  const srt = subtitlesToSrt(normalized);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,500\nfirst\nline/);
  assert.match(srt, /2\n00:00:02,000 --> 00:00:03,000\nsecond/);
});
