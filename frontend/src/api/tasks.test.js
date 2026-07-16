import { afterEach, describe, expect, it, vi } from 'vitest'
import { API_BASE_URL, startTaskRecognition } from './tasks'

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
