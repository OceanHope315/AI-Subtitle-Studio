import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SubtitleArtifactService } from "../services/subtitleService.js";
import { FileTaskStore } from "../services/taskStore.js";
import { aggregateParentState, TaskProcessor } from "../services/taskProcessor.js";

test("parent task status reflects two independent terminal states", () => {
  assert.equal(aggregateParentState({
    visualStatus: "processing",
    audioStatus: "completed",
    visualProgress: 40,
    audioProgress: 100,
  }).status, "processing");
  assert.equal(aggregateParentState({
    visualStatus: "failed",
    audioStatus: "completed",
    visualProgress: 20,
    audioProgress: 100,
  }).status, "completed");
  const failed = aggregateParentState({
    visualStatus: "failed",
    audioStatus: "failed",
    visualProgress: 20,
    audioProgress: 30,
    visualError: "OCR failed",
    audioError: "WhisperX failed",
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.progress, 25);
  assert.match(failed.error, /OCR failed.*WhisperX failed/);

  const audioCompleted = aggregateParentState({
    analysisMode: "audio",
    visualStatus: "skipped",
    audioStatus: "completed",
    visualProgress: 0,
    audioProgress: 100,
  });
  assert.equal(audioCompleted.status, "completed");
  assert.equal(audioCompleted.progress, 100);

  const audioFailed = aggregateParentState({
    analysisMode: "audio",
    visualStatus: "skipped",
    audioStatus: "failed",
    audioProgress: 40,
    audioError: "WhisperX failed",
  });
  assert.equal(audioFailed.status, "failed");
  assert.equal(audioFailed.progress, 40);
  assert.match(audioFailed.error, /WhisperX failed/);
});

test("legacy visual AI jobs populate only the visual track and preserve final subtitles", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "subtitle-processor-"));
  context.after(async () => fs.rm(directory, { recursive: true, force: true }));
  const storePath = path.join(directory, "tasks.json");
  const store = await new FileTaskStore(storePath).initialize();
  const videoPath = path.join(directory, "video.mp4");
  await fs.writeFile(videoPath, "fixture");
  const id = "00000000-0000-4000-8000-000000000001";
  await store.create({
    id,
    filename: "video.mp4",
    storedFilename: "video.mp4",
    videoPath,
    status: "queued",
    roi: { x: 0.1, y: 0.6, width: 0.8, height: 0.25 },
    progress: 0,
    visualStatus: "queued",
    audioStatus: "queued",
    visualProgress: 0,
    audioProgress: 0,
    metadata: { size: 7, mimetype: "video/mp4" },
    subtitles: [{
      id: "final-1",
      text: "User-edited final",
      start_time: 0,
      end_time: 1,
      confidence: null,
      position: null,
      source: null,
      start_frame: null,
      end_frame_exclusive: null,
      start_pts: null,
      end_pts: null,
      time_base: null,
    }],
    error: null,
    artifacts: {},
    aiJobId: null,
  });

  let polls = 0;
  const aiClient = {
    async createJob(task) {
      assert.equal(task.id, id);
      assert.deepEqual(task.roi, { x: 0.1, y: 0.6, width: 0.8, height: 0.25 });
      return { task_id: id, status: "queued", progress: 2, message: "queued" };
    },
    async getJob(jobId) {
      assert.equal(jobId, id);
      polls += 1;
      return {
        task_id: id,
        status: "completed",
        progress: 100,
        run_id: "0123456789abcdef0123456789abcdef",
        latest_seq: 3,
        latest_frame_event: {
          seq: 2,
          task_id: id,
          run_id: "0123456789abcdef0123456789abcdef",
          type: "frame.analyzed",
          occurred_at: "2026-07-17T00:00:02Z",
          payload: { frame_index: 12, preview_id: "a".repeat(32) },
        },
        latest_preview_event: {
          seq: 2,
          task_id: id,
          run_id: "0123456789abcdef0123456789abcdef",
          type: "frame.analyzed",
          occurred_at: "2026-07-17T00:00:02Z",
          payload: { frame_index: 12, preview_id: "a".repeat(32) },
        },
        latest_event: {
          seq: 3,
          task_id: id,
          run_id: "0123456789abcdef0123456789abcdef",
          type: "job.completed",
          occurred_at: "2026-07-17T00:00:03Z",
          payload: { subtitle_count: 1 },
        },
        metadata: { fps: 30, width: 1920, height: 1080, duration: 10 },
        subtitles: [
          {
            id: "ocr-1",
            text: "Hello world",
            start_time: 0.25,
            end_time: 1.75,
            confidence: 0.9,
            position: [1, 2, 3, 4],
            source: "ocr",
          },
        ],
        artifacts: { subtitle_json: "subtitle.json" },
      };
    },
  };
  const artifactService = new SubtitleArtifactService(path.join(directory, "subtitles"));
  const processor = new TaskProcessor({
    store,
    aiClient,
    artifactService,
    config: { aiPollIntervalMs: 1, aiPollMaxAttempts: 3, aiPollMaxErrors: 2 },
    logger: { warn() {}, error() {} },
  });

  const result = await processor.processTask(id);
  assert.equal(polls, 1);
  assert.equal(result.status, "completed");
  assert.equal(result.metadata.fps, 30);
  assert.equal(result.metadata.size, 7);
  assert.equal(result.subtitles[0].text, "User-edited final");
  assert.equal(result.visualSubtitles[0].text, "Hello world");
  assert.equal(result.visualSubtitles[0].start, 0.25);
  assert.deepEqual(result.visualSubtitles[0].bbox, [1, 2, 3, 4]);
  assert.equal(result.visualStatus, "completed");
  assert.equal(result.audioStatus, "failed");
  assert.match(result.audioError, /unavailable/i);
  assert.equal(result.progressSnapshot.latest_seq, 3);
  assert.equal(result.progressSnapshot.latest_event.type, "job.completed");
  assert.equal(result.progressSnapshot.latest_frame_event.type, "frame.analyzed");
  assert.equal(result.progressSnapshot.latest_preview_event.type, "frame.analyzed");

  await assert.rejects(fs.access(artifactService.srtPath(id)));

  await store.close();
  const reopened = await new FileTaskStore(storePath).initialize();
  const persisted = await reopened.findById(id);
  assert.equal(persisted.status, "completed");
  assert.equal(persisted.subtitles[0].text, "User-edited final");
  assert.equal(persisted.visualSubtitles.length, 1);
  assert.equal(persisted.progressSnapshot.run_id, "0123456789abcdef0123456789abcdef");
  assert.equal(persisted.progressSnapshot.latest_frame_event.payload.frame_index, 12);
  assert.equal(persisted.progressSnapshot.latest_preview_event.payload.preview_id, "a".repeat(32));
  await reopened.close();
});

