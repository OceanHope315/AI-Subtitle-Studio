import { makeClientId } from './subtitles'

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function normalizeConfidence(value) {
  const confidence = finiteNumber(value)
  if (confidence === null) return null
  return Math.max(0, Math.min(1, confidence))
}

function sortByStart(items) {
  return items.sort((left, right) => {
    const leftStart = left.start ?? Number.POSITIVE_INFINITY
    const rightStart = right.start ?? Number.POSITIVE_INFINITY
    return leftStart - rightStart
  })
}

export function normalizeVisualSubtitles(subtitles = []) {
  if (!Array.isArray(subtitles)) return []
  return sortByStart(subtitles.map((subtitle, index) => ({
    _sourceId: `visual:${subtitle?.id || subtitle?.taskId || subtitle?.task_id || 'task'}:${index}`,
    taskId: String(subtitle?.taskId ?? subtitle?.task_id ?? ''),
    text: String(subtitle?.text ?? ''),
    start: finiteNumber(subtitle?.start ?? subtitle?.start_time),
    end: finiteNumber(subtitle?.end ?? subtitle?.end_time),
    bbox: Array.isArray(subtitle?.bbox)
      ? subtitle.bbox
      : (Array.isArray(subtitle?.position) ? subtitle.position : []),
    confidence: normalizeConfidence(subtitle?.confidence),
  })))
}

function normalizeAudioWord(word = {}, index = 0) {
  return {
    _sourceId: `word:${index}`,
    word: String(word.word ?? word.text ?? ''),
    start: finiteNumber(word.start ?? word.start_time),
    end: finiteNumber(word.end ?? word.end_time),
    confidence: normalizeConfidence(word.confidence),
  }
}

function firstWordStart(words) {
  return words.find((word) => word.start !== null)?.start ?? null
}

function lastWordEnd(words) {
  return [...words].reverse().find((word) => word.end !== null)?.end ?? null
}

export function normalizeAudioSubtitles(subtitles = []) {
  if (!Array.isArray(subtitles)) return []
  return sortByStart(subtitles.map((subtitle, index) => {
    const words = Array.isArray(subtitle?.words)
      ? subtitle.words.map(normalizeAudioWord)
      : []
    return {
      _sourceId: `audio:${subtitle?.id || subtitle?.taskId || subtitle?.task_id || 'task'}:${index}`,
      taskId: String(subtitle?.taskId ?? subtitle?.task_id ?? ''),
      text: String(subtitle?.text ?? ''),
      start: finiteNumber(subtitle?.start ?? subtitle?.start_time) ?? firstWordStart(words),
      end: finiteNumber(subtitle?.end ?? subtitle?.end_time) ?? lastWordEnd(words),
      words,
      confidence: normalizeConfidence(subtitle?.confidence),
    }
  }))
}

function hasUsableCue(subtitle) {
  return Boolean(
    String(subtitle?.text ?? '').trim()
    && Number.isFinite(subtitle?.start)
    && Number.isFinite(subtitle?.end)
    && subtitle.start >= 0
    && subtitle.end > subtitle.start,
  )
}

export function visualTrackToFinalSubtitles(subtitles = []) {
  return subtitles.filter(hasUsableCue).map((subtitle) => {
    const id = makeClientId()
    const position = Array.isArray(subtitle.bbox)
      && subtitle.bbox.length === 4
      && subtitle.bbox.every((value) => Number.isFinite(Number(value)))
      ? subtitle.bbox.map(Number)
      : null
    return {
      _clientId: id,
      id,
      text: subtitle.text.trim(),
      start_time: subtitle.start,
      end_time: subtitle.end,
      confidence: subtitle.confidence,
      position,
      source: 'visual',
    }
  })
}

export function audioTrackToFinalSubtitles(subtitles = []) {
  return subtitles.filter(hasUsableCue).map((subtitle) => {
    const id = makeClientId()
    return {
      _clientId: id,
      id,
      text: subtitle.text.trim(),
      start_time: subtitle.start,
      end_time: subtitle.end,
      confidence: subtitle.confidence,
      source: 'audio',
    }
  })
}
