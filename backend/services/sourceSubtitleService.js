import { AppError } from "../utils/errors.js";

const MAX_SOURCE_SUBTITLES = 100_000;

function cleanText(value) {
  return String(value ?? "")
    .replace(/\0/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function finiteNumber(value) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

function normalizeConfidence(value, strict, path) {
  if (value === undefined || value === null || value === "") return null;
  const confidence = Number(value);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    if (strict) {
      throw new AppError(400, `${path} must be between 0 and 1`, "INVALID_SOURCE_SUBTITLES");
    }
    return Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : null;
  }
  return confidence;
}

function normalizedTaskId(item, taskId, strict, path) {
  const value = String(taskId ?? item?.taskId ?? item?.task_id ?? "").trim();
  if (!value || value.length > 80) {
    if (strict) throw new AppError(400, `${path}.taskId is required`, "INVALID_SOURCE_SUBTITLES");
    return null;
  }
  return value;
}

function normalizeBbox(value, strict, path) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    if (strict) throw new AppError(400, `${path}.bbox must be an array`, "INVALID_SOURCE_SUBTITLES");
    return [];
  }

  const normalizeCoordinate = (coordinate) => {
    if (Array.isArray(coordinate)) {
      const nested = coordinate.map(normalizeCoordinate);
      return nested.some((item) => item === null) ? null : nested;
    }
    return finiteNumber(coordinate);
  };
  const bbox = value.map(normalizeCoordinate);
  if (bbox.some((coordinate) => coordinate === null)) {
    if (strict) {
      throw new AppError(400, `${path}.bbox must contain finite numbers`, "INVALID_SOURCE_SUBTITLES");
    }
    return [];
  }
  return bbox;
}

function validateInput(input, strict, label) {
  if (!Array.isArray(input)) {
    if (strict) throw new AppError(400, `${label} must be an array`, "INVALID_SOURCE_SUBTITLES");
    return [];
  }
  if (input.length > MAX_SOURCE_SUBTITLES) {
    throw new AppError(
      413,
      `${label} cannot contain more than ${MAX_SOURCE_SUBTITLES} items`,
      "TOO_MANY_SOURCE_SUBTITLES",
    );
  }
  return input;
}

export function normalizeVisualSubtitles(input, { strict = true, taskId = null } = {}) {
  return validateInput(input, strict, "visual_subtitles")
    .map((item, index) => {
      const path = `visual_subtitles[${index}]`;
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        if (strict) throw new AppError(400, `${path} must be an object`, "INVALID_SOURCE_SUBTITLES");
        return null;
      }
      const ownerTaskId = normalizedTaskId(item, taskId, strict, path);
      const start = finiteNumber(item.start ?? item.start_time ?? item.startTime);
      const end = finiteNumber(item.end ?? item.end_time ?? item.endTime);
      if (!ownerTaskId || start === null || start < 0 || end === null || end <= start) {
        if (strict) {
          throw new AppError(
            400,
            `${path} requires start >= 0 and end > start`,
            "INVALID_SOURCE_SUBTITLES",
          );
        }
        return null;
      }
      return {
        taskId: ownerTaskId,
        text: cleanText(item.text),
        start,
        end,
        bbox: normalizeBbox(item.bbox ?? item.position, strict, path),
        confidence: normalizeConfidence(item.confidence, strict, `${path}.confidence`),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function normalizeAudioWord(item, wordIndex, strict, path) {
  const wordPath = `${path}.words[${wordIndex}]`;
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    if (strict) throw new AppError(400, `${wordPath} must be an object`, "INVALID_SOURCE_SUBTITLES");
    return null;
  }
  const word = cleanText(item.word ?? item.text);
  if (!word) {
    if (strict) throw new AppError(400, `${wordPath}.word is required`, "INVALID_SOURCE_SUBTITLES");
    return null;
  }
  const rawStart = finiteNumber(item.start ?? item.start_time ?? item.startTime);
  const rawEnd = finiteNumber(item.end ?? item.end_time ?? item.endTime);
  const start = rawStart !== null && rawStart >= 0 ? rawStart : null;
  const end = rawEnd !== null && rawEnd >= 0 ? rawEnd : null;
  const invalidPair = start !== null && end !== null && end <= start;
  const invalidBoundary = (rawStart !== null && start === null) || (rawEnd !== null && end === null);
  if (strict && (invalidPair || invalidBoundary)) {
    throw new AppError(
      400,
      `${wordPath} requires non-negative timestamps and end > start when both are present`,
      "INVALID_SOURCE_SUBTITLES",
    );
  }
  return {
    word,
    start: invalidPair ? null : start,
    end: invalidPair ? null : end,
    confidence: normalizeConfidence(item.confidence ?? item.score, strict, `${wordPath}.confidence`),
  };
}

export function normalizeAudioSubtitles(input, { strict = true, taskId = null } = {}) {
  return validateInput(input, strict, "audio_subtitles")
    .map((item, index) => {
      const path = `audio_subtitles[${index}]`;
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        if (strict) throw new AppError(400, `${path} must be an object`, "INVALID_SOURCE_SUBTITLES");
        return null;
      }
      const ownerTaskId = normalizedTaskId(item, taskId, strict, path);
      if (!ownerTaskId) return null;
      const rawWords = item.words === undefined || item.words === null ? [] : item.words;
      if (!Array.isArray(rawWords)) {
        if (strict) throw new AppError(400, `${path}.words must be an array`, "INVALID_SOURCE_SUBTITLES");
        return null;
      }
      const words = rawWords
        .map((word, wordIndex) => normalizeAudioWord(word, wordIndex, strict, path))
        .filter(Boolean);

      const explicitStart = finiteNumber(item.start ?? item.start_time ?? item.startTime);
      const explicitEnd = finiteNumber(item.end ?? item.end_time ?? item.endTime);
      const hasExplicitTiming = explicitStart !== null
        && explicitStart >= 0
        && explicitEnd !== null
        && explicitEnd > explicitStart;
      if (!hasExplicitTiming && strict && (explicitStart !== null || explicitEnd !== null)) {
        throw new AppError(
          400,
          `${path} requires end > start >= 0 when sentence timestamps are present`,
          "INVALID_SOURCE_SUBTITLES",
        );
      }
      const timedWords = words.filter((word) => word.start !== null && word.end !== null);
      const start = hasExplicitTiming
        ? explicitStart
        : (timedWords.length ? Math.min(...timedWords.map((word) => word.start)) : null);
      const end = hasExplicitTiming
        ? explicitEnd
        : (timedWords.length ? Math.max(...timedWords.map((word) => word.end)) : null);

      return {
        taskId: ownerTaskId,
        text: cleanText(item.text),
        start,
        end,
        words,
        confidence: normalizeConfidence(item.confidence, strict, `${path}.confidence`),
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (left.start === null && right.start === null) return 0;
      if (left.start === null) return 1;
      if (right.start === null) return -1;
      return left.start - right.start || left.end - right.end;
    });
}
