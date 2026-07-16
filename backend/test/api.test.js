import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import request from "supertest";
import { createApp } from "../app.js";
import { validateRoi } from "../routes/tasks.js";
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
      .send({ subtitles: [{ text: "bad", start_time: 5, end_time: 2 }] })
      .expect(400);
  });

  test("reports health and JSON persistence mode", async () => {
    const response = await request(app).get("/api/health").expect(200);
    assert.deepEqual(response.body, { status: "ok", persistence: "file" });
  });
});
