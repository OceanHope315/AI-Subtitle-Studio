import assert from "node:assert/strict";
import http from "node:http";
import { Readable } from "node:stream";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../app.js";
import { taskToDto, taskToSummaryDto } from "../utils/taskDto.js";

const TASK_ID = "00000000-0000-4000-8000-000000000010";
const RUN_ID = "0123456789abcdef0123456789abcdef";
const OLD_RUN_ID = "abcdef0123456789abcdef0123456789";
const PREVIEW_ID = "11111111111111111111111111111111";

function event(seq, type = "stage.progress", runId = RUN_ID) {
  return {
    seq,
    task_id: TASK_ID,
    run_id: runId,
    type,
    occurred_at: `2026-07-17T00:00:0${seq}Z`,
    payload: { overall_progress: seq * 10 },
  };
}

function testApp(aiClient, { taskStatus = "processing", heartbeatMs = 15 } = {}) {
  const task = {
    id: TASK_ID,
    filename: "fixture.mp4",
    status: taskStatus,
    progress: 20,
    message: "analyzing",
    metadata: {},
    subtitles: [],
    revision: 0,
    artifacts: {},
  };
  const store = {
    mode: "test",
    async findById(id) {
      return id === TASK_ID ? structuredClone(task) : null;
    },
    async listSummaries() {
      return { tasks: [structuredClone(task)], total: 1 };
    },
  };
  const processor = {
    enqueueCalls: [],
    cancelCalls: [],
    enqueue(id) {
      this.enqueueCalls.push(id);
      return true;
    },
    cancel(id) {
      this.cancelCalls.push(id);
    },
  };
  const config = {
    corsOrigin: "*",
    jsonLimit: "1mb",
    uploadDir: process.cwd(),
    maxUploadBytes: 1024,
    aiEventPollIntervalMs: 10,
    sseHeartbeatMs: heartbeatMs,
    sseRetryMs: 25,
  };
  const app = createApp({
    store,
    processor,
    artifactService: {},
    config,
    aiClient,
  });
  return { app, processor };
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function openSse(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (response) => {
      response.setEncoding("utf8");
      let body = "";
      let ended = false;
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.once("end", () => { ended = true; });
      resolve({ req, response, body: () => body, ended: () => ended });
    });
    req.once("error", reject);
  });
}

