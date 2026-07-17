import express from "express";
import cors from "cors";
import helmet from "helmet";
import { createTasksRouter } from "./routes/tasks.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { ProgressEventHub } from "./services/progressEventHub.js";
import { AppError } from "./utils/errors.js";

function corsOptions(originSetting) {
  if (originSetting.trim() === "*") return { origin: "*" };
  const allowed = new Set(originSetting.split(",").map((item) => item.trim()).filter(Boolean));
  return {
    origin(origin, callback) {
      if (!origin || allowed.has(origin)) callback(null, true);
      else callback(new AppError(403, "Origin is not allowed by CORS policy", "CORS_FORBIDDEN"));
    },
  };
}

export function createApp({
  store,
  processor,
  artifactService,
  config,
  aiClient = processor?.aiClient || null,
  progressEventHub = null,
}) {
  const app = express();
  const eventHub = progressEventHub || (aiClient
    ? new ProgressEventHub({ aiClient, pollIntervalMs: config.aiEventPollIntervalMs })
    : null);
  app.locals.progressEventHub = eventHub;
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(cors(corsOptions(config.corsOrigin)));
  app.use(express.json({ limit: config.jsonLimit }));

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", persistence: store.mode });
  });
  app.use("/api/tasks", createTasksRouter({
    store,
    processor,
    artifactService,
    config,
    aiClient,
    progressEventHub: eventHub,
  }));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
