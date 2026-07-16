let localId = 0

export function makeClientId() {
  return globalThis.crypto?.randomUUID?.() || `subtitle-${Date.now()}-${localId++}`
}

export function toNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

export function normalizeSubtitle(subtitle = {}, index = 0) {
  const start = Math.max(0, toNumber(subtitle.start_time ?? subtitle.startTime))
  const end = Math.max(start, toNumber(subtitle.end_time ?? subtitle.endTime, start + 2))

  return {
    ...subtitle,
    text: String(subtitle.text ?? ''),
    start_time: start,
    end_time: end,
    _clientId: subtitle._clientId || subtitle.id || subtitle._id || `server-${index}-${makeClientId()}`,
  }
}

export function normalizeSubtitles(subtitles = []) {
  return subtitles
    .map(normalizeSubtitle)
    .sort((a, b) => a.start_time - b.start_time || a.end_time - b.end_time)
}

export function toApiSubtitles(subtitles) {
  return [...subtitles]
    .sort((a, b) => a.start_time - b.start_time || a.end_time - b.end_time)
    .map(({ _clientId, ...subtitle }) => ({
      ...subtitle,
      text: String(subtitle.text ?? '').trim(),
      start_time: Number(subtitle.start_time),
      end_time: Number(subtitle.end_time),
    }))
}

export function validateSubtitles(subtitles) {
  for (let index = 0; index < subtitles.length; index += 1) {
    const subtitle = subtitles[index]
    if (!String(subtitle.text || '').trim()) {
      return `第 ${index + 1} 条字幕内容为空。`
    }
    if (!Number.isFinite(Number(subtitle.start_time)) || !Number.isFinite(Number(subtitle.end_time))) {
      return `第 ${index + 1} 条字幕时间格式无效。`
    }
    if (Number(subtitle.start_time) < 0 || Number(subtitle.end_time) <= Number(subtitle.start_time)) {
      return `第 ${index + 1} 条字幕的结束时间必须晚于开始时间。`
    }
  }
  return null
}

export function parseTimestamp(value) {
  if (typeof value === 'number') return value >= 0 && Number.isFinite(value) ? value : null

  const normalized = String(value).trim().replace(',', '.')
  if (!normalized) return null
  if (/^\d+(?:\.\d+)?$/.test(normalized)) return Number(normalized)

  const parts = normalized.split(':')
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) {
    return null
  }

  const numbers = parts.map(Number)
  const seconds = numbers.at(-1)
  if (seconds >= 60) return null

  if (parts.length === 2) {
    return numbers[0] * 60 + seconds
  }

  if (numbers[1] >= 60) return null
  return numbers[0] * 3600 + numbers[1] * 60 + seconds
}

export function formatTimestamp(value, showMilliseconds = true) {
  const safeValue = Math.max(0, toNumber(value))
  const totalMilliseconds = Math.round(safeValue * 1000)
  const hours = Math.floor(totalMilliseconds / 3_600_000)
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000)
  const seconds = Math.floor((totalMilliseconds % 60_000) / 1000)
  const milliseconds = totalMilliseconds % 1000
  const base = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return showMilliseconds ? `${base}.${String(milliseconds).padStart(3, '0')}` : base
}

export function formatCompactTime(value) {
  const safeValue = Math.max(0, toNumber(value))
  const hours = Math.floor(safeValue / 3600)
  const minutes = Math.floor((safeValue % 3600) / 60)
  const seconds = Math.floor(safeValue % 60)
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}