async function waitFor(predicate, message, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("SSE sets streaming headers, restores across a new run, deduplicates, and heartbeats", async (context) => {
  const calls = [];
  const available = [event(1), event(2, "frame.analyzed")];
  const aiClient = {
    async getEvents(taskId, afterSeq) {
      assert.equal(taskId, TASK_ID);
      calls.push(afterSeq);
      const events = available.filter((item) => item.seq > afterSeq);
      if (events.some((item) => item.seq === 2)) events.push(event(2, "frame.analyzed"));
      return { task_id: TASK_ID, run_id: RUN_ID, latest_seq: 2, events };
    },
    async getPreview() {
      throw new Error("not used");
    },
  };
  const { app, processor } = testApp(aiClient);
  const { server, baseUrl } = await listen(app);
  context.after(async () => {
    app.locals.progressEventHub.close();
    await closeServer(server);
  });

  const stream = await openSse(`${baseUrl}/api/tasks/${TASK_ID}/events`, {
    "Last-Event-ID": `${OLD_RUN_ID}:9`,
  });
  assert.equal(stream.response.statusCode, 200);
  assert.match(stream.response.headers["content-type"], /^text\/event-stream/);
  assert.equal(stream.response.headers["cache-control"], "no-cache, no-transform");
  assert.equal(stream.response.headers.connection, "keep-alive");
  assert.equal(stream.response.headers["x-accel-buffering"], "no");

  await waitFor(
    () => stream.body().includes(`id: ${RUN_ID}:2`) && stream.body().includes(": heartbeat "),
    "expected replayed events and an SSE heartbeat",
  );
  assert.deepEqual(calls.slice(0, 2), [9, 0], "a cursor from an old run must replay the new run from zero");
  assert.equal((stream.body().match(new RegExp(`id: ${RUN_ID}:2`, "g")) || []).length, 1);
  assert.match(stream.body(), /event: frame\.analyzed/);
  assert.match(stream.body(), /data: \{"seq":2/);
  assert.deepEqual(processor.enqueueCalls, [TASK_ID]);

  stream.req.destroy();
  stream.response.destroy();
  await waitFor(
    () => app.locals.progressEventHub.subscriberCount(TASK_ID) === 0,
    "SSE subscriber was not released after disconnect",
  );
  assert.deepEqual(processor.cancelCalls, [], "disconnecting SSE must not cancel task processing");
});

test("SSE accepts numeric after_seq and pure-sequence Last-Event-ID cursors", async (context) => {
  const calls = [];
  const aiClient = {
    async getEvents(_taskId, afterSeq) {
      calls.push(afterSeq);
      return {
        task_id: TASK_ID,
        run_id: RUN_ID,
        latest_seq: 2,
        events: [event(1), event(2)].filter((item) => item.seq > afterSeq),
      };
    },
    async getPreview() {},
  };
  const { app } = testApp(aiClient, { taskStatus: "completed", heartbeatMs: 1000 });
  const { server, baseUrl } = await listen(app);
  context.after(async () => {
    app.locals.progressEventHub.close();
    await closeServer(server);
  });

  const first = await openSse(
    `${baseUrl}/api/tasks/${TASK_ID}/events?after_seq=1&run_id=${RUN_ID}`,
  );
  await waitFor(() => first.body().includes(`id: ${RUN_ID}:2`), "after_seq replay failed");
  first.req.destroy();
  first.response.destroy();
  await waitFor(() => app.locals.progressEventHub.subscriberCount(TASK_ID) === 0, "first stream leaked");

  const second = await openSse(`${baseUrl}/api/tasks/${TASK_ID}/events?run_id=${RUN_ID}`, {
    "Last-Event-ID": "1",
  });
  await waitFor(() => second.body().includes(`id: ${RUN_ID}:2`), "numeric Last-Event-ID replay failed");
  second.req.destroy();
  second.response.destroy();
  assert.equal(calls.filter((value) => value === 1).length >= 2, true);
  await waitFor(() => app.locals.progressEventHub.subscriberCount(TASK_ID) === 0, "second stream leaked");

  const third = await openSse(`${baseUrl}/api/tasks/${TASK_ID}/events`, {
    "Last-Event-ID": `${RUN_ID}:9`,
  });
  await waitFor(() => third.body().includes(`id: ${RUN_ID}:2`), "ahead cursor recovery failed");
  third.req.destroy();
  third.response.destroy();
  assert.deepEqual(calls.slice(-2), [9, 0]);
});

test("SSE tolerates a queued null run and immediately drains has_more batches", async (context) => {
  const calls = [];
  let pending = true;
  const aiClient = {
    async getEvents(_taskId, afterSeq) {
      calls.push(afterSeq);
      if (pending) {
        pending = false;
        return { task_id: TASK_ID, run_id: null, latest_seq: 0, events: [], has_more: false };
      }
      if (afterSeq === 0) {
        return {
          task_id: TASK_ID,
          run_id: RUN_ID,
          latest_seq: 2,
          events: [event(1)],
          has_more: true,
        };
      }
      return {
        task_id: TASK_ID,
        run_id: RUN_ID,
        latest_seq: 2,
        events: [event(2)],
        has_more: false,
      };
    },
    async getPreview() {},
  };
  const { app } = testApp(aiClient, { heartbeatMs: 1000 });
  const { server, baseUrl } = await listen(app);
  context.after(async () => {
    app.locals.progressEventHub.close();
    await closeServer(server);
  });
  const stream = await openSse(`${baseUrl}/api/tasks/${TASK_ID}/events`);
  await waitFor(() => stream.body().includes(`id: ${RUN_ID}:2`), "batched replay did not drain");
  assert.deepEqual(calls.slice(0, 3), [0, 0, 1]);
  let ended = false;
  stream.response.once("end", () => { ended = true; });
  app.locals.progressEventHub.close();
  await waitFor(() => ended, "closing the event hub did not end the browser stream");
  assert.equal(app.locals.progressEventHub.subscriberCount(TASK_ID), 0);
});

test("disconnect aborts an in-flight upstream event request and removes its channel", async (context) => {
  let upstreamAborted = false;
  let pollStarted = false;
  const aiClient = {
    getEvents(_taskId, _afterSeq, { signal }) {
      pollStarted = true;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          upstreamAborted = true;
          const error = new Error("aborted");
          error.code = "ERR_CANCELED";
          reject(error);
        }, { once: true });
      });
    },
    async getPreview() {},
  };
  const { app } = testApp(aiClient, { heartbeatMs: 1000 });
  const { server, baseUrl } = await listen(app);
  context.after(async () => {
    app.locals.progressEventHub.close();
    await closeServer(server);
  });
  const stream = await openSse(`${baseUrl}/api/tasks/${TASK_ID}/events`);
  await waitFor(() => pollStarted, "event poll did not start");
  stream.req.destroy();
  stream.response.destroy();
  await waitFor(
    () => upstreamAborted && app.locals.progressEventHub.subscriberCount(TASK_ID) === 0,
    "disconnect did not abort and clean the event channel",
  );
});

