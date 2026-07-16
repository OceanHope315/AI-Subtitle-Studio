import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SubtitleArtifactService } from "../services/subtitleService.js";
import { FileTaskStore } from "../services/taskStore.js";
import { TaskProcessor } from "../services/taskProcessor.js";

test("AI job progress, metadata and subtitles are synchronized and persisted", async (context) => {
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
    metadata: { size: 7, mimetype: "video/mp4" },
    subtitles: [],
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
  assert.equal(result.subtitles[0].text, "Hello world");

  const srt = await fs.readFile(artifactService.srtPath(id), "utf8");
  assert.match(srt, /00:00:00,250 --> 00:00:01,750/);

  await store.close();
  const reopened = await new FileTaskStore(storePath).initialize();
  const persisted = await reopened.findById(id);
  assert.equal(persisted.status, "completed");
  assert.equal(persisted.subtitles.length, 1);
  await reopened.close();
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
