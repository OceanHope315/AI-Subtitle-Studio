import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import express from "express";
import multer from "multer";
import { AppError, asyncHandler } from "../utils/errors.js";
import { taskToDto, taskToSummaryDto } from "../utils/taskDto.js";
import {
  isMp4File,
  parseByteRange,
  resolveVideoPath,
  safeOriginalFilename,
} from "../utils/video.js";
import { normalizeSubtitles } from "../services/subtitleService.js";

const TASK_ID_PATTERN = /^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const ACCEPTED_MP4_MIME_TYPES = new Set(["video/mp4", "application/mp4", "application/octet-stream"]);
const TASK_STATUSES = new Set(["awaiting_roi", "queued", "processing", "completed", "failed"]);
export const MIN_ROI_DIMENSION = 0.01;

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

export function createTasksRouter({ store, processor, artifactService, config }) {
  const router = express.Router();
  const upload = createUploader(config);

  router.post(
    "/",
    uploadSingleVideo(upload),
    asyncHandler(async (req, res) => {
      if (!req.file) throw new AppError(400, "Multipart field 'video' is required", "VIDEO_REQUIRED");

      try {
        if (!await isMp4File(req.file.path)) {
          throw new AppError(415, "Uploaded file is not a valid MP4 container", "INVALID_MP4");
        }

        const id = crypto.randomUUID();
        const filename = safeOriginalFilename(req.file.originalname);
        const task = await store.create({
          id,
          filename,
          storedFilename: req.file.filename,
          videoPath: path.resolve(req.file.path),
          status: "awaiting_roi",
          roi: null,
          progress: 0,
          message: "Select the subtitle region to begin processing",
          metadata: {
            size: req.file.size,
            mimetype: "video/mp4",
          },
          subtitles: [],
          revision: 0,
          archivedAt: null,
          error: null,
          artifacts: {},
          aiJobId: null,
        });

        res.location(`/api/tasks/${id}`).status(201).json(taskToDto(task));
      } catch (error) {
        await removeUploadedFile(req.file);
        throw error;
      }
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