test("an upstream poll failure ends SSE so the client can reconnect without canceling the task", async (context) => {
  let pollCalls = 0;
  const aiClient = {
    async getEvents() {
      pollCalls += 1;
      throw new Error("upstream unavailable");
    },
    async getPreview() {},
  };
  const { app, processor } = testApp(aiClient, { heartbeatMs: 1000 });
  const { server, baseUrl } = await listen(app);
  context.after(async () => {
    app.locals.progressEventHub.close();
    await closeServer(server);
  });

  const stream = await openSse(`${baseUrl}/api/tasks/${TASK_ID}/events`);
  await waitFor(
    () => stream.ended() && app.locals.progressEventHub.subscriberCount(TASK_ID) === 0,
    "upstream failure did not end and release the browser stream",
  );
  assert.equal(pollCalls, 1, "a released stream must not keep polling upstream");
  assert.deepEqual(processor.cancelCalls, [], "an SSE poll failure must not cancel task processing");
});

test("SSE write backpressure ends and releases the stream without canceling the task", async (context) => {
  let pollCalls = 0;
  const oversizedEvent = event(1, "frame.analyzed");
  oversizedEvent.payload = { blob: "x".repeat(512 * 1024) };
  const aiClient = {
    async getEvents() {
      pollCalls += 1;
      return {
        task_id: TASK_ID,
        run_id: RUN_ID,
        latest_seq: 1,
        events: [oversizedEvent],
        has_more: false,
      };
    },
    async getPreview() {},
  };
  const { app, processor } = testApp(aiClient, { heartbeatMs: 1000 });
  const { server, baseUrl } = await listen(app);
  context.after(async () => {
    app.locals.progressEventHub.close();
    await closeServer(server);
  });

  const stream = await openSse(`${baseUrl}/api/tasks/${TASK_ID}/events`);
  await waitFor(
    () => stream.ended() && app.locals.progressEventHub.subscriberCount(TASK_ID) === 0,
    "backpressure did not end and release the browser stream",
  );
  assert.match(stream.body(), new RegExp(`id: ${RUN_ID}:1`));
  assert.equal(pollCalls, 1, "a backpressured stream must not keep polling upstream");
  assert.deepEqual(processor.cancelCalls, [], "SSE backpressure must not cancel task processing");
});

test("multiple browser subscribers share one upstream task poll and both receive the broadcast", async (context) => {
  let resolvePoll;
  let pollCalls = 0;
  const aiClient = {
    getEvents() {
      pollCalls += 1;
      return new Promise((resolve) => { resolvePoll = resolve; });
    },
    async getPreview() {},
  };
  const { app } = testApp(aiClient, { heartbeatMs: 1000 });
  const { server, baseUrl } = await listen(app);
  context.after(async () => {
    app.locals.progressEventHub.close();
    await closeServer(server);
  });
  const first = await openSse(`${baseUrl}/api/tasks/${TASK_ID}/events`);
  const second = await openSse(`${baseUrl}/api/tasks/${TASK_ID}/events`);
  await waitFor(
    () => pollCalls === 1 && app.locals.progressEventHub.subscriberCount(TASK_ID) === 2,
    "browser connections did not coalesce onto one upstream poll",
  );
  resolvePoll({
    task_id: TASK_ID,
    run_id: RUN_ID,
    latest_seq: 1,
    events: [event(1)],
    has_more: false,
  });
  await waitFor(
    () => first.body().includes(`id: ${RUN_ID}:1`) && second.body().includes(`id: ${RUN_ID}:1`),
    "event was not broadcast to every subscriber",
  );
  first.req.destroy();
  first.response.destroy();
  second.req.destroy();
  second.response.destroy();
});

