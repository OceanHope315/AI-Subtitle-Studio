import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = path.dirname(fileURLToPath(import.meta.url));

function positiveNumber(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function positiveInteger(value, fallback, name) {
  const parsed = positiveNumber(value, fallback, name);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function booleanValue(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function absolutePath(value, fallback) {
  return path.resolve(value || fallback);
}

export function loadConfig(env = process.env) {
  const dataDir = absolutePath(env.DATA_DIR, path.join(backendDir, "..", "data"));
  const maxUploadMb = positiveNumber(env.MAX_UPLOAD_MB, 1024, "MAX_UPLOAD_MB");
  const aiServiceUrl = String(env.AI_SERVICE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");

  let parsedAiUrl;
  try {
    parsedAiUrl = new URL(aiServiceUrl);
  } catch {
    throw new Error("AI_SERVICE_URL must be a valid URL");
  }
  if (!["http:", "https:"].includes(parsedAiUrl.protocol)) {
    throw new Error("AI_SERVICE_URL must use http or https");
  }

  return {
    env: env.NODE_ENV || "development",
    host: env.HOST || "0.0.0.0",
    port: positiveInteger(env.PORT, 3001, "PORT"),
    corsOrigin: env.CORS_ORIGIN || "http://localhost:5173,http://127.0.0.1:5173",
    jsonLimit: env.JSON_LIMIT || "10mb",
    dataDir,
    uploadDir: absolutePath(env.UPLOAD_DIR, path.join(dataDir, "videos")),
    subtitleDir: absolutePath(env.SUBTITLE_DIR, path.join(dataDir, "subtitles")),
    fileDbPath: absolutePath(env.FILE_DB_PATH, path.join(dataDir, "tasks.json")),
    maxUploadBytes: Math.floor(maxUploadMb * 1024 * 1024),
    mongodbUri: env.MONGODB_URI?.trim() || null,
    mongodbDbName: env.MONGODB_DB_NAME?.trim() || undefined,
    mongodbConnectTimeoutMs: positiveInteger(
      env.MONGODB_CONNECT_TIMEOUT_MS,
      3000,
      "MONGODB_CONNECT_TIMEOUT_MS",
    ),
    mongodbFallbackToFile: booleanValue(env.MONGODB_FALLBACK_TO_FILE, true),
    aiServiceUrl,
    aiRequestTimeoutMs: positiveInteger(env.AI_REQUEST_TIMEOUT_MS, 120000, "AI_REQUEST_TIMEOUT_MS"),
    aiPollIntervalMs: positiveInteger(env.AI_POLL_INTERVAL_MS, 2000, "AI_POLL_INTERVAL_MS"),
    aiPollMaxAttempts: positiveInteger(env.AI_POLL_MAX_ATTEMPTS, 900, "AI_POLL_MAX_ATTEMPTS"),
    aiPollMaxErrors: positiveInteger(env.AI_POLL_MAX_ERRORS, 5, "AI_POLL_MAX_ERRORS"),
    aiEventPollIntervalMs: positiveInteger(
      env.AI_EVENT_POLL_INTERVAL_MS,
      500,
      "AI_EVENT_POLL_INTERVAL_MS",
    ),
    sseHeartbeatMs: positiveInteger(env.SSE_HEARTBEAT_MS, 15000, "SSE_HEARTBEAT_MS"),
    sseRetryMs: positiveInteger(env.SSE_RETRY_MS, 2000, "SSE_RETRY_MS"),
  };
}

export { backendDir };
