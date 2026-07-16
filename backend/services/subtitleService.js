import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { AppError } from "../utils/errors.js";

const MAX_SUBTITLES = 100_000;

function cleanText(value) {
  return String(value ?? "")
    .replace(/\0/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function finiteTime(value) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

function normalizePosition(position, strict) {
  if (position === undefined || position === null) return null;
  if (!Array.isArray(position) || position.length !== 4) {
    if (strict) throw new AppError(400, "position must contain [x1, y1, x2, y2]", "INVALID_SUBTITLES");
    return null;
  }
  const values = position.map(Number);
  if (!values.every(Number.isFinite)) {
    if (strict) throw new AppError(400, "position values must be numbers", "INVALID_SUBTITLES");
    return null;
  }
  return values;
}

function normalizeOne(item, index, strict) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    if (strict) throw new AppError(400, `subtitles[${index}] must be an object`, "INVALID_SUBTITLES");
    return null;
  }

  const startTime = finiteTime(item.start_time ?? item.startTime ?? item.start);
  const endTime = finiteTime(item.end_time ?? item.endTime ?? item.end);
  if (startTime === null || startTime < 0 || endTime === null || endTime <= startTime) {
    if (strict) {
      throw new AppError(
        400,
        `subtitles[${index}] requires start_time >= 0 and end_time > start_time`,
        "INVALID_SUBTITLES",
      );
    }
    return null;
  }

  let confidence = item.confidence;
  if (confidence !== undefined && confidence !== null) {
    confidence = Number(confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      if (strict) {
        throw new AppError(400, `subtitles[${index}].confidence must be between 0 and 1`, "INVALID_SUBTITLES");
      }
      confidence = Math.min(1, Math.max(0, Number.isFinite(confidence) ? confidence : 0));
    }
  } else {
    confidence = null;
  }

  const id = String(item.id ?? `subtitle-${index + 1}`).slice(0, 128);
  const source = item.source === undefined || item.source === null
    ? null
    : String(item.source).slice(0, 64);

  return {
    id,
    text: cleanText(item.text),
    start_time: startTime,
    end_time: endTime,
    confidence,
    position: normalizePosition(item.position, strict),
    source,
  };
}

export function normalizeSubtitles(input, { strict = true } = {}) {
  if (!Array.isArray(input)) {
    if (strict) throw new AppError(400, "subtitles must be an array", "INVALID_SUBTITLES");
    return [];
  }
  if (input.length > MAX_SUBTITLES) {
    throw new AppError(413, `subtitles cannot contain more than ${MAX_SUBTITLES} items`, "TOO_MANY_SUBTITLES");
  }

  return input
    .map((item, index) => normalizeOne(item, index, strict))
    .filter(Boolean)
    .sort((left, right) => left.start_time - right.start_time || left.end_time - right.end_time);
}

export function formatSrtTimestamp(seconds) {
  const totalMilliseconds = Math.max(0, Math.round(Number(seconds) * 1000));
  const milliseconds = totalMilliseconds % 1000;
  const totalSeconds = Math.floor(totalMilliseconds / 1000);
  const secs = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(milliseconds).padStart(3, "0")}`;
}

export function subtitlesToSrt(subtitles) {
  return subtitles
    .map((subtitle, index) => [
      String(index + 1),
      `${formatSrtTimestamp(subtitle.start_time)} --> ${formatSrtTimestamp(subtitle.end_time)}`,
      cleanText(subtitle.text),
    ].join("\n"))
    .join("\n\n") + (subtitles.length ? "\n" : "");
}

async function atomicWrite(filePath, contents) {
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, contents);
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.unlink(temporaryPath).catch(() => {});
  }
}

export class SubtitleArtifactService {
  constructor(subtitleDir) {
    this.subtitleDir = path.resolve(subtitleDir);
  }

  taskDirectory(taskId) {
    const directory = path.resolve(this.subtitleDir, String(taskId));
    if (!directory.startsWith(`${this.subtitleDir}${path.sep}`)) {
      throw new Error("Unsafe subtitle task id");
    }
    return directory;
  }

  srtPath(taskId) {
    return path.join(this.taskDirectory(taskId), "final.srt");
  }

  jsonPath(taskId) {
    return path.join(this.taskDirectory(taskId), "subtitles.json");
  }

  async write(taskId, subtitles) {
    const directory = this.taskDirectory(taskId);
    await fs.mkdir(directory, { recursive: true });
    await Promise.all([
      atomicWrite(this.srtPath(taskId), subtitlesToSrt(subtitles)),
      atomicWrite(this.jsonPath(taskId), `${JSON.stringify(subtitles, null, 2)}\n`),
    ]);
    return this.srtPath(taskId);
  }

  async ensure(taskId, subtitles) {
    // Regenerate from the authoritative task record so a prior interrupted
    // artifact write can never leave export serving stale subtitles.
    return this.write(taskId, subtitles);
  }
}