test("visual and audio jobs run independently and persist both source tracks", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "subtitle-dual-processor-"));
  context.after(async () => fs.rm(directory, { recursive: true, force: true }));
  const store = await new FileTaskStore(path.join(directory, "tasks.json")).initialize();
  const videoPath = path.join(directory, "video.mp4");
  await fs.writeFile(videoPath, "fixture");
  const id = "00000000-0000-4000-8000-000000000003";
  await store.create({
    id,
    filename: "video.mp4",
    storedFilename: "video.mp4",
    videoPath,
    status: "queued",
    roi: { x: 0.1, y: 0.6, width: 0.8, height: 0.25 },
    progress: 0,
    metadata: { size: 7, mimetype: "video/mp4" },
    subtitles: [{ id: "final", text: "Keep me", start_time: 0, end_time: 1 }],
    visualSubtitles: [],
    audioSubtitles: [],
    visualStatus: "queued",
    audioStatus: "queued",
    visualProgress: 0,
    audioProgress: 0,
    error: null,
    artifacts: {},
  });

  const submissions = [];
  const aiClient = {
    async createVisualJob() {
      submissions.push("visual");
      return { task_id: id, status: "queued", progress: 2 };
    },
    async createAudioJob() {
      submissions.push("audio");
      return { task_id: `${id}-audio`, status: "queued", progress: 3 };
    },
    async getVisualJob(jobId) {
      assert.equal(jobId, id);
      return {
        task_id: id,
        status: "completed",
        progress: 100,
        visual_subtitles: [{
          text: "WATCH OUT",
          start: 21.1,
          end: 21.4,
          bbox: [[1, 2], [3, 4]],
          confidence: 0.95,
        }],
      };
    },
    async getAudioJob(jobId) {
      assert.equal(jobId, `${id}-audio`);
      return {
        task_id: `${id}-audio`,
        status: "completed",
        progress: 100,
        audio_subtitles: [{
          text: "watch out",
          words: [
            { word: "watch", start: 21.05, end: 21.25, confidence: 0.91 },
            { word: "out", start: 21.25, end: 21.4 },
          ],
          confidence: 0.9,
        }],
      };
    },
  };
  const artifactService = new SubtitleArtifactService(path.join(directory, "subtitles"));
  const processor = new TaskProcessor({
    store,
    aiClient,
    artifactService,
    config: { aiPollIntervalMs: 1, aiPollMaxAttempts: 3, aiPollMaxErrors: 2 },
    logger: { warn() {}, error() {} },
  });

  const result = await processor.processTask(id);
  assert.deepEqual(submissions.sort(), ["audio", "visual"]);
  assert.equal(result.status, "completed");
  assert.equal(result.visualStatus, "completed");
  assert.equal(result.audioStatus, "completed");
  assert.equal(result.visualProgress, 100);
  assert.equal(result.audioProgress, 100);
  assert.equal(result.visualJobId, id);
  assert.equal(result.audioJobId, `${id}-audio`);
  assert.equal(result.visualSubtitles[0].taskId, id);
  assert.equal(result.audioSubtitles[0].taskId, id);
  assert.equal(result.audioSubtitles[0].start, 21.05);
  assert.equal(result.audioSubtitles[0].end, 21.4);
  assert.equal(result.subtitles[0].text, "Keep me");
  await assert.rejects(fs.access(artifactService.srtPath(id)));
  await store.close();
});

