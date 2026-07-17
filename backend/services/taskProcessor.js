import { describeAiError } from "./aiClient.js";
import { normalizeSubtitles } from "./subtitleService.js";

const TERMINAL_STATUSES = new Set(["completed", "failed"]);
const PROCESSABLE_STATUSES = new Set(["queued", "processing"]);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeStatus(value, fallback = "processing") {
  const status = String(value || "").toLowerCase();
  if (["queued", "pending"].includes(status)) return "queued";
  if (["processing", "running", "in_progress", "started"].includes(status)) return "processing";
  if (["completed", "complete", "succeeded", "success", "done"].includes(status)) return "completed";
  if (["failed", "failure", "error", "cancelled", "canceled"].includes(status)) return "failed";
  return fallback;
}

function normalizeProgress(value, status, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return status === "completed" ? 100 : fallback;
  return Math.min(100, Math.max(0, parsed));
}

function errorText(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string") return value.slice(0, 4000);
  if (typeof value === "object" && value.message) return String(value.message).slice(0, 4000);
  return JSON.stringify(value).slice(0, 4000);
}

function jobIdFromPayload(payload, taskId) {
  return String(payload?.job_id ?? payload?.id ?? payload?.task_id ?? taskId);
}

function progressSnapshotFromPayload(payload, currentSnapshot = null) {
  const runId = typeof payload?.run_id === "string" ? payload.run_id : null;
  const latestSeq = Number(payload?.latest_seq);
  if (!runId || !Number.isSafeInteger(latestSeq) || latestSeq < 0) return null;
  const canReuseEvent = currentSnapshot?.run_id === runId
    && currentSnapshot?.latest_seq === latestSeq;
  const latestEvent = payload.latest_event && typeof payload.latest_event === "object"
    ? {
      seq: payload.latest_event.seq,
      task_id: payload.latest_event.task_id,
      run_id: payload.latest_event.run_id,
      type: payload.latest_event.type,
      occurred_at: payload.latest_event.occurred_at,
      payload: payload.latest_event.payload || {},
      progress: payload.latest_event.progress,
      message: payload.latest_event.message,
    }
    : (canReuseEvent ? currentSnapshot.latest_event : null);
  const latestFrameEvent = payload.latest_frame_event && typeof payload.latest_frame_event === "object"
    ? {
      seq: payload.latest_frame_event.seq,
      task_id: payload.latest_frame_event.task_id,
      run_id: payload.latest_frame_event.run_id,
      type: payload.latest_frame_event.type,
      occurred_at: payload.latest_frame_event.occurred_at,
      payload: payload.latest_frame_event.payload || {},
      progress: payload.latest_frame_event.progress,
      message: payload.latest_frame_event.message,
    }
    : (currentSnapshot?.run_id === runId ? currentSnapshot.latest_frame_event || null : null);
  const latestPreviewEvent = payload.latest_preview_event && typeof payload.latest_preview_event === "object"
    ? {
      seq: payload.latest_preview_event.seq,
      task_id: payload.latest_preview_event.task_id,
      run_id: payload.latest_preview_event.run_id,
      type: payload.latest_preview_event.type,
      occurred_at: payload.latest_preview_event.occurred_at,
      payload: payload.latest_preview_event.payload || {},
      progress: payload.latest_preview_event.progress,
      message: payload.latest_preview_event.message,
    }
    : (currentSnapshot?.run_id === runId ? currentSnapshot.latest_preview_event || null : null);
  return {
    run_id: runId,
    latest_seq: latestSeq,
    latest_event: latestEvent,
    latest_frame_event: latestFrameEvent,
    latest_preview_event: latestPreviewEvent,
  };
}

export class TaskProcessor {
  constructor({ store, aiClient, artifactService, config, logger = console }) {
    this.store = store;
    this.aiClient = aiClient;
    this.artifactService = artifactService;
    this.pollIntervalMs = config.aiPollIntervalMs;
    this.pollMaxAttempts = config.aiPollMaxAttempts;
    this.pollMaxErrors = config.aiPollMaxErrors;
    this.logger = logger;
    this.activeTasks = new Set();
  }

