import { afterEach, describe, expect, it, vi } from 'vitest'
import { API_BASE_URL, listTasks, saveSubtitles, startTaskRecognition } from './tasks'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('startTaskRecognition', () => {
  it('posts the normalized ROI and returns the updated task', async () => {
    const updatedTask = { taskId: 'task/123', status: 'queued' }
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify(updatedTask),
      { status: 202, headers: { 'Content-Type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)
    const roi = { x: 0.1, y: 0.7, width: 0.8, height: 0.2 }

    await expect(startTaskRecognition('task/123', roi)).resolves.toEqual(updatedTask)
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE_URL}/tasks/task%2F123/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roi }),
    })
  })

  it('surfaces the backend error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: '区域过小' }),
      { status: 422, headers: { 'Content-Type': 'application/json' } },
    )))

    await expect(startTaskRecognition('task-1', { x: 0, y: 0, width: 1, height: 1 }))
      .rejects.toEqual(expect.objectContaining({
        name: 'ApiError',
        message: '区域过小',
        status: 422,
      }))
  })
})

describe('task summaries and revisions', () => {
  it('requests paginated filtered task summaries', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      tasks: [{ id: 'one', subtitle_count: 3 }],
      pagination: { page: 2, limit: 12, total: 13, pages: 2 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await listTasks({ page: 2, status: 'completed', search: 'lesson' })
    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE_URL}/tasks?page=2&limit=12&status=completed&search=lesson`)
  })

  it('sends If-Match and returns the next subtitle revision', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      subtitles: [{ id: 'one', text: 'saved', start_time: 0, end_time: 1 }],
      revision: 8,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const subtitles = [{ id: 'one', text: 'saved', start_time: 0, end_time: 1 }]

    await expect(saveSubtitles('task-1', subtitles, 7)).resolves.toMatchObject({ revision: 8 })
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE_URL}/tasks/task-1/subtitles`, expect.objectContaining({
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"7"' },
    }))
  })
})
