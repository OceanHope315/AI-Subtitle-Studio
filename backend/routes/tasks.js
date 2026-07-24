import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import express from "express";
import multer from "multer";
import { AppError, asyncHandler } from "../utils/errors.js";
import { taskToDto, taskToSummaryDto } from "../utils/taskDto.js";
import { RUN_ID_PATTERN } from "../services/progressEventHub.js";
import {
  isMp4File,
  parseByteRange,
  resolveVideoPath,
  safeOriginalFilename,
} from "../utils/video.js";
import { normalizeSubtitles } from "../services/subtitleService.js";
import { describeAiError } from "../services/aiClient.js";
import {
  ANALYSIS_MODES,
  ANALYSIS_MODE_VALUES,
  DEFAULT_ANALYSIS_MODE,
  isAudioOnlyTask,
} from "../utils/analysisMode.js";

const TASK_ID_PATTERN = /^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const ACCEPTED_MP4_MIME_TYPES = new Set(["video/mp4", "application/mp4", "application/octet-stream"]);
const TASK_STATUSES = new Set(["awaiting_roi", "queued", "processing", "completed", "failed"]);
const PREVIEW_ID_PATTERN = RUN_ID_PATTERN;
const ROI_ESTIMATION_CACHE_MS = 30_000;
export const MIN_ROI_DIMENSION = 0.01;

export function validateAnalysisMode(value) {
  const normalized = value === undefined || value === null || value === ""
    ? DEFAULT_ANALYSIS_MODE
    : value;
  if (typeof normalized !== "string" || !ANALYSIS_MODE_VALUES.includes(normalized)) {
    throw new AppError(
      400,
      `analysis_mode must be one of: ${ANALYSIS_MODE_VALUES.join(", ")}`,
      "INVALID_ANALYSIS_MODE",
    );
  }
  return normalized;
}

function validateTaskId(value) {
  if (!TASK_ID_PATTERN.test(value)) {
    throw new AppError(400, "Invalid task id", "INVALID_TASK_ID");
  }
  return value;
}

async function findTaskOrThrow(store, taskId) {
  validateTaskId(taskId);
  const task = await store.findById(taskId);
  if (!task) throw new AppError(404, "Task not found", "TASK_NOT_FOUND");
  return task;
}

function validateOpaqueId(value, pattern, label, code) {
  const normalized = typeof value === "string" ? value : "";
  if (!pattern.test(normalized)) {
    throw new AppError(400, `Invalid ${label}`, code);
  }
  return normalized;
}

function parseSequence(value, label = "after_seq") {
  const normalized = typeof value === "string" ? value.trim() : String(value ?? "");
  if (!/^\d+$/.test(normalized)) {
    throw new AppError(400, `${label} must be a non-negative safe integer`, "INVALID_EVENT_CURSOR");
  }
  const sequence = Number(normalized);
  if (!Number.isSafeInteger(sequence)) {
    throw new AppError(400, `${label} must be a non-negative safe integer`, "INVALID_EVENT_CURSOR");
  }
  return sequence;
}

export function parseEventCursor(req) {
  const requestedRunId = req.query.run_id === undefined
    ? null
    : validateOpaqueId(req.query.run_id, RUN_ID_PATTERN, "run id", "INVALID_RUN_ID");
  const lastEventId = String(req.get("Last-Event-ID") || "").trim();
  if (lastEventId) {
    const separator = lastEventId.lastIndexOf(":");
    if (separator !== -1) {
      const runId = validateOpaqueId(
        lastEventId.slice(0, separator),
        RUN_ID_PATTERN,
        "Last-Event-ID run id",
        "INVALID_EVENT_CURSOR",
      );
      const afterSeq = parseSequence(lastEventId.slice(separator + 1), "Last-Event-ID sequence");
      if (requestedRunId && requestedRunId !== runId) {
        throw new AppError(400, "run_id conflicts with Last-Event-ID", "INVALID_EVENT_CURSOR");
      }
      return { afterSeq, runId };
    }
    return { afterSeq: parseSequence(lastEventId, "Last-Event-ID"), runId: requestedRunId };
  }
  const afterSeq = req.query.after_seq === undefined ? 0 : parseSequence(req.query.after_seq);
  return { afterSeq, runId: requestedRunId };
}

function upstreamHeader(headers, name) {
  if (!headers) return undefined;
  return headers.get?.(name) ?? headers[name] ?? headers[name.toLowerCase()];
}

