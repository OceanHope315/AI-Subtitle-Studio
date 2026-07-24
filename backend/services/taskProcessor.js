import { describeAiError } from "./aiClient.js";
import {
  normalizeAudioSubtitles,
  normalizeVisualSubtitles,
} from "./sourceSubtitleService.js";

const TERMINAL_STATUSES = new Set(["completed", "failed"]);
const PROCESSABLE_STATUSES = new Set(["queued", "processing"]);
const SOURCE_STATUSES = new Set(["pending", "queued", "processing", "completed", "failed"]);

const SOURCE_FIELDS = {
  visual: {
    status: "visualStatus",
    progress: "visualProgress",
    error: "visualError",
    subtitles: "visualSubtitles",
    jobId: "visualJobId",
  },
  audio: {
    status: "audioStatus",
    progress: "audioProgress",
    error: "audioError",
    subtitles: "audioSubtitles",
    jobId: "audioJobId",
  },
};

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

function sourceStatus(task, source) {
  const field = SOURCE_FIELDS[source].status;
  if (SOURCE_STATUSES.has(task?.[field])) return task[field];
  if (source === "visual" && PROCESSABLE_STATUSES.has(task?.status)) return task.status;
  if (source === "visual" && TERMINAL_STATUSES.has(task?.status)) return task.status;
  return "pending";
}

function sourceProgress(task, source) {
  const value = Number(task?.[SOURCE_FIELDS[source].progress]);
  if (Number.isFinite(value)) return Math.min(100, Math.max(0, value));
  if (source === "visual") return normalizeProgress(task?.progress, task?.status, 0);
  return 0;
}

function aggregateParentState(task) {
  const visualStatus = sourceStatus(task, "visual");
  const audioStatus = sourceStatus(task, "audio");
  const bothTerminal = TERMINAL_STATUSES.has(visualStatus) && TERMINAL_STATUSES.has(audioStatus);
  const eitherCompleted = visualStatus === "completed" || audioStatus === "completed";
  const averagedProgress = Math.round(
    (sourceProgress(task, "visual") + sourceProgress(task, "audio")) / 2,
  );

  if (!bothTerminal) {
    return {
      status: "processing",
      progress: averagedProgress,
      message: `Visual ${visualStatus} · Audio ${audioStatus}`,
      error: null,
    };
  }
  if (eitherCompleted) {
    const partial = visualStatus === "failed" || audioStatus === "failed";
    return {
      status: "completed",
      progress: 100,
      message: partial
        ? "Subtitle extraction completed with one source unavailable"
        : "Visual and audio subtitle extraction completed",
      error: null,
    };
  }
  const errors = [task.visualError, task.audioError].filter(Boolean);
  return {
    status: "failed",
    progress: averagedProgress,
    message: "Visual and audio subtitle extraction failed",
    error: (errors.join(" | ") || "AI processing failed").slice(0, 4000),
  };
}

