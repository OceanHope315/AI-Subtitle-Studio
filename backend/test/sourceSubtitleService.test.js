import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeAudioSubtitles,
  normalizeVisualSubtitles,
} from "../services/sourceSubtitleService.js";

const TASK_ID = "00000000-0000-4000-8000-000000000020";

test("visual source normalization accepts the requested and legacy OCR shapes", () => {
  const subtitles = normalizeVisualSubtitles([
    { text: "later", start: 2, end: 3, bbox: [[1, 2], [3, 4]], confidence: 0.8 },
    { text: "legacy", start_time: 0.5, end_time: 1.5, position: [10, 20, 30, 40], confidence: 0.9 },
  ], { taskId: TASK_ID });

  assert.deepEqual(subtitles.map((item) => item.text), ["legacy", "later"]);
  assert.equal(subtitles[0].taskId, TASK_ID);
  assert.deepEqual(subtitles[0].bbox, [10, 20, 30, 40]);
});

test("audio source normalization preserves word timestamps and derives sentence timing", () => {
  const [subtitle] = normalizeAudioSubtitles([{
    text: "hello world",
    words: [
      { word: "hello", start: 1.2, end: 1.55, score: 0.92 },
      { word: "world", start: 1.6, end: 2.1 },
      { word: "!" },
      { word: "partial", start: 2.2 },
    ],
    confidence: 0.9,
  }], { taskId: TASK_ID });

  assert.equal(subtitle.taskId, TASK_ID);
  assert.equal(subtitle.start, 1.2);
  assert.equal(subtitle.end, 2.1);
  assert.equal(subtitle.words[0].confidence, 0.92);
  assert.equal(subtitle.words[2].start, null);
  assert.equal(subtitle.words[3].start, 2.2);
  assert.equal(subtitle.words[3].end, null);
});

test("strict source normalization rejects invalid timing without touching FinalSubtitle rules", () => {
  assert.throws(
    () => normalizeVisualSubtitles([{ text: "bad", start: 2, end: 1 }], { taskId: TASK_ID }),
    (error) => error.code === "INVALID_SOURCE_SUBTITLES",
  );
  assert.throws(
    () => normalizeAudioSubtitles([{
      text: "bad",
      words: [{ word: "bad", start: 2, end: 1 }],
    }], { taskId: TASK_ID }),
    (error) => error.code === "INVALID_SOURCE_SUBTITLES",
  );
});