  enqueue(taskId) {
    if (this.activeTasks.has(taskId)) return false;
    this.activeTasks.add(taskId);
    const immediate = setImmediate(() => {
      this.processTask(taskId)
        .catch((error) => this.logger.error?.(`Task processor crashed for ${taskId}:`, error))
        .finally(() => this.activeTasks.delete(taskId));
    });
    immediate.unref?.();
    return true;
  }

  async resumePending() {
    const tasks = await this.store.list();
    for (const task of tasks) {
      if (PROCESSABLE_STATUSES.has(task.status)) this.enqueue(task.id);
    }
  }

  async applyJobUpdate(taskId, payload) {
    const current = await this.store.findById(taskId);
    if (!current) return null;

    const status = normalizeStatus(payload?.status, current.status === "queued" ? "queued" : "processing");
    const patch = {
      status,
      progress: normalizeProgress(payload?.progress, status, current.progress),
      message: payload?.message === undefined || payload?.message === null
        ? current.message || null
        : String(payload.message).slice(0, 1000),
      error: status === "failed" ? errorText(payload?.error || payload?.message || "AI processing failed") : null,
    };

    const metadata = payload?.metadata ?? payload?.video_metadata;
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
      patch.metadata = { ...(current.metadata || {}), ...metadata };
    }
    if (payload?.artifacts && typeof payload.artifacts === "object") {
      patch.artifacts = payload.artifacts;
    }
    if (Array.isArray(payload?.subtitles)) {
      patch.subtitles = normalizeSubtitles(payload.subtitles, { strict: false });
    }
    const progressSnapshot = progressSnapshotFromPayload(payload, current.progressSnapshot);
    if (progressSnapshot) patch.progressSnapshot = progressSnapshot;

    if (status === "completed") {
      patch.progress = 100;
      if (!patch.subtitles) patch.subtitles = current.subtitles || [];
    }

    const updated = await this.store.update(taskId, patch);
    if (updated?.status === "completed") {
      await this.artifactService.write(taskId, updated.subtitles || []);
    }
    return updated;
  }

  async failTask(taskId, error) {
    const current = await this.store.findById(taskId);
    if (!current || TERMINAL_STATUSES.has(current.status)) return current;
    return this.store.update(taskId, {
      status: "failed",
      error: describeAiError(error).slice(0, 4000),
      message: "AI processing failed",
    });
  }

  async processTask(taskId) {
    let task = await this.store.findById(taskId);
    if (!task || !PROCESSABLE_STATUSES.has(task.status)) return task;

    try {
      let jobId = task.aiJobId;
      if (!jobId) {
        task = await this.store.update(taskId, {
          status: "processing",
          progress: Math.max(1, task.progress || 0),
          message: "Submitting video to AI service",
          error: null,
        });
        const submitted = await this.aiClient.createJob(task);
        if (!submitted || typeof submitted !== "object") {
          throw new Error("AI service returned an invalid job response");
        }
        jobId = jobIdFromPayload(submitted, taskId);
        await this.store.update(taskId, { aiJobId: jobId });
        task = await this.applyJobUpdate(taskId, submitted);
        if (!task || TERMINAL_STATUSES.has(task.status)) return task;
      }

      let consecutiveErrors = 0;
      for (let attempt = 0; attempt < this.pollMaxAttempts; attempt += 1) {
        await sleep(this.pollIntervalMs);
        try {
          const payload = await this.aiClient.getJob(jobId);
          if (!payload || typeof payload !== "object") {
            throw new Error("AI service returned an invalid job status response");
          }
          consecutiveErrors = 0;
          task = await this.applyJobUpdate(taskId, payload);
          if (!task || TERMINAL_STATUSES.has(task.status)) return task;
        } catch (error) {
          consecutiveErrors += 1;
          this.logger.warn?.(
            `AI status poll ${attempt + 1} failed for ${taskId}: ${describeAiError(error)}`,
          );
          if (consecutiveErrors >= this.pollMaxErrors) throw error;
        }
      }
      throw new Error(`AI processing timed out after ${this.pollMaxAttempts} status checks`);
    } catch (error) {
      return this.failTask(taskId, error);
    }
  }
}

export { progressSnapshotFromPayload };