test("preview endpoint validates opaque ids and proxies a complete immutable JPEG", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  const previewCalls = [];
  const aiClient = {
    async getEvents() {
      return { task_id: TASK_ID, run_id: RUN_ID, latest_seq: 0, events: [] };
    },
    async getPreview(taskId, previewId, runId) {
      previewCalls.push({ taskId, previewId, runId });
      return {
        headers: { "content-type": "image/jpeg", "content-length": String(jpeg.length) },
        data: Readable.from(jpeg),
      };
    },
  };
  const { app } = testApp(aiClient);

  const response = await request(app)
    .get(`/api/tasks/${TASK_ID}/previews/${PREVIEW_ID}?run_id=${RUN_ID}`)
    .set("Range", "bytes=1-2")
    .expect(200);
  assert.equal(response.headers["content-type"], "image/jpeg");
  assert.equal(response.headers["content-length"], String(jpeg.length));
  assert.equal(response.headers["accept-ranges"], "none");
  assert.equal(response.headers["cache-control"], "private, max-age=300, immutable");
  assert.deepEqual(response.body, jpeg, "preview range requests intentionally return the complete JPEG");
  assert.deepEqual(previewCalls, [{ taskId: TASK_ID, previewId: PREVIEW_ID, runId: RUN_ID }]);

  await request(app).get(`/api/tasks/not-a-task/events`).expect(400);
  await request(app)
    .get(`/api/tasks/${TASK_ID}/events?after_seq=-1`)
    .expect(400);
  await request(app)
    .get(`/api/tasks/${TASK_ID}/events?run_id=${RUN_ID}`)
    .set("Last-Event-ID", "not-a-cursor")
    .expect(400);
  await request(app)
    .get(`/api/tasks/${TASK_ID}/events?run_id=${OLD_RUN_ID}`)
    .set("Last-Event-ID", `${RUN_ID}:1`)
    .expect(400);
  await request(app)
    .get(`/api/tasks/${TASK_ID}/previews/not-a-preview?run_id=${RUN_ID}`)
    .expect(400);
  await request(app)
    .get(`/api/tasks/${TASK_ID}/previews/${PREVIEW_ID}`)
    .expect(400);
  await request(app)
    .get(`/api/tasks/${TASK_ID}/previews/${PREVIEW_ID}?run_id=${RUN_ID.toUpperCase()}`)
    .expect(400);
  await request(app)
    .get(`/api/tasks/${TASK_ID}/previews/%2E%2E%5Csecret?run_id=${RUN_ID}`)
    .expect(400);
  assert.equal(previewCalls.length, 1, "invalid or traversal-like ids must never reach the AI service");
  app.locals.progressEventHub.close();
});

test("preview association failures are hidden as a stable 404", async () => {
  const aiClient = {
    async getEvents() {
      return { task_id: TASK_ID, run_id: RUN_ID, latest_seq: 0, events: [] };
    },
    async getPreview() {
      const error = new Error("not associated");
      error.response = { status: 404 };
      throw error;
    },
  };
  const { app } = testApp(aiClient);
  const response = await request(app)
    .get(`/api/tasks/${TASK_ID}/previews/${PREVIEW_ID}?run_id=${RUN_ID}`)
    .expect(404);
  assert.equal(response.body.error.code, "PREVIEW_NOT_FOUND");
  app.locals.progressEventHub.close();
});

test("task detail exposes only the latest progress snapshot, never event history", () => {
  const latestFrameEvent = event(6, "frame.analyzed");
  const latestPreviewEvent = event(5, "frame.analyzed");
  latestPreviewEvent.payload.preview_id = PREVIEW_ID;
  const latestEvent = event(7, "stage.progress");
  const task = {
    id: TASK_ID,
    filename: "fixture.mp4",
    status: "processing",
    progress: 45,
    message: "OCR",
    metadata: {},
    subtitles: [],
    events: [event(1), event(2), latestEvent],
    progressSnapshot: {
      run_id: RUN_ID,
      latest_seq: 7,
      latest_event: latestEvent,
      latest_frame_event: latestFrameEvent,
      latest_preview_event: latestPreviewEvent,
    },
  };
  const detail = taskToDto(task);
  assert.equal("events" in detail, false);
  assert.equal(detail.progress_snapshot.latest_seq, 7);
  assert.equal(detail.latest_event.type, "stage.progress");
  assert.equal(detail.latest_frame_event.type, "frame.analyzed");
  assert.equal(detail.progress_snapshot.latest_frame_event.seq, 6);
  assert.equal(detail.latest_preview_event.seq, 5);
  assert.equal(detail.progress_snapshot.latest_preview_event.payload.preview_id, PREVIEW_ID);
  assert.equal(detail.events_url, `/api/tasks/${TASK_ID}/events`);
  const summary = taskToSummaryDto(task);
  assert.equal("events" in summary, false);
  assert.equal("progress_snapshot" in summary, false);
});
