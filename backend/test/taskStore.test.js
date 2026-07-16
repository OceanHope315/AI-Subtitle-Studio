import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createTaskStore, FileTaskStore } from "../services/taskStore.js";

test("an unavailable configured MongoDB explicitly falls back to the JSON store", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "subtitle-store-fallback-"));
  context.after(async () => fs.rm(directory, { recursive: true, force: true }));
  const warnings = [];
  const store = await createTaskStore(
    {
      mongodbUri: "mongodb://127.0.0.1:1/definitely_unavailable",
      mongodbDbName: undefined,
      mongodbConnectTimeoutMs: 50,
      mongodbFallbackToFile: true,
      fileDbPath: path.join(directory, "tasks.json"),
    },
    {
      info() {},
      warn(message) {
        warnings.push(message);
      },
    },
  );
  assert.equal(store.mode, "file");
  assert.match(warnings.join("\n"), /falling back to JSON file persistence/i);
  await store.close();
  const database = JSON.parse(await fs.readFile(path.join(directory, "tasks.json"), "utf8"));
  assert.deepEqual(database.tasks, []);
});

test("file store atomically starts an awaiting task only once and persists its ROI", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "subtitle-store-start-"));
  context.after(async () => fs.rm(directory, { recursive: true, force: true }));
  const storePath = path.join(directory, "tasks.json");
  const store = await new FileTaskStore(storePath).initialize();
  const id = "00000000-0000-4000-8000-000000000010";
  await store.create({
    id,
    filename: "video.mp4",
    storedFilename: "video.mp4",
    videoPath: path.join(directory, "video.mp4"),
    status: "awaiting_roi",
    roi: null,
    progress: 0,
    message: "choose ROI",
    error: "stale error",
  });
  const roi = { x: 0.1, y: 0.6, width: 0.8, height: 0.25 };

  const results = await Promise.all([
    store.startTask(id, roi),
    store.startTask(id, roi),
  ]);

  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.filter((value) => value === null).length, 1);
  const started = await store.findById(id);
  assert.equal(started.status, "queued");
  assert.deepEqual(started.roi, roi);
  assert.equal(started.error, null);
  await store.close();

  const reopened = await new FileTaskStore(storePath).initialize();
  assert.deepEqual((await reopened.findById(id)).roi, roi);
  await reopened.close();
});