function previewProxyError(error) {
  const status = Number(error?.response?.status);
  if (status === 404) return new AppError(404, "Preview is not available", "PREVIEW_NOT_FOUND");
  if (status === 400 || status === 422) {
    return new AppError(400, "Invalid preview reference", "INVALID_PREVIEW_REFERENCE");
  }
  return new AppError(502, "AI preview service is unavailable", "AI_PREVIEW_UNAVAILABLE");
}

export function validateRoi(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError(400, "Request body must contain a normalized roi object", "INVALID_ROI");
  }

  const roi = {};
  for (const field of ["x", "y", "width", "height"]) {
    const coordinate = value[field];
    if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) {
      throw new AppError(400, `roi.${field} must be a finite number`, "INVALID_ROI");
    }
    if (coordinate < 0 || coordinate > 1) {
      throw new AppError(400, `roi.${field} must be between 0 and 1`, "INVALID_ROI");
    }
    roi[field] = coordinate;
  }

  if (roi.width < MIN_ROI_DIMENSION || roi.height < MIN_ROI_DIMENSION) {
    throw new AppError(
      400,
      `roi width and height must each be at least ${MIN_ROI_DIMENSION}`,
      "INVALID_ROI",
    );
  }
  if (roi.x + roi.width > 1 || roi.y + roi.height > 1) {
    throw new AppError(400, "roi must stay within normalized video bounds", "INVALID_ROI");
  }
  return roi;
}

function createUploader(config) {
  const storage = multer.diskStorage({
    destination(_req, _file, callback) {
      fsPromises.mkdir(config.uploadDir, { recursive: true })
        .then(() => callback(null, config.uploadDir), callback);
    },
    filename(_req, _file, callback) {
      callback(null, `${crypto.randomUUID()}.mp4`);
    },
  });

  return multer({
    storage,
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
      fields: 8,
      parts: 10,
    },
    fileFilter(_req, file, callback) {
      const extension = path.extname(file.originalname || "").toLowerCase();
      if (extension !== ".mp4" || !ACCEPTED_MP4_MIME_TYPES.has(file.mimetype)) {
        callback(new AppError(415, "Only MP4 video uploads are supported", "UNSUPPORTED_VIDEO_TYPE"));
        return;
      }
      callback(null, true);
    },
  });
}

function uploadSingleVideo(upload) {
  return function uploadMiddleware(req, res, next) {
    upload.single("video")(req, res, next);
  };
}

async function removeUploadedFile(file) {
  if (!file?.path) return;
  await fsPromises.unlink(file.path).catch(() => {});
}

