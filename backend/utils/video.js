import fs from "node:fs/promises";
import path from "node:path";
import { AppError } from "./errors.js";

export function safeOriginalFilename(value) {
  const basename = path.basename(String(value || "video.mp4"));
  const cleaned = basename.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (cleaned || "video.mp4").slice(0, 255);
}

export async function isMp4File(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const stats = await handle.stat();
    const buffer = Buffer.alloc(32);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead < 12) return false;
    const firstBoxSize = buffer.readUInt32BE(0);
    const firstBoxType = buffer.toString("ascii", 4, 8);
    return firstBoxType === "ftyp" && firstBoxSize >= 12 && firstBoxSize <= stats.size;
  } finally {
    await handle.close();
  }
}

export function resolveVideoPath(task, uploadDir) {
  if (!task?.videoPath) throw new AppError(404, "Video file is not available", "VIDEO_NOT_FOUND");
  const root = path.resolve(uploadDir);
  const candidate = path.isAbsolute(task.videoPath)
    ? path.resolve(task.videoPath)
    : path.resolve(root, task.videoPath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new AppError(500, "Stored video path is outside the upload directory", "UNSAFE_VIDEO_PATH");
  }
  return candidate;
}

export function parseByteRange(rangeHeader, size) {
  if (!rangeHeader) return null;
  if (!rangeHeader.startsWith("bytes=") || rangeHeader.includes(",")) return false;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || (!match[1] && !match[2])) return false;

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return false;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }

  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || start < 0
    || start >= size
    || end < start
  ) return false;

  return { start, end: Math.min(end, size - 1) };
}
