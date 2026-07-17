import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { AiClient } from "./services/aiClient.js";
import { SubtitleArtifactService } from "./services/subtitleService.js";
import { createTaskStore } from "./services/taskStore.js";
import { TaskProcessor } from "./services/taskProcessor.js";

dotenv.config();

export async function startServer() {
  const config = loadConfig();
  await Promise.all([
    fs.mkdir(config.uploadDir, { recursive: true }),
    fs.mkdir(config.subtitleDir, { recursive: true }),
  ]);

  const store = await createTaskStore(config);
  const artifactService = new SubtitleArtifactService(config.subtitleDir);
  const aiClient = new AiClient({ baseUrl: config.aiServiceUrl, timeoutMs: config.aiRequestTimeoutMs });
  const processor = new TaskProcessor({ store, aiClient, artifactService, config });
  const app = createApp({ store, processor, artifactService, config, aiClient });

  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(config.port, config.host, () => resolve(listener));
    listener.once("error", reject);
  });

  console.log(`AI Subtitle Studio backend listening at http://${config.host}:${config.port}`);
  console.log(`AI service: ${config.aiServiceUrl}`);
  await processor.resumePending();

  let closing = false;
  async function shutdown(signal) {
    if (closing) return;
    closing = true;
    console.log(`${signal} received; shutting down backend...`);
    app.locals.progressEventHub?.close();
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  }
  process.once("SIGINT", () => shutdown("SIGINT").finally(() => process.exit(0)));
  process.once("SIGTERM", () => shutdown("SIGTERM").finally(() => process.exit(0)));

  return { app, server, store, processor, config, shutdown };
}

const entryFile = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryFile) {
  startServer().catch((error) => {
    console.error("Failed to start backend:", error);
    process.exitCode = 1;
  });
}
