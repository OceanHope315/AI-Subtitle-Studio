import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import request from "supertest";
import { createApp } from "../app.js";
import { validateAnalysisMode, validateRoi } from "../routes/tasks.js";
import { SubtitleArtifactService } from "../services/subtitleService.js";
import { FileTaskStore } from "../services/taskStore.js";

function mp4Fixture() {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from("ftypisom"),
    Buffer.alloc(64, 7),
  ]);
}

test("ROI validation rejects non-finite numbers", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(
      () => validateRoi({ x: value, y: 0, width: 0.5, height: 0.5 }),
      (error) => error.status === 400 && error.code === "INVALID_ROI",
    );
  }
});

test("analysis mode validation defaults legacy clients and rejects unknown modes", () => {
  assert.equal(validateAnalysisMode(undefined), "audio_visual");
  assert.equal(validateAnalysisMode("audio"), "audio");
  assert.equal(validateAnalysisMode("audio_visual"), "audio_visual");
  assert.throws(
    () => validateAnalysisMode("visual"),
    (error) => error.status === 400 && error.code === "INVALID_ANALYSIS_MODE",
  );
});

describe("tasks API", () => {
  let directory;
  let config;
  let store;
  let artifactService;
  let app;
  let enqueued;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "subtitle-backend-api-"));
    config = {
      corsOrigin: "*",
      jsonLimit: "1mb",
      uploadDir: path.join(directory, "videos"),
      subtitleDir: path.join(directory, "subtitles"),
      fileDbPath: path.join(directory, "tasks.json"),
      maxUploadBytes: 1024 * 1024,
    };
    await fs.mkdir(config.uploadDir, { recursive: true });
    store = await new FileTaskStore(config.fileDbPath).initialize();
    artifactService = new SubtitleArtifactService(config.subtitleDir);
    enqueued = [];
    const processor = {
      enqueue(taskId) {
        enqueued.push(taskId);
        return true;
      },
    };
    app = createApp({ store, processor, artifactService, config });
  });

  afterEach(async () => {
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  test("creates, lists, reads, edits and exports a task", async () => {
    const created = await request(app)
      .post("/api/tasks")
      .attach("video", mp4Fixture(), { filename: "demo.mp4", contentType: "video/mp4" })
      .expect(201);

    assert.match(created.body.id, /^[a-f\d-]{36}$/i);
    assert.equal(created.body.filename, "demo.mp4");
    assert.equal(created.body.analysis_mode, "audio_visual");
    assert.equal(created.body.status, "awaiting_roi");
    assert.equal(created.body.roi, null);
    assert.deepEqual(enqueued, []);

    const listed = await request(app).get("/api/tasks").expect(200);
    assert.equal(listed.body.tasks.length, 1);
    assert.equal(listed.body.tasks[0].id, created.body.id);

    const detail = await request(app).get(`/api/tasks/${created.body.id}`).expect(200);
    assert.equal(detail.body.video_url, `/api/tasks/${created.body.id}/video`);
    assert.deepEqual(enqueued, [], "reading an awaiting task must not enqueue it");

    const subtitles = [
      {
        id: "line-1",
        text: "Today I will teach you how to play Sirius.",
        start_time: 0,
        end_time: 2.125,
        confidence: 0.96,
        position: [10, 20, 300, 80],
        source: "ocr",
      },
    ];
    const saved = await request(app)
      .put(`/api/tasks/${created.body.id}/subtitles`)
      .set("If-Match", '"0"')
      .send({ subtitles })
      .expect(200);
    assert.equal(saved.body.subtitles[0].text, subtitles[0].text);

    const fetched = await request(app)
      .get(`/api/tasks/${created.body.id}/subtitles`)
      .expect(200);
    assert.equal(fetched.body.subtitles[0].end_time, 2.125);

    const exported = await request(app)
      .get(`/api/tasks/${created.body.id}/export`)
      .expect(200);
    const srt = exported.text ?? exported.body.toString("utf8");
    assert.match(exported.headers["content-disposition"], /filename="final\.srt"/);
    assert.match(srt, /00:00:00,000 --> 00:00:02,125/);
    assert.match(srt, /Today I will teach you/);
  });

  test("audio-only uploads skip ROI and visual analysis, then enqueue immediately", async () => {
    const created = await request(app)
      .post("/api/tasks")
      .field("analysis_mode", "audio")
      .attach("video", mp4Fixture(), { filename: "speech.mp4", contentType: "video/mp4" })
      .expect(201);

    assert.equal(created.body.analysis_mode, "audio");
    assert.equal(created.body.status, "queued");
    assert.equal(created.body.roi, null);
    assert.equal(created.body.visual_status, "skipped");
    assert.equal(created.body.visual_progress, 0);
    assert.equal(created.body.audio_status, "queued");
    assert.deepEqual(enqueued, [created.body.id]);

    const persisted = await store.findById(created.body.id);
    assert.equal(persisted.analysisMode, "audio");
    assert.equal(persisted.visualStatus, "skipped");
    assert.equal(persisted.audioStatus, "queued");

    const events = await request(app)
      .get(`/api/tasks/${created.body.id}/events`)
      .expect(409);
    assert.equal(events.body.error.code, "VISUAL_PROGRESS_NOT_APPLICABLE");

    const listed = await request(app).get("/api/tasks").expect(200);
    assert.equal(listed.body.tasks[0].analysis_mode, "audio");
    assert.equal(listed.body.tasks[0].visual_status, "skipped");
  });

  test("rejects an unknown analysis mode without persisting the upload", async () => {
    const response = await request(app)
      .post("/api/tasks")
      .field("analysis_mode", "visual")
      .attach("video", mp4Fixture(), { filename: "invalid.mp4", contentType: "video/mp4" })
      .expect(400);

    assert.equal(response.body.error.code, "INVALID_ANALYSIS_MODE");
    assert.equal((await store.list()).length, 0);
    assert.deepEqual(await fs.readdir(config.uploadDir), []);
    assert.deepEqual(enqueued, []);
  });

  test("returns visual and audio source tracks separately and exposes dual progress URLs", async () => {
    const created = await request(app)
      .post("/api/tasks")
      .attach("video", mp4Fixture(), { filename: "dual.mp4", contentType: "video/mp4" })
      .expect(201);
    const taskId = created.body.id;
    await store.update(taskId, {
      visualStatus: "completed",
      audioStatus: "processing",
      visualProgress: 100,
      audioProgress: 42,
      visualSubtitles: [{
        taskId,
        text: "WATCH OUT",
        start: 21.1,
        end: 21.4,
        bbox: [1, 2, 3, 4],
        confidence: 0.95,
      }],
      audioSubtitles: [{
        taskId,
        text: "watch out",
        start: 21.05,
        end: 21.4,
        words: [{ word: "watch", start: 21.05, end: 21.25, confidence: 0.9 }],
        confidence: 0.9,
      }],
    });

    const visual = await request(app)
      .get(`/api/tasks/${taskId}/visual-subtitles`)
      .expect(200);
    const audio = await request(app)
      .get(`/api/tasks/${taskId}/audio-subtitles`)
      .expect(200);
    assert.equal(visual.body.visual_subtitles[0].text, "WATCH OUT");
    assert.equal(audio.body.audio_subtitles[0].words[0].word, "watch");

    const detail = await request(app).get(`/api/tasks/${taskId}`).expect(200);
    assert.equal(detail.body.visual_status, "completed");
    assert.equal(detail.body.audio_status, "processing");
    assert.equal(detail.body.visual_progress, 100);
    assert.equal(detail.body.audio_progress, 42);
    assert.equal(detail.body.visual_subtitle_count, 1);
    assert.equal(detail.body.audio_subtitle_count, 1);
    assert.equal(detail.body.visual_subtitles_url, `/api/tasks/${taskId}/visual-subtitles`);
    assert.equal(detail.body.audio_subtitles_url, `/api/tasks/${taskId}/audio-subtitles`);
    assert.deepEqual(detail.body.subtitles, [], "source tracks must not become the FinalSubtitle track");
  });

  test("starts an awaiting task with a normalized ROI and enqueues it exactly once", async () => {
    const created = await request(app)
      .post("/api/tasks")
      .attach("video", mp4Fixture(), { filename: "roi.mp4", contentType: "video/mp4" })
      .expect(201);
    const roi = { x: 0.1, y: 0.62, width: 0.8, height: 0.22 };

    const started = await request(app)
      .post(`/api/tasks/${created.body.id}/start`)
      .send({ roi })
      .expect(202);

    assert.equal(started.body.status, "queued");
    assert.deepEqual(started.body.roi, roi);
    assert.equal(started.body.progress, 0);
    assert.equal(started.body.error, null);
    assert.deepEqual(enqueued, [created.body.id]);

    const conflict = await request(app)
      .post(`/api/tasks/${created.body.id}/start`)
      .send({ roi })
      .expect(409);
    assert.equal(conflict.body.error.code, "TASK_STATE_CONFLICT");
    assert.equal(conflict.body.error.details.status, "queued");
    assert.deepEqual(enqueued, [created.body.id]);

    const persisted = await store.findById(created.body.id);
    assert.equal(persisted.status, "queued");
    assert.deepEqual(persisted.roi, roi);
  });

  test("estimates ROI without starting the task, then reuses the original start flow", async () => {
    const roi = { x: 0.12, y: 0.7, width: 0.76, height: 0.16 };
    const estimateCalls = [];
    const aiClient = {
      async estimateRoi(task) {
        estimateCalls.push(task);
        return { success: true, roi };
      },
    };
    const autoApp = createApp({
      store,
      processor: { enqueue: processorEnqueue },
      artifactService,
      config,
      aiClient,
      progressEventHub: {},
    });
    function processorEnqueue(taskId) {
      enqueued.push(taskId);
      return true;
    }
    const created = await request(autoApp)
      .post("/api/tasks")
      .attach("video", mp4Fixture(), { filename: "auto-roi.mp4", contentType: "video/mp4" })
      .expect(201);

    const estimates = await Promise.all([
      request(autoApp).post(`/api/tasks/${created.body.id}/estimate-roi`).expect(200),
      request(autoApp).post(`/api/tasks/${created.body.id}/estimate-roi`).expect(200),
    ]);
    assert.deepEqual(estimates.map((response) => response.body), [
      { success: true, roi },
      { success: true, roi },
    ]);
    assert.equal(estimateCalls.length, 1);
    assert.equal(path.resolve(estimateCalls[0].videoPath), path.resolve((await store.findById(created.body.id)).videoPath));
    assert.equal((await store.findById(created.body.id)).status, "awaiting_roi");
    assert.equal((await store.findById(created.body.id)).roi, null);
    assert.deepEqual(enqueued, []);

    await request(autoApp)
      .post(`/api/tasks/${created.body.id}/start`)
      .send({ roi })
      .expect(202);
    assert.deepEqual(enqueued, [created.body.id]);

    const conflict = await request(autoApp)
      .post(`/api/tasks/${created.body.id}/estimate-roi`)
      .expect(409);
    assert.equal(conflict.body.error.code, "TASK_STATE_CONFLICT");
  });

  test("returns the no-subtitle result and preserves manual ROI fallback", async () => {
    const aiClient = {
      async estimateRoi() {
        return { success: false, reason: "no subtitle detected" };
      },
    };
    const manualProcessor = {
      enqueue(taskId) {
        enqueued.push(taskId);
      },
    };
    const autoApp = createApp({
      store,
      processor: manualProcessor,
      artifactService,
      config,
      aiClient,
      progressEventHub: {},
    });
    const created = await request(autoApp)
      .post("/api/tasks")
      .attach("video", mp4Fixture(), { filename: "no-subtitles.mp4", contentType: "video/mp4" })
      .expect(201);

    const estimated = await request(autoApp)
      .post(`/api/tasks/${created.body.id}/estimate-roi`)
      .expect(200);
    assert.deepEqual(estimated.body, {
      success: false,
      reason: "no subtitle detected",
    });
    assert.equal((await store.findById(created.body.id)).status, "awaiting_roi");

    const manualRoi = { x: 0.08, y: 0.52, width: 0.84, height: 0.24 };
    await request(autoApp)
      .post(`/api/tasks/${created.body.id}/start`)
      .send({ roi: manualRoi })
      .expect(202);
    assert.deepEqual((await store.findById(created.body.id)).roi, manualRoi);
    assert.deepEqual(enqueued, [created.body.id]);
  });

  test("rejects an estimate that becomes stale while another tab starts the task", async () => {
    let releaseEstimate;
    let markEstimateStarted;
    const estimateStarted = new Promise((resolve) => {
      markEstimateStarted = resolve;
    });
    const aiClient = {
      async estimateRoi() {
        markEstimateStarted();
        return new Promise((resolve) => {
          releaseEstimate = resolve;
        });
      },
    };
    const autoApp = createApp({
      store,
      processor: { enqueue: (taskId) => enqueued.push(taskId) },
      artifactService,
      config,
      aiClient,
      progressEventHub: {},
    });
    const created = await request(autoApp)
      .post("/api/tasks")
      .attach("video", mp4Fixture(), { filename: "two-tabs.mp4", contentType: "video/mp4" })
      .expect(201);
    const pendingEstimate = request(autoApp)
      .post(`/api/tasks/${created.body.id}/estimate-roi`)
      .then((response) => response);
    await estimateStarted;

    const manualRoi = { x: 0.08, y: 0.52, width: 0.84, height: 0.24 };
    await request(autoApp)
      .post(`/api/tasks/${created.body.id}/start`)
      .send({ roi: manualRoi })
      .expect(202);
    releaseEstimate({
      success: true,
      roi: { x: 0.12, y: 0.7, width: 0.76, height: 0.16 },
    });

    const stale = await pendingEstimate;
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "TASK_STATE_CONFLICT");
    assert.equal(stale.body.error.details.status, "queued");
    assert.deepEqual((await store.findById(created.body.id)).roi, manualRoi);
  });

  test("rejects invalid or failed upstream estimates without mutating the task", async () => {
    const responses = [
      { success: true, roi: { x: 0.9, y: 0.8, width: 0.3, height: 0.3 } },
      new Error("AI offline"),
    ];
    const aiClient = {
      async estimateRoi() {
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return response;
      },
    };
    const autoApp = createApp({
      store,
      processor: { enqueue: (taskId) => enqueued.push(taskId) },
      artifactService,
      config,
      aiClient,
      progressEventHub: {},
    });
    for (const filename of ["invalid-estimate.mp4", "failed-estimate.mp4"]) {
      const created = await request(autoApp)
        .post("/api/tasks")
        .attach("video", mp4Fixture(), { filename, contentType: "video/mp4" })
        .expect(201);
      await request(autoApp)
        .post(`/api/tasks/${created.body.id}/estimate-roi`)
        .expect(502);
      assert.equal((await store.findById(created.body.id)).status, "awaiting_roi");
      assert.equal((await store.findById(created.body.id)).roi, null);
    }
    assert.deepEqual(enqueued, []);
  });

  test("validates every ROI coordinate, minimum size, and video bounds before starting", async () => {
    const invalidRois = [
      undefined,
      null,
      [],
      { x: "0.1", y: 0, width: 0.5, height: 0.5 },
      { x: null, y: 0, width: 0.5, height: 0.5 },
      { x: -0.1, y: 0, width: 0.5, height: 0.5 },
      { x: 0, y: 1.1, width: 0.5, height: 0.5 },
      { x: 0, y: 0, width: 0.009, height: 0.5 },
      { x: 0, y: 0, width: 0.5, height: 0.009 },
      { x: 0.75, y: 0, width: 0.3, height: 0.5 },
      { x: 0, y: 0.75, width: 0.5, height: 0.3 },
    ];

    for (const roi of invalidRois) {
      const created = await request(app)
        .post("/api/tasks")
        .attach("video", mp4Fixture(), { filename: "invalid-roi.mp4", contentType: "video/mp4" })
        .expect(201);
      const response = await request(app)
        .post(`/api/tasks/${created.body.id}/start`)
        .send(roi === undefined ? {} : { roi })
        .expect(400);
      assert.equal(response.body.error.code, "INVALID_ROI");
      assert.equal((await store.findById(created.body.id)).status, "awaiting_roi");
    }
    assert.deepEqual(enqueued, []);
  });

  test("uses an atomic awaiting-to-queued transition for concurrent start requests", async () => {
    const created = await request(app)
      .post("/api/tasks")
      .attach("video", mp4Fixture(), { filename: "concurrent.mp4", contentType: "video/mp4" })
      .expect(201);
    const roi = { x: 0, y: 0.5, width: 1, height: 0.5 };

    const responses = await Promise.all([
      request(app).post(`/api/tasks/${created.body.id}/start`).send({ roi }),
      request(app).post(`/api/tasks/${created.body.id}/start`).send({ roi }),
    ]);

    assert.deepEqual(responses.map((response) => response.status).sort(), [202, 409]);
    assert.deepEqual(enqueued, [created.body.id]);
  });

  test("streams complete and ranged MP4 responses", async () => {
    const video = mp4Fixture();
    const created = await request(app)
      .post("/api/tasks")
      .attach("video", video, { filename: "range.mp4", contentType: "video/mp4" })
      .expect(201);

    const full = await request(app).get(`/api/tasks/${created.body.id}/video`).expect(200);
    assert.equal(Number(full.headers["content-length"]), video.length);
    assert.equal(full.headers["accept-ranges"], "bytes");

    const partial = await request(app)
      .get(`/api/tasks/${created.body.id}/video`)
      .set("Range", "bytes=4-11")
      .expect(206);
    assert.equal(partial.headers["content-range"], `bytes 4-11/${video.length}`);
    assert.equal(partial.body.toString("ascii"), "ftypisom");

    await request(app)
      .get(`/api/tasks/${created.body.id}/video`)
      .set("Range", `bytes=${video.length + 1}-`)
      .expect(416)
      .expect("Content-Range", `bytes */${video.length}`);
  });

  test("rejects absent, mislabeled, forged and oversized uploads", async () => {
    await request(app).post("/api/tasks").expect(400);

    await request(app)
      .post("/api/tasks")
      .attach("video", mp4Fixture(), { filename: "demo.txt", contentType: "text/plain" })
      .expect(415);

    await request(app)
      .post("/api/tasks")
      .attach("video", Buffer.from("not an mp4"), { filename: "fake.mp4", contentType: "video/mp4" })
      .expect(415);

    const smallConfig = { ...config, maxUploadBytes: 8 };
    const processor = { enqueue() {} };
    const smallApp = createApp({ store, processor, artifactService, config: smallConfig });
    await request(smallApp)
      .post("/api/tasks")
      .attach("video", mp4Fixture(), { filename: "large.mp4", contentType: "video/mp4" })
      .expect(413);
  });

  test("validates task ids and subtitle timing", async () => {
    await request(app).get("/api/tasks/not-an-id").expect(400);

    const created = await request(app)
      .post("/api/tasks")
      .attach("video", mp4Fixture(), { filename: "demo.mp4", contentType: "video/mp4" })
      .expect(201);

    await request(app)
      .put(`/api/tasks/${created.body.id}/subtitles`)
      .set("If-Match", '"0"')
      .send({ subtitles: [{ text: "bad", start_time: 5, end_time: 2 }] })
      .expect(400);
  });

  test("returns lightweight paginated summaries and archives without deleting artifacts", async () => {
    const first = await request(app)
      .post("/api/tasks")
      .attach("video", mp4Fixture(), { filename: "search-first.mp4", contentType: "video/mp4" })
      .expect(201);
    const second = await request(app)
      .post("/api/tasks")
      .attach("video", mp4Fixture(), { filename: "other.mp4", contentType: "video/mp4" })
      .expect(201);

    const listed = await request(app).get("/api/tasks?limit=1&page=1&status=awaiting_roi&search=search").expect(200);
    assert.equal(listed.body.tasks.length, 1);
    assert.equal(listed.body.tasks[0].id, first.body.id);
    assert.equal("subtitles" in listed.body.tasks[0], false);
    assert.deepEqual(listed.body.pagination, { page: 1, limit: 1, total: 1, pages: 1 });

    const storedBeforeArchive = await store.findById(first.body.id);
    await request(app).patch(`/api/tasks/${first.body.id}/archive`).expect(200);
    const afterArchive = await request(app).get("/api/tasks?limit=100").expect(200);
    assert.equal(afterArchive.body.tasks.some((task) => task.id === first.body.id), false);
    assert.equal(afterArchive.body.tasks.some((task) => task.id === second.body.id), true);
    await request(app).get(`/api/tasks/${first.body.id}`).expect(200);
    assert.equal((await fs.stat(storedBeforeArchive.videoPath)).isFile(), true);
  });

  test("uses subtitle revisions to reject stale writes from a second tab", async () => {
    const created = await request(app)
      .post("/api/tasks")
      .attach("video", mp4Fixture(), { filename: "conflict.mp4", contentType: "video/mp4" })
      .expect(201);
    const endpoint = `/api/tasks/${created.body.id}/subtitles`;
    const firstVersion = [{ id: "one", text: "first tab", start_time: 0, end_time: 1 }];
    const staleVersion = [{ id: "two", text: "second tab stale", start_time: 0, end_time: 1 }];

    const saved = await request(app).put(endpoint).set("If-Match", '"0"').send({ subtitles: firstVersion }).expect(200);
    assert.equal(saved.body.revision, 1);
    const conflict = await request(app).put(endpoint).set("If-Match", '"0"').send({ subtitles: staleVersion }).expect(409);
    assert.equal(conflict.body.error.code, "REVISION_CONFLICT");
    assert.equal(conflict.body.error.details.revision, 1);
    const current = await request(app).get(endpoint).expect(200);
    assert.equal(current.body.subtitles[0].text, "first tab");
    assert.equal(current.body.revision, 1);
  });

  test("reports health and JSON persistence mode", async () => {
    const response = await request(app).get("/api/health").expect(200);
    assert.deepEqual(response.body, { status: "ok", persistence: "file" });
  });
});
