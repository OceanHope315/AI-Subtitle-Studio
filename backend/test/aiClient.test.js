import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import multer from "multer";
import { AiClient } from "../services/aiClient.js";

test("AI client submits multipart video and polls the returned task", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "subtitle-ai-client-"));
  const videoPath = path.join(directory, "video.mp4");
  const video = Buffer.from("test-video-payload");
  await fs.writeFile(videoPath, video);

  const app = express();
  const upload = multer({ storage: multer.memoryStorage() });
  app.post("/jobs", upload.single("video"), (req, res) => {
    assert.equal(req.body.task_id, "00000000-0000-4000-8000-000000000002");
    assert.equal(req.body.roi_x, "0.1");
    assert.equal(req.body.roi_y, "0.62");
    assert.equal(req.body.roi_width, "0.8");
    assert.equal(req.body.roi_height, "0.22");
    assert.equal(req.file.originalname, "source.mp4");
    assert.deepEqual(req.file.buffer, video);
    res.status(202).json({ task_id: req.body.task_id, status: "queued", progress: 0 });
  });
  app.get("/jobs/:id", (req, res) => {
    res.json({ task_id: req.params.id, status: "completed", progress: 100, subtitles: [] });
  });
  app.get("/jobs/:id/events", (req, res) => {
    assert.equal(req.params.id, "00000000-0000-4000-8000-000000000002");
    assert.equal(req.query.after_seq, "12");
    res.json({
      task_id: req.params.id,
      run_id: "0123456789abcdef0123456789abcdef",
      latest_seq: 12,
      events: [],
    });
  });
  app.get("/jobs/:id/previews/:previewId", (req, res) => {
    assert.equal(req.params.previewId, "11111111111111111111111111111111");
    assert.equal(req.query.run_id, "0123456789abcdef0123456789abcdef");
    res.type("image/jpeg").send(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const address = server.address();
  const client = new AiClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 5000 });
  const task = {
    id: "00000000-0000-4000-8000-000000000002",
    filename: "source.mp4",
    videoPath,
    metadata: { size: video.length },
    roi: { x: 0.1, y: 0.62, width: 0.8, height: 0.22 },
  };

  const submitted = await client.createJob(task);
  assert.equal(submitted.status, "queued");
  const completed = await client.getJob(task.id);
  assert.equal(completed.status, "completed");
  const events = await client.getEvents(task.id, 12);
  assert.equal(events.run_id, "0123456789abcdef0123456789abcdef");
  assert.deepEqual(events.events, []);
  const preview = await client.getPreview(
    task.id,
    "11111111111111111111111111111111",
    "0123456789abcdef0123456789abcdef",
  );
  const chunks = [];
  for await (const chunk of preview.data) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
});