export function createTasksRouter({
  store,
  processor,
  artifactService,
  config,
  aiClient = null,
  progressEventHub = null,
}) {
  const router = express.Router();
  const upload = createUploader(config);
  const roiEstimationCache = new Map();
  const clearRoiEstimation = (taskId, expected = null) => {
    const entry = roiEstimationCache.get(taskId);
    if (!entry || (expected && entry !== expected)) return;
    clearTimeout(entry.timer);
    roiEstimationCache.delete(taskId);
  };

  router.post(
    "/",
    uploadSingleVideo(upload),
    asyncHandler(async (req, res) => {
      if (!req.file) throw new AppError(400, "Multipart field 'video' is required", "VIDEO_REQUIRED");

      let task;
      let audioOnly = false;
      try {
        if (!await isMp4File(req.file.path)) {
          throw new AppError(415, "Uploaded file is not a valid MP4 container", "INVALID_MP4");
        }

        const id = crypto.randomUUID();
        const filename = safeOriginalFilename(req.file.originalname);
        const analysisMode = validateAnalysisMode(req.body?.analysis_mode);
        audioOnly = analysisMode === ANALYSIS_MODES.AUDIO;
        task = await store.create({
          id,
          filename,
          storedFilename: req.file.filename,
          videoPath: path.resolve(req.file.path),
          analysisMode,
          status: audioOnly ? "queued" : "awaiting_roi",
          roi: null,
          progress: 0,
          message: audioOnly
            ? "Waiting for audio processing"
            : "Select the subtitle region to begin processing",
          metadata: {
            size: req.file.size,
            mimetype: "video/mp4",
          },
          subtitles: [],
          visualSubtitles: [],
          audioSubtitles: [],
          visualStatus: audioOnly ? "skipped" : "pending",
          audioStatus: audioOnly ? "queued" : "pending",
          visualProgress: 0,
          audioProgress: 0,
          visualError: null,
          audioError: null,
          visualJobId: null,
          audioJobId: null,
          revision: 0,
          archivedAt: null,
          error: null,
          artifacts: {},
          aiJobId: null,
          progressSnapshot: null,
        });
      } catch (error) {
        await removeUploadedFile(req.file);
        throw error;
      }

      if (audioOnly) processor.enqueue(task.id);
      res.location(`/api/tasks/${task.id}`).status(201).json(taskToDto(task));
    }),
  );

  router.get(
    "/:id/events",
    asyncHandler(async (req, res) => {
      const task = await findTaskOrThrow(store, req.params.id);
      if (isAudioOnlyTask(task)) {
        throw new AppError(
          409,
          "Visual progress events are not available for audio-only tasks",
          "VISUAL_PROGRESS_NOT_APPLICABLE",
        );
      }
      if (!progressEventHub) {
        throw new AppError(503, "Live progress is not available", "PROGRESS_UNAVAILABLE");
      }
      const { afterSeq, runId } = parseEventCursor(req);
      if (["queued", "processing"].includes(task.status)) processor.enqueue(task.id);

      res.status(200).set({
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();

      let closed = false;
      let unsubscribe = () => {};
      let heartbeat = null;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      };
      const endStream = () => {
        cleanup();
        if (!res.writableEnded && !res.destroyed) res.end();
      };
      const writeSse = (chunk) => {
        if (closed || res.writableEnded || res.destroyed) return false;
        try {
          const writable = res.write(chunk);
          if (!writable) endStream();
          return writable;
        } catch {
          endStream();
          return false;
        }
      };
      heartbeat = setInterval(() => {
        writeSse(`: heartbeat ${new Date().toISOString()}\n\n`);
      }, Math.max(10, Number(config.sseHeartbeatMs) || 15000));
      heartbeat.unref?.();

      req.once("close", cleanup);
      res.once("close", cleanup);
      if (!writeSse(
        `retry: ${Math.max(100, Number(config.sseRetryMs) || 2000)}\n`
        + ": connected\n\n",
      )) return;

      unsubscribe = progressEventHub.subscribe(task.id, {
        afterSeq,
        runId,
        onEvent(event) {
          writeSse(
            `id: ${event.run_id}:${event.seq}\n`
            + `event: ${event.type}\n`
            + `data: ${JSON.stringify(event)}\n\n`,
          );
        },
        onPollError() {
          // Ending the response makes the browser reconnect with Last-Event-ID.
          // It deliberately does not cancel the underlying analysis task.
          endStream();
        },
        onClose() {
          endStream();
        },
      });
      if (closed) unsubscribe();
    }),
  );

  router.get(
    "/:id/previews/:previewId",
    asyncHandler(async (req, res) => {
      const task = await findTaskOrThrow(store, req.params.id);
      if (!aiClient || typeof aiClient.getPreview !== "function") {
        throw new AppError(503, "Preview images are not available", "PREVIEW_UNAVAILABLE");
      }
      const previewId = validateOpaqueId(
        req.params.previewId,
        PREVIEW_ID_PATTERN,
        "preview id",
        "INVALID_PREVIEW_ID",
      );
      const runId = validateOpaqueId(req.query.run_id, RUN_ID_PATTERN, "run id", "INVALID_RUN_ID");
      const controller = new AbortController();
      let source = null;
      let finished = false;
      const handleClose = () => {
        if (finished) return;
        controller.abort();
        source?.destroy?.();
      };
      const handleFinish = () => {
        finished = true;
        res.off("close", handleClose);
      };
      res.once("close", handleClose);
      res.once("finish", handleFinish);

      let preview;
      try {
        preview = await aiClient.getPreview(task.id, previewId, runId, { signal: controller.signal });
      } catch (error) {
        res.off("close", handleClose);
        res.off("finish", handleFinish);
        if (controller.signal.aborted || res.destroyed) return;
        throw previewProxyError(error);
      }
      if (controller.signal.aborted || res.destroyed) return;

      const contentType = String(upstreamHeader(preview.headers, "content-type") || "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();
      if (contentType !== "image/jpeg" || !preview.data || typeof preview.data.pipe !== "function") {
        preview.data?.destroy?.();
        throw new AppError(502, "AI service returned an invalid preview image", "INVALID_PREVIEW_RESPONSE");
      }
      source = preview.data;
      const contentLength = String(upstreamHeader(preview.headers, "content-length") || "");
      res.status(200).set({
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, max-age=300, immutable",
        "Accept-Ranges": "none",
        "X-Content-Type-Options": "nosniff",
      });
      if (/^\d+$/.test(contentLength)) res.set("Content-Length", contentLength);
      source.once("error", () => res.destroy());
      source.pipe(res);
    }),
  );

  router.post(
    "/:id/estimate-roi",
    asyncHandler(async (req, res) => {
      const task = await findTaskOrThrow(store, req.params.id);
      if (task.status !== "awaiting_roi") {
        throw new AppError(
          409,
          `Task ROI cannot be estimated while it is ${task.status}`,
          "TASK_STATE_CONFLICT",
          { status: task.status },
        );
      }
      if (!aiClient || typeof aiClient.estimateRoi !== "function") {
        throw new AppError(
          503,
          "Automatic ROI estimation is unavailable",
          "ROI_ESTIMATION_UNAVAILABLE",
        );
      }

      const videoPath = resolveVideoPath(task, config.uploadDir);
      let result;
      let cacheEntry;
      try {
        cacheEntry = roiEstimationCache.get(task.id);
        if (!cacheEntry) {
          cacheEntry = {
            promise: aiClient.estimateRoi({ ...task, videoPath }),
            timer: null,
          };
          roiEstimationCache.set(task.id, cacheEntry);
        }
        result = await cacheEntry.promise;
        if (!cacheEntry.timer && roiEstimationCache.get(task.id) === cacheEntry) {
          cacheEntry.timer = setTimeout(
            () => clearRoiEstimation(task.id, cacheEntry),
            ROI_ESTIMATION_CACHE_MS,
          );
          cacheEntry.timer.unref?.();
        }
      } catch (error) {
        clearRoiEstimation(task.id, cacheEntry);
        throw new AppError(
          502,
          `Automatic ROI estimation failed: ${describeAiError(error)}`,
          "ROI_ESTIMATION_FAILED",
        );
      }

      const currentTask = await store.findById(task.id);
      if (currentTask?.status !== "awaiting_roi") {
        clearRoiEstimation(task.id, cacheEntry);
        throw new AppError(
          409,
          `Task ROI cannot be estimated while it is ${currentTask?.status || "unavailable"}`,
          "TASK_STATE_CONFLICT",
          { status: currentTask?.status || null },
        );
      }

      if (result?.success === false) {
        res.json({
          success: false,
          reason: result.reason === "no subtitle detected"
            ? "no subtitle detected"
            : String(result.reason || "no subtitle detected"),
        });
        return;
      }
      if (result?.success !== true) {
        clearRoiEstimation(task.id, cacheEntry);
        throw new AppError(
          502,
          "AI service returned an invalid ROI estimation response",
          "INVALID_ROI_ESTIMATION_RESPONSE",
        );
      }

      let roi;
      try {
        roi = validateRoi(result.roi);
      } catch {
        clearRoiEstimation(task.id, cacheEntry);
        throw new AppError(
          502,
          "AI service returned an invalid ROI",
          "INVALID_ROI_ESTIMATION_RESPONSE",
        );
      }
      res.json({ success: true, roi });
    }),
  );

  router.post(
    "/:id/start",
    asyncHandler(async (req, res) => {
      const task = await findTaskOrThrow(store, req.params.id);
      const roi = validateRoi(req.body?.roi);
      if (task.status !== "awaiting_roi") {
        throw new AppError(
          409,
          `Task cannot be started while it is ${task.status}`,
          "TASK_STATE_CONFLICT",
          { status: task.status },
        );
      }

      const queued = await store.startTask(task.id, roi);
      if (!queued) {
        const current = await store.findById(task.id);
        throw new AppError(
          409,
          `Task cannot be started while it is ${current?.status || "unavailable"}`,
          "TASK_STATE_CONFLICT",
          { status: current?.status || null },
        );
      }

      clearRoiEstimation(task.id);
      processor.enqueue(task.id);
      res.status(202).json(taskToDto(queued));
    }),
  );

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const page = Number(req.query.page || 1);
      const limit = Number(req.query.limit || 20);
      const status = String(req.query.status || "").trim() || null;
      const search = String(req.query.search || "").trim().slice(0, 100);
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new AppError(400, "page and limit must be positive integers (limit <= 100)", "INVALID_PAGINATION");
      }
      if (status && !TASK_STATUSES.has(status)) {
        throw new AppError(400, "Invalid task status filter", "INVALID_STATUS");
      }
      const result = await store.listSummaries({ page, limit, status, search });
      res.json({
        tasks: result.tasks.map(taskToSummaryDto),
        pagination: { page, limit, total: result.total, pages: Math.ceil(result.total / limit) },
      });
    }),
  );

  router.get(
    "/:id/visual-subtitles",
    asyncHandler(async (req, res) => {
      const task = await findTaskOrThrow(store, req.params.id);
      res.json({ visual_subtitles: task.visualSubtitles || [] });
    }),
  );

  router.get(
    "/:id/audio-subtitles",
    asyncHandler(async (req, res) => {
      const task = await findTaskOrThrow(store, req.params.id);
      res.json({ audio_subtitles: task.audioSubtitles || [] });
    }),
  );

  router.get(
    "/:id/subtitles",
    asyncHandler(async (req, res) => {
      const task = await findTaskOrThrow(store, req.params.id);
      const revision = Number.isInteger(task.revision) ? task.revision : 0;
      res.set("ETag", `\"${revision}\"`);
      res.json({ subtitles: task.subtitles || [], revision });
    }),
  );

  router.put(
    "/:id/subtitles",
    asyncHandler(async (req, res) => {
      const task = await findTaskOrThrow(store, req.params.id);
      if (!req.body || !("subtitles" in req.body)) {
        throw new AppError(400, "Request body must contain subtitles", "SUBTITLES_REQUIRED");
      }
      const ifMatch = req.get("If-Match");
      const expectedValue = ifMatch?.replace(/^W\//, "").replace(/^\"|\"$/g, "")
        ?? req.body.expected_revision;
      const expectedRevision = Number(expectedValue);
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
        throw new AppError(
          428,
          "If-Match or expected_revision is required",
          "REVISION_REQUIRED",
          { revision: Number.isInteger(task.revision) ? task.revision : 0 },
        );
      }
      const subtitles = normalizeSubtitles(req.body.subtitles);
      const result = await store.updateSubtitles(task.id, expectedRevision, subtitles);
      if (result.conflict) {
        const currentRevision = Number.isInteger(result.task?.revision) ? result.task.revision : 0;
        throw new AppError(
          409,
          "Subtitles were updated in another tab",
          "REVISION_CONFLICT",
          { revision: currentRevision },
        );
      }
      await artifactService.write(task.id, result.task.subtitles);
      res.set("ETag", `\"${result.task.revision}\"`);
      res.json({ subtitles: result.task.subtitles, revision: result.task.revision });
    }),
  );

  router.patch(
    "/:id/archive",
    asyncHandler(async (req, res) => {
      const task = await findTaskOrThrow(store, req.params.id);
      const archived = await store.archive(task.id);
      res.json(taskToSummaryDto(archived));
    }),
  );

  router.get(
    "/:id/export",
    asyncHandler(async (req, res, next) => {
      const task = await findTaskOrThrow(store, req.params.id);
      const srtPath = await artifactService.ensure(task.id, task.subtitles || []);
      res.type("application/x-subrip");
      res.download(srtPath, "final.srt", (error) => {
        if (error && !res.headersSent) next(error);
      });
    }),
  );

  router.get(
    "/:id/video",
    asyncHandler(async (req, res) => {
      const task = await findTaskOrThrow(store, req.params.id);
      const videoPath = resolveVideoPath(task, config.uploadDir);
      let stats;
      try {
        stats = await fsPromises.stat(videoPath);
      } catch (error) {
        if (error.code === "ENOENT") throw new AppError(404, "Video file is not available", "VIDEO_NOT_FOUND");
        throw error;
      }
      if (!stats.isFile()) throw new AppError(404, "Video file is not available", "VIDEO_NOT_FOUND");

      const range = parseByteRange(req.headers.range, stats.size);
      res.set({
        "Accept-Ranges": "bytes",
        "Content-Type": "video/mp4",
        "Cache-Control": "private, max-age=0, must-revalidate",
      });

      if (range === false) {
        res.set("Content-Range", `bytes */${stats.size}`);
        res.status(416).end();
        return;
      }

      const options = range || undefined;
      const contentLength = range ? range.end - range.start + 1 : stats.size;
      res.set("Content-Length", String(contentLength));
      if (range) {
        res.status(206).set("Content-Range", `bytes ${range.start}-${range.end}/${stats.size}`);
      }

      const stream = fs.createReadStream(videoPath, options);
      stream.on("error", (error) => {
        if (!res.headersSent) res.destroy(error);
        else res.destroy();
      });
      res.on("close", () => {
        if (!res.writableEnded) stream.destroy();
      });
      stream.pipe(res);
    }),
  );

  router.get(
    "/:id",
    asyncHandler(async (req, res) => {
      const task = await findTaskOrThrow(store, req.params.id);
      if (["queued", "processing"].includes(task.status)) processor.enqueue(task.id);
      res.json(taskToDto(task));
    }),
  );

  return router;
}
