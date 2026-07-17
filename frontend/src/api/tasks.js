const configuredBase = import.meta.env.VITE_API_BASE_URL?.trim()

export const API_BASE_URL = (configuredBase || 'http://localhost:3001/api').replace(/\/$/, '')

export class ApiError extends Error {
  constructor(message, status = 0, details = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.details = details
  }
}

const taskPath = (taskId, suffix = '') =>
  `${API_BASE_URL}/tasks/${encodeURIComponent(taskId)}${suffix}`

export function getTaskEventsUrl(taskId, afterSeq = null) {
  const url = taskPath(taskId, '/events')
  const sequence = Number(afterSeq)
  if (!Number.isSafeInteger(sequence) || sequence < 0) return url
  return `${url}?${new URLSearchParams({ after_seq: String(sequence) })}`
}

export function getTaskPreviewUrl(taskId, previewId, runId = '') {
  if (!previewId) return ''
  const url = taskPath(taskId, `/previews/${encodeURIComponent(previewId)}`)
  return runId ? `${url}?${new URLSearchParams({ run_id: runId })}` : url
}

async function readResponse(response) {
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    return response.json()
  }

  const text = await response.text()
  return text ? { message: text } : null
}

async function request(url, options = {}) {
  let response
  try {
    response = await fetch(url, options)
  } catch (error) {
    if (error.name === 'AbortError') throw error
    throw new ApiError('无法连接服务，请确认后端已启动并检查网络。', 0, error)
  }

  const payload = await readResponse(response)
  if (!response.ok) {
    throw new ApiError(
      payload?.message || payload?.error || `请求失败（${response.status}）`,
      response.status,
      payload,
    )
  }

  return payload
}

function dispatchSseMessage(fields, onEvent) {
  if (fields.data.length === 0) return
  let parsed
  try {
    parsed = JSON.parse(fields.data.join('\n'))
  } catch {
    return
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
  onEvent?.({
    ...parsed,
    type: parsed.type || fields.event || 'message',
    sse_id: fields.id || parsed.sse_id || '',
  })
}

/**
 * Consume one SSE response. Reconnection stays with the caller so it can use
 * the latest accepted run_id + seq cursor and a bounded retry policy.
 */
export async function streamTaskEvents(taskId, {
  afterSeq = 0,
  lastEventId = '',
  signal,
  onOpen,
  onEvent,
} = {}) {
  const headers = {
    Accept: 'text/event-stream',
    'Cache-Control': 'no-cache',
  }
  if (lastEventId) headers['Last-Event-ID'] = lastEventId

  let response
  try {
    response = await fetch(getTaskEventsUrl(taskId, afterSeq), { headers, signal })
  } catch (error) {
    if (error.name === 'AbortError') throw error
    throw new ApiError('实时分析连接失败。', 0, error)
  }

  if (!response.ok) {
    const payload = await readResponse(response)
    throw new ApiError(
      payload?.message || payload?.error || `实时分析连接失败（${response.status}）`,
      response.status,
      payload,
    )
  }
  if (!response.body?.getReader) throw new ApiError('当前浏览器不支持流式分析进度。')

  onOpen?.(response)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fields = { data: [], event: '', id: '' }

  const consumeLine = (rawLine) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line) {
      dispatchSseMessage(fields, onEvent)
      fields = { data: [], event: '', id: '' }
      return
    }
    if (line.startsWith(':')) return

    const colon = line.indexOf(':')
    const name = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (name === 'data') fields.data.push(value)
    else if (name === 'event') fields.event = value
    else if (name === 'id' && !value.includes('\0')) fields.id = value
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        consumeLine(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
      if (done) break
    }
    if (buffer) consumeLine(buffer)
    dispatchSseMessage(fields, onEvent)
  } finally {
    reader.releaseLock?.()
  }
}

export function uploadVideo(file, onProgress) {
  return new Promise((resolve, reject) => {
    const formData = new FormData()
    formData.append('video', file)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_BASE_URL}/tasks`)
    xhr.responseType = 'json'

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        onProgress?.(Math.round((event.loaded / event.total) * 100))
      }
    })

    xhr.addEventListener('load', () => {
      const payload = xhr.response || safeParseJson(xhr.responseText)
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload)
        return
      }
      reject(
        new ApiError(
          payload?.message || payload?.error || `上传失败（${xhr.status}）`,
          xhr.status,
          payload,
        ),
      )
    })
    xhr.addEventListener('error', () => {
      reject(new ApiError('视频上传失败，请检查网络连接。'))
    })
    xhr.addEventListener('abort', () => {
      reject(new ApiError('视频上传已取消。'))
    })
    xhr.send(formData)
  })
}

function safeParseJson(value) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export function getTask(taskId, signal) {
  return request(taskPath(taskId), { signal })
}

export async function listTasks({ page = 1, limit = 12, status = '', search = '', signal } = {}) {
  const query = new URLSearchParams({ page: String(page), limit: String(limit) })
  if (status) query.set('status', status)
  if (search) query.set('search', search)
  const payload = await request(`${API_BASE_URL}/tasks?${query}`, { signal })
  return {
    tasks: payload?.tasks || [],
    pagination: payload?.pagination || { page, limit, total: 0, pages: 0 },
  }
}

export async function startTaskRecognition(taskId, roi) {
  const payload = await request(taskPath(taskId, '/start'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roi }),
  })
  return payload?.task || payload?.data || payload
}

export async function getSubtitles(taskId, signal) {
  const payload = await request(taskPath(taskId, '/subtitles'), { signal })
  return { subtitles: payload?.subtitles || [], revision: Number(payload?.revision) || 0 }
}

export async function saveSubtitles(taskId, subtitles, expectedRevision) {
  const payload = await request(taskPath(taskId, '/subtitles'), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'If-Match': `"${expectedRevision}"`,
    },
    body: JSON.stringify({ subtitles }),
  })
  return {
    subtitles: payload?.subtitles || subtitles,
    revision: Number(payload?.revision ?? expectedRevision + 1),
  }
}

export function archiveTask(taskId) {
  return request(taskPath(taskId, '/archive'), { method: 'PATCH' })
}

export function getVideoUrl(taskId) {
  return taskPath(taskId, '/video')
}

export async function downloadSrt(taskId, fallbackName = 'final.srt') {
  let response
  try {
    response = await fetch(taskPath(taskId, '/export'))
  } catch (error) {
    throw new ApiError('导出失败，请检查网络连接。', 0, error)
  }

  if (!response.ok) {
    const payload = await readResponse(response)
    throw new ApiError(
      payload?.message || payload?.error || `导出失败（${response.status}）`,
      response.status,
      payload,
    )
  }

  const blob = await response.blob()
  const disposition = response.headers.get('content-disposition') || ''
  const utf8Name = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  const basicName = disposition.match(/filename="?([^";]+)"?/i)?.[1]
  const filename = decodeURIComponent(utf8Name || basicName || fallbackName)
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(objectUrl)
}