function sourcePayloadSubtitles(payload, source) {
  if (source === "visual") {
    if (Array.isArray(payload?.visual_subtitles)) return payload.visual_subtitles;
    if (Array.isArray(payload?.visualSubtitles)) return payload.visualSubtitles;
    if (Array.isArray(payload?.subtitles)) return payload.subtitles;
    return null;
  }
  if (Array.isArray(payload?.audio_subtitles)) return payload.audio_subtitles;
  if (Array.isArray(payload?.audioSubtitles)) return payload.audioSubtitles;
  if (Array.isArray(payload?.subtitles)) return payload.subtitles;
  return null;
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
    this.mutationQueues = new Map();
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

  async mutateTask(taskId, buildPatch) {
    const previous = this.mutationQueues.get(taskId) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const current = await this.store.findById(taskId);
      if (!current) return null;
      const patch = await buildPatch(current);
      if (!patch) return current;
      return this.store.update(taskId, patch);
    });
    this.mutationQueues.set(taskId, operation);
    try {
      return await operation;
    } finally {
      if (this.mutationQueues.get(taskId) === operation) this.mutationQueues.delete(taskId);
    }
  }

  async updateSourceState(taskId, sourcePatch) {
    return this.mutateTask(taskId, (current) => {
      const next = { ...current, ...sourcePatch };
      return { ...sourcePatch, ...aggregateParentState(next) };
    });
  }

  async applySourceJobUpdate(taskId, source, payload) {
    const fields = SOURCE_FIELDS[source];
    return this.mutateTask(taskId, (current) => {
      const currentStatus = sourceStatus(current, source);
      const status = normalizeStatus(
        payload?.status,
        currentStatus === "queued" ? "queued" : "processing",
      );
      const patch = {
        [fields.status]: status,
        [fields.progress]: normalizeProgress(payload?.progress, status, sourceProgress(current, source)),
        [fields.error]: status === "failed"
          ? errorText(payload?.error || payload?.message || `${source} subtitle extraction failed`)
          : null,
      };

      const subtitles = sourcePayloadSubtitles(payload, source);
      if (subtitles) {
        patch[fields.subtitles] = source === "visual"
          ? normalizeVisualSubtitles(subtitles, { strict: false, taskId })
          : normalizeAudioSubtitles(subtitles, { strict: false, taskId });
      }
      if (status === "completed") patch[fields.progress] = 100;

      if (source === "visual") {
        const metadata = payload?.metadata ?? payload?.video_metadata;
        if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
          patch.metadata = { ...(current.metadata || {}), ...metadata };
        }
        if (payload?.artifacts && typeof payload.artifacts === "object") {
          patch.artifacts = payload.artifacts;
        }
        const progressSnapshot = progressSnapshotFromPayload(payload, current.progressSnapshot);
        if (progressSnapshot) patch.progressSnapshot = progressSnapshot;
      }

      const next = { ...current, ...patch };
      return { ...patch, ...aggregateParentState(next) };
    });
  }

  async applyJobUpdate(taskId, payload) {
    return this.applySourceJobUpdate(taskId, "visual", payload);
  }

  async failSource(taskId, source, error) {
    const fields = SOURCE_FIELDS[source];
    return this.mutateTask(taskId, (current) => {
      if (TERMINAL_STATUSES.has(sourceStatus(current, source))) return null;
      const patch = {
        [fields.status]: "failed",
        [fields.error]: describeAiError(error).slice(0, 4000),
      };
      return { ...patch, ...aggregateParentState({ ...current, ...patch }) };
    });
  }

  async processSource(taskId, source) {
    const fields = SOURCE_FIELDS[source];
    let task = await this.store.findById(taskId);
    if (!task || TERMINAL_STATUSES.has(sourceStatus(task, source))) return task;

    const createJob = source === "visual"
      ? (this.aiClient.createVisualJob || this.aiClient.createJob)
      : this.aiClient.createAudioJob;
    const getJob = source === "visual"
      ? (this.aiClient.getVisualJob || this.aiClient.getJob)
      : this.aiClient.getAudioJob;
    if (typeof createJob !== "function" || typeof getJob !== "function") {
      return this.failSource(taskId, source, new Error(`${source} AI job API is unavailable`));
    }

    try {
      let jobId = task[fields.jobId] || (source === "visual" ? task.aiJobId : null);
      if (!jobId) {
        task = await this.updateSourceState(taskId, {
          [fields.status]: "processing",
          [fields.progress]: Math.max(1, sourceProgress(task, source)),
          [fields.error]: null,
        });
        const submitted = await createJob.call(this.aiClient, task);
        if (!submitted || typeof submitted !== "object") {
          throw new Error(`${source} AI service returned an invalid job response`);
        }
        const fallbackId = source === "visual" ? taskId : `${taskId}-audio`;
        jobId = jobIdFromPayload(submitted, fallbackId);
        const jobPatch = { [fields.jobId]: jobId };
        if (source === "visual") jobPatch.aiJobId = jobId;
        await this.updateSourceState(taskId, jobPatch);
        task = await this.applySourceJobUpdate(taskId, source, submitted);
        if (!task || TERMINAL_STATUSES.has(sourceStatus(task, source))) return task;
      }

      let consecutiveErrors = 0;
      for (let attempt = 0; attempt < this.pollMaxAttempts; attempt += 1) {
        await sleep(this.pollIntervalMs);
        try {
          const payload = await getJob.call(this.aiClient, jobId);
          if (!payload || typeof payload !== "object") {
            throw new Error(`${source} AI service returned an invalid job status response`);
          }
          consecutiveErrors = 0;
          task = await this.applySourceJobUpdate(taskId, source, payload);
          if (!task || TERMINAL_STATUSES.has(sourceStatus(task, source))) return task;
        } catch (error) {
          consecutiveErrors += 1;
          this.logger.warn?.(
            `${source} AI status poll ${attempt + 1} failed for ${taskId}: ${describeAiError(error)}`,
          );
          if (consecutiveErrors >= this.pollMaxErrors) throw error;
        }
      }
      throw new Error(`${source} AI processing timed out after ${this.pollMaxAttempts} status checks`);
    } catch (error) {
      return this.failSource(taskId, source, error);
    }
  }

  async processTask(taskId) {
    let task = await this.store.findById(taskId);
    if (!task || !PROCESSABLE_STATUSES.has(task.status)) return task;

    const supportsAudio = typeof this.aiClient.createAudioJob === "function"
      && typeof this.aiClient.getAudioJob === "function";
    const initialPatch = {};
    if (!SOURCE_STATUSES.has(task.visualStatus)) {
      initialPatch.visualStatus = task.aiJobId || task.status === "processing" ? "processing" : "queued";
    }
    if (!supportsAudio && !TERMINAL_STATUSES.has(sourceStatus(task, "audio"))) {
      initialPatch.audioStatus = "failed";
      initialPatch.audioError = "Audio subtitle extraction is unavailable";
    } else if (supportsAudio && (!SOURCE_STATUSES.has(task.audioStatus) || task.audioStatus === "pending")) {
      initialPatch.audioStatus = "queued";
      initialPatch.audioError = null;
    }
    task = await this.updateSourceState(taskId, initialPatch);
    if (!task) return null;

    const work = [];
    if (!TERMINAL_STATUSES.has(sourceStatus(task, "visual"))) {
      work.push(this.processSource(taskId, "visual"));
    }
    if (supportsAudio && !TERMINAL_STATUSES.has(sourceStatus(task, "audio"))) {
      work.push(this.processSource(taskId, "audio"));
    }
    await Promise.all(work);
    return this.store.findById(taskId);
  }

  async failTask(taskId, error) {
    await Promise.all([
      this.failSource(taskId, "visual", error),
      this.failSource(taskId, "audio", error),
    ]);
    return this.store.findById(taskId);
  }
}

export {
  aggregateParentState,
  progressSnapshotFromPayload,
};
