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
  return payload?.subtitles || []
}

export async function saveSubtitles(taskId, subtitles) {
  const payload = await request(taskPath(taskId, '/subtitles'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subtitles }),
  })
  return payload?.subtitles || subtitles
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
