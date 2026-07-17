import fs from "node:fs";
import axios from "axios";
import FormData from "form-data";

function unwrapJobResponse(data) {
  if (data && typeof data === "object") {
    if (data.job && typeof data.job === "object") return data.job;
    if (data.data && typeof data.data === "object") return data.data;
  }
  return data;
}

function unwrapEventsResponse(data) {
  if (data && typeof data === "object" && data.data && typeof data.data === "object") {
    return data.data;
  }
  return data;
}

export function describeAiError(error) {
  if (axios.isAxiosError(error)) {
    const responseMessage = error.response?.data?.detail
      || error.response?.data?.error?.message
      || error.response?.data?.message;
    if (responseMessage) return String(responseMessage).slice(0, 1000);
    if (error.code === "ECONNREFUSED") return "AI service is unavailable (connection refused)";
    if (error.code === "ECONNABORTED") return "AI service request timed out";
    return `AI service request failed${error.response?.status ? ` (${error.response.status})` : ""}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export class AiClient {
  constructor({ baseUrl, timeoutMs }) {
    this.http = axios.create({
      baseURL: baseUrl,
      timeout: timeoutMs,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: (status) => status >= 200 && status < 300,
    });
  }

  async createJob(task) {
    const form = new FormData();
    const fileOptions = {
      filename: task.filename,
      contentType: "video/mp4",
    };
    if (Number.isFinite(task.metadata?.size)) fileOptions.knownLength = task.metadata.size;
    form.append("video", fs.createReadStream(task.videoPath), fileOptions);
    form.append("task_id", task.id);
    if (task.roi) {
      form.append("roi_x", String(task.roi.x));
      form.append("roi_y", String(task.roi.y));
      form.append("roi_width", String(task.roi.width));
      form.append("roi_height", String(task.roi.height));
    }
    try {
      const response = await this.http.post("/jobs", form, {
        headers: form.getHeaders(),
      });
      return unwrapJobResponse(response.data);
    } catch (error) {
      // A process may stop after FastAPI accepted a task but before aiJobId was
      // persisted. The AI endpoint is task-idempotent from our perspective, so
      // recover the already-created job instead of incorrectly failing it.
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        return this.getJob(task.id);
      }
      throw error;
    }
  }

  async getJob(jobId) {
    const response = await this.http.get(`/jobs/${encodeURIComponent(jobId)}`);
    return unwrapJobResponse(response.data);
  }

  async getEvents(taskId, afterSeq = 0, { signal } = {}) {
    const response = await this.http.get(`/jobs/${encodeURIComponent(taskId)}/events`, {
      params: { after_seq: afterSeq },
      signal,
    });
    return unwrapEventsResponse(response.data);
  }

  async getPreview(taskId, previewId, runId, { signal } = {}) {
    return this.http.get(
      `/jobs/${encodeURIComponent(taskId)}/previews/${encodeURIComponent(previewId)}`,
      {
        params: { run_id: runId },
        responseType: "stream",
        signal,
      },
    );
  }
}

export { unwrapEventsResponse, unwrapJobResponse };