test("audio-only tasks never submit a visual job and complete from audio alone", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "subtitle-audio-processor-"));
  context.after(async () => fs.rm(directory, { recursive: true, force: true }));
  const store = await new FileTaskStore(path.join(directory, "tasks.json")).initialize();
  const videoPath = path.join(directory, "video.mp4");
  await fs.writeFile(videoPath, "fixture");
  const id = "00000000-0000-4000-8000-000000000004";
  await store.create({
    id,
    filename: "video.mp4",
    storedFilename: "video.mp4",
    videoPath,
    analysisMode: "audio",
    status: "queued",
    roi: null,
    progress: 0,
    metadata: { size: 7, mimetype: "video/mp4" },
    subtitles: [],
    visualSubtitles: [],
    audioSubtitles: [],
    visualStatus: "skipped",
    audioStatus: "queued",
    visualProgress: 0,
    audioProgress: 0,
    error: null,
    artifacts: {},
  });

  let visualCalls = 0;
  let audioSubmissions = 0;
  const aiClient = {
    async createVisualJob() {
      visualCalls += 1;
      throw new Error("visual analysis must be skipped");
    },
    async getVisualJob() {
      visualCalls += 1;
      throw new Error("visual analysis must be skipped");
    },
    async createAudioJob(task) {
      audioSubmissions += 1;
      assert.equal(task.analysisMode, "audio");
      assert.equal(task.roi, null);
      return { task_id: `${id}-audio`, status: "queued", progress: 5 };
    },
    async getAudioJob(jobId) {
      assert.equal(jobId, `${id}-audio`);
      return {
        task_id: jobId,
        status: "completed",
        progress: 100,
        audio_subtitles: [{
          text: "Audio only",
          start: 0.1,
          end: 1.2,
          confidence: 0.9,
        }],
      };
    },
  };
  const processor = new TaskProcessor({
    store,
    aiClient,
    artifactService: new SubtitleArtifactService(path.join(directory, "subtitles")),
    config: { aiPollIntervalMs: 1, aiPollMaxAttempts: 3, aiPollMaxErrors: 2 },
    logger: { warn() {}, error() {} },
  });

  const result = await processor.processTask(id);

  assert.equal(visualCalls, 0);
  assert.equal(audioSubmissions, 1);
  assert.equal(result.status, "completed");
  assert.equal(result.progress, 100);
  assert.equal(result.visualStatus, "skipped");
  assert.equal(result.visualJobId ?? null, null);
  assert.deepEqual(result.visualSubtitles, []);
  assert.equal(result.audioStatus, "completed");
  assert.equal(result.audioSubtitles[0].text, "Audio only");
  await store.close();
});

test("awaiting-ROI tasks are ignored by direct processing and startup recovery", async () => {
  const tasks = [
    { id: "awaiting", status: "awaiting_roi", progress: 0 },
    { id: "queued", status: "queued", progress: 0 },
    { id: "processing", status: "processing", progress: 50, aiJobId: "job" },
    { id: "completed", status: "completed", progress: 100 },
    { id: "failed", status: "failed", progress: 10 },
  ];
  let aiCalls = 0;
  const processor = new TaskProcessor({
    store: {
      async list() {
        return tasks;
      },
      async findById(taskId) {
        return tasks.find((task) => task.id === taskId) || null;
      },
    },
    aiClient: {
      async createJob() {
        aiCalls += 1;
        throw new Error("must not be called");
      },
      async getJob() {
        aiCalls += 1;
        throw new Error("must not be called");
      },
    },
    artifactService: { async write() {} },
    config: { aiPollIntervalMs: 1, aiPollMaxAttempts: 1, aiPollMaxErrors: 1 },
    logger: { warn() {}, error() {} },
  });
  const recovered = [];
  processor.enqueue = (taskId) => recovered.push(taskId);

  await processor.resumePending();
  const result = await processor.processTask("awaiting");

  assert.deepEqual(recovered, ["queued", "processing"]);
  assert.equal(result.status, "awaiting_roi");
  assert.equal(aiCalls, 0);
});
