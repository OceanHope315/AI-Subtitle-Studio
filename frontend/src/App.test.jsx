import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { startTaskRecognition } from './api/tasks'
import useTaskPolling from './hooks/useTaskPolling'

const TEST_ROI = { x: 0.1, y: 0.65, width: 0.8, height: 0.25 }

vi.mock('./api/tasks', () => ({
  downloadSrt: vi.fn(),
  getSubtitles: vi.fn(),
  getVideoUrl: vi.fn((taskId) => `/api/tasks/${taskId}/video`),
  saveSubtitles: vi.fn(),
  startTaskRecognition: vi.fn(),
  uploadVideo: vi.fn(),
}))

vi.mock('./hooks/useTaskPolling', () => ({
  default: vi.fn(),
}))

vi.mock('./components/RoiSelectionPanel', () => ({
  default: ({ videoUrl, onConfirm, submitting, error }) => (
    <section aria-label="ROI 状态页">
      <span>{videoUrl}</span>
      {error && <div role="alert">{error}</div>}
      <button type="button" disabled={submitting} onClick={() => onConfirm(TEST_ROI)}>
        {submitting ? '正在启动识别' : '测试确认区域'}
      </button>
    </section>
  ),
}))

describe('App ROI workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState({}, '', '/?task=task-1')
  })

  it('routes awaiting_roi tasks to region selection and starts recognition', async () => {
    const refresh = vi.fn()
    useTaskPolling.mockReturnValue({
      task: { taskId: 'task-1', status: 'awaiting_roi', filename: 'lesson.mp4' },
      loading: false,
      error: null,
      refresh,
    })
    startTaskRecognition.mockResolvedValue({ taskId: 'task-1', status: 'queued' })

    render(<App />)

    expect(screen.getByRole('region', { name: 'ROI 状态页' })).toBeInTheDocument()
    expect(screen.getByText('/api/tasks/task-1/video')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '测试确认区域' }))

    await waitFor(() => expect(startTaskRecognition).toHaveBeenCalledWith('task-1', TEST_ROI))
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '正在启动识别' })).toBeDisabled()
  })

  it('keeps queued tasks on the existing processing screen', () => {
    useTaskPolling.mockReturnValue({
      task: { taskId: 'task-1', status: 'queued', filename: 'lesson.mp4', progress: 0 },
      loading: false,
      error: null,
      refresh: vi.fn(),
    })

    render(<App />)

    expect(screen.queryByRole('region', { name: 'ROI 状态页' })).not.toBeInTheDocument()
    expect(screen.getByText('正在提取视频字幕')).toBeInTheDocument()
  })

  it('recovers a duplicate start conflict instead of trapping the user on the ROI page', async () => {
    const refresh = vi.fn()
    useTaskPolling.mockReturnValue({
      task: { taskId: 'task-1', status: 'awaiting_roi', filename: 'lesson.mp4' },
      loading: false,
      error: null,
      refresh,
    })
    startTaskRecognition.mockRejectedValue(Object.assign(new Error('Task is already queued'), {
      status: 409,
    }))

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '测试确认区域' }))

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '正在启动识别' })).toBeDisabled()
  })

  it('refreshes after an ambiguous network failure while allowing an explicit retry', async () => {
    const refresh = vi.fn()
    useTaskPolling.mockReturnValue({
      task: { taskId: 'task-1', status: 'awaiting_roi', filename: 'lesson.mp4' },
      loading: false,
      error: null,
      refresh,
    })
    startTaskRecognition.mockRejectedValue(Object.assign(new Error('网络连接中断'), { status: 0 }))

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '测试确认区域' }))

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('alert')).toHaveTextContent('网络连接中断')
    expect(screen.getByRole('button', { name: '测试确认区域' })).toBeEnabled()
  })
})
