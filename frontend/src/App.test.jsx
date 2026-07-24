import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import App from './App'
import { estimateTaskRoi, listTasks, startTaskRecognition } from './api/tasks'
import useTaskPolling from './hooks/useTaskPolling'

const TEST_ROI = { x: 0.1, y: 0.65, width: 0.8, height: 0.25 }

vi.mock('./api/tasks', () => ({
  archiveTask: vi.fn(),
  downloadSrt: vi.fn(),
  estimateTaskRoi: vi.fn(),
  getAudioSubtitles: vi.fn(),
  getSubtitles: vi.fn(),
  getVideoUrl: vi.fn((taskId) => `/api/tasks/${taskId}/video`),
  getVisualSubtitles: vi.fn(),
  listTasks: vi.fn(),
  saveSubtitles: vi.fn(),
  startTaskRecognition: vi.fn(),
  uploadVideo: vi.fn(),
}))

function renderApp(path = '/tasks/task-1') {
  const router = createMemoryRouter([{ path: '*', element: <App /> }], { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

vi.mock('./hooks/useTaskPolling', () => ({
  default: vi.fn(),
}))

vi.mock('./components/RoiSelectionPanel', () => ({
  default: ({ task, videoUrl, onConfirm, submitting, error, notice }) => (
    <section aria-label="ROI 状态页">
      <span>{videoUrl}</span>
      <span data-testid="manual-roi-seed">{JSON.stringify(task?.roi || null)}</span>
      {notice && <div role="status">{notice}</div>}
      {error && <div role="alert">{error}</div>}
      <button type="button" disabled={submitting} onClick={() => onConfirm(TEST_ROI)}>
        {submitting ? '正在启动识别' : '测试确认区域'}
      </button>
    </section>
  ),
}))

vi.mock('./components/AutoROIPreview', () => ({
  default: ({ videoUrl, roi, loading, submitting, error, onUse, onReselect }) => (
    <section aria-label="自动 ROI 预览">
      <span>{videoUrl}</span>
      {error && <div role="alert">{error}</div>}
      <button type="button" disabled={loading || submitting || !roi} onClick={() => onUse(roi)}>
        {submitting ? '正在启动识别' : '测试使用预测区域'}
      </button>
      <button type="button" disabled={submitting} onClick={onReselect}>测试重新选择</button>
    </section>
  ),
}))

describe('App ROI workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    estimateTaskRoi.mockResolvedValue({ success: false, reason: 'no subtitle detected' })
  })

  it('previews an automatic ROI and starts recognition through the original endpoint', async () => {
    const refresh = vi.fn()
    useTaskPolling.mockReturnValue({
      task: { taskId: 'task-1', status: 'awaiting_roi', filename: 'lesson.mp4' },
      loading: false,
      error: null,
      refresh,
    })
    estimateTaskRoi.mockResolvedValue({ success: true, roi: TEST_ROI })
    startTaskRecognition.mockResolvedValue({ taskId: 'task-1', status: 'queued' })

    renderApp()

    expect(screen.getByRole('region', { name: '自动 ROI 预览' })).toBeInTheDocument()
    expect(screen.getByText('/api/tasks/task-1/video')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: '测试使用预测区域' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '测试使用预测区域' }))

    await waitFor(() => expect(startTaskRecognition).toHaveBeenCalledWith('task-1', TEST_ROI))
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '正在启动识别' })).toBeDisabled()
  })

  it('lets the user reopen the unchanged manual selector with the prediction as its seed', async () => {
    useTaskPolling.mockReturnValue({
      task: { taskId: 'task-1', status: 'awaiting_roi', filename: 'lesson.mp4' },
      loading: false,
      error: null,
      refresh: vi.fn(),
    })
    estimateTaskRoi.mockResolvedValue({ success: true, roi: TEST_ROI })

    renderApp()
    await waitFor(() => expect(screen.getByRole('button', { name: '测试重新选择' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '测试重新选择' }))

    expect(await screen.findByRole('region', { name: 'ROI 状态页' })).toBeInTheDocument()
    expect(screen.getByTestId('manual-roi-seed')).toHaveTextContent(JSON.stringify(TEST_ROI))
  })

  it('automatically falls back to manual ROI when no subtitles are detected', async () => {
    useTaskPolling.mockReturnValue({
      task: { taskId: 'task-1', status: 'awaiting_roi', filename: 'silent.mp4' },
      loading: false,
      error: null,
      refresh: vi.fn(),
    })

    renderApp()

    expect(await screen.findByRole('region', { name: 'ROI 状态页' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('未检测到稳定的字幕区域')
    expect(screen.getByRole('button', { name: '测试确认区域' })).toBeEnabled()
  })

  it('falls back to manual ROI when the estimation request fails', async () => {
    useTaskPolling.mockReturnValue({
      task: { taskId: 'task-1', status: 'awaiting_roi', filename: 'offline.mp4' },
      loading: false,
      error: null,
      refresh: vi.fn(),
    })
    estimateTaskRoi.mockRejectedValue(new Error('AI offline'))

    renderApp()

    expect(await screen.findByRole('region', { name: 'ROI 状态页' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('自动字幕区域估计暂不可用')
    expect(startTaskRecognition).not.toHaveBeenCalled()
  })

  it('refreshes instead of reopening manual ROI when another tab already started the task', async () => {
    const refresh = vi.fn()
    useTaskPolling.mockReturnValue({
      task: { taskId: 'task-1', status: 'awaiting_roi', filename: 'shared.mp4' },
      loading: false,
      error: null,
      refresh,
    })
    estimateTaskRoi.mockRejectedValue(Object.assign(new Error('already queued'), { status: 409 }))

    renderApp()

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('region', { name: '自动 ROI 预览' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'ROI 状态页' })).not.toBeInTheDocument()
  })

  it('ignores a late estimation result after the user switches to manual ROI', async () => {
    let resolveEstimate
    useTaskPolling.mockReturnValue({
      task: { taskId: 'task-1', status: 'awaiting_roi', filename: 'manual.mp4' },
      loading: false,
      error: null,
      refresh: vi.fn(),
    })
    estimateTaskRoi.mockReturnValue(new Promise((resolve) => {
      resolveEstimate = resolve
    }))

    renderApp()
    fireEvent.click(await screen.findByRole('button', { name: '测试重新选择' }))
    expect(await screen.findByRole('region', { name: 'ROI 状态页' })).toBeInTheDocument()

    await act(async () => {
      resolveEstimate({ success: true, roi: TEST_ROI })
    })
    expect(screen.getByRole('region', { name: 'ROI 状态页' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '自动 ROI 预览' })).not.toBeInTheDocument()
  })

  it('keeps queued tasks on the existing processing screen', () => {
    useTaskPolling.mockReturnValue({
      task: { taskId: 'task-1', status: 'queued', filename: 'lesson.mp4', progress: 0 },
      loading: false,
      error: null,
      refresh: vi.fn(),
    })

    renderApp()

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

    renderApp()
    fireEvent.click(await screen.findByRole('button', { name: '测试确认区域' }))

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

    renderApp()
    fireEvent.click(await screen.findByRole('button', { name: '测试确认区域' }))

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('alert')).toHaveTextContent('网络连接中断')
    expect(screen.getByRole('button', { name: '测试确认区域' })).toBeEnabled()
  })

  it('restores a historical task through task-center, logo, back and forward navigation', async () => {
    listTasks.mockResolvedValue({
      tasks: [{
        id: 'task-1',
        taskId: 'task-1',
        filename: 'lesson.mp4',
        status: 'queued',
        progress: 12,
        subtitle_count: 0,
      }],
      pagination: { page: 1, limit: 12, total: 1, pages: 1 },
    })
    useTaskPolling.mockReturnValue({
      task: { taskId: 'task-1', status: 'queued', filename: 'lesson.mp4', progress: 12 },
      loading: false,
      error: null,
      refresh: vi.fn(),
    })
    const router = renderApp('/tasks')
    fireEvent.click(await screen.findByRole('button', { name: '查看进度' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks/task-1'))

    fireEvent.click(screen.getByRole('button', { name: '返回任务中心' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks'))
    await router.navigate(-1)
    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks/task-1'))
    await router.navigate(1)
    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks'))
  })
})
