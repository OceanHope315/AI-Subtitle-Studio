import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TaskWorkspace from './TaskWorkspace'
import {
  downloadSrt,
  getAudioSubtitles,
  getSubtitles,
  getVisualSubtitles,
  saveSubtitles,
} from '../api/tasks'
import useTaskPolling from '../hooks/useTaskPolling'
import { deleteSubtitleDraft, getSubtitleDraft, saveSubtitleDraft } from '../utils/draftStore'

vi.mock('../api/tasks', () => ({
  downloadSrt: vi.fn(),
  estimateTaskRoi: vi.fn(),
  getAudioSubtitles: vi.fn(),
  getSubtitles: vi.fn(),
  getVideoUrl: vi.fn(() => '/video.mp4'),
  getVisualSubtitles: vi.fn(),
  saveSubtitles: vi.fn(),
  startTaskRecognition: vi.fn(),
}))

vi.mock('../hooks/useTaskPolling', () => ({ default: vi.fn() }))
vi.mock('../utils/draftStore', () => ({
  deleteSubtitleDraft: vi.fn(),
  getSubtitleDraft: vi.fn(),
  saveSubtitleDraft: vi.fn(),
}))
vi.mock('./EditorPage', () => ({
  default: ({
    analysisMode,
    subtitles,
    visualSubtitles,
    audioSubtitles,
    visualSubtitlesError,
    audioSubtitlesError,
    onSubtitleChange,
    onUseVisual,
    onUseAudio,
  }) => (
    <section aria-label="测试编辑器">
      <span data-testid="analysis-mode">{analysisMode}</span>
      <span>{subtitles[0]?.text}</span>
      <span data-testid="visual-source">{visualSubtitles?.[0]?.text || visualSubtitlesError?.message}</span>
      <span data-testid="audio-source">{audioSubtitles?.[0]?.text || audioSubtitlesError?.message}</span>
      <button type="button" onClick={() => onSubtitleChange('line-1', { text: 'edited text' })}>修改字幕</button>
      <button type="button" onClick={onUseVisual}>Use Visual</button>
      <button type="button" onClick={onUseAudio}>Use Audio</button>
    </section>
  ),
}))

function renderWorkspace() {
  const router = createMemoryRouter([
    { path: '/tasks/:taskId', element: <TaskWorkspace /> },
    { path: '/tasks', element: <div>任务中心目标页</div> },
  ], { initialEntries: ['/tasks/00000000-0000-4000-8000-000000000001'] })
  render(<RouterProvider router={router} />)
  return router
}

describe('TaskWorkspace subtitle safety', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useTaskPolling.mockReturnValue({
      task: {
        taskId: '00000000-0000-4000-8000-000000000001',
        status: 'completed',
        filename: 'lesson.mp4',
        metadata: { fps: 29.97 },
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    })
    getSubtitles.mockResolvedValue({
      subtitles: [{ id: 'line-1', text: 'original', start_time: 0, end_time: 1 }],
      revision: 3,
    })
    getVisualSubtitles.mockResolvedValue([])
    getAudioSubtitles.mockResolvedValue([])
    getSubtitleDraft.mockResolvedValue(null)
    deleteSubtitleDraft.mockResolvedValue(undefined)
    saveSubtitleDraft.mockResolvedValue(undefined)
  })

  it('debounces edits and saves with the loaded revision', async () => {
    saveSubtitles.mockResolvedValue({
      subtitles: [{ id: 'line-1', text: 'edited text', start_time: 0, end_time: 1 }],
      revision: 4,
    })
    renderWorkspace()
    await screen.findByText('original')
    fireEvent.click(screen.getByRole('button', { name: '修改字幕' }))

    await waitFor(() => expect(saveSubtitles).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      [expect.objectContaining({ text: 'edited text' })],
      3,
    ), { timeout: 2000 })
    await waitFor(() => expect(screen.getByText('任务已保存 · 字幕已同步')).toBeInTheDocument())
  })

  it('stores an IndexedDB offline draft when the network save fails', async () => {
    saveSubtitles.mockRejectedValue(Object.assign(new Error('offline'), { status: 0 }))
    renderWorkspace()
    await screen.findByText('original')
    fireEvent.click(screen.getByRole('button', { name: '修改字幕' }))

    await waitFor(() => expect(saveSubtitleDraft).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      expect.arrayContaining([expect.objectContaining({ text: 'edited text' })]),
      3,
    ), { timeout: 2000 })
    expect(screen.getByText(/当前为离线草稿/)).toBeInTheDocument()
  })

  it('does not export a stale server SRT when the final track only reached an offline draft', async () => {
    saveSubtitles.mockRejectedValue(Object.assign(new Error('offline'), { status: 0 }))
    renderWorkspace()
    await screen.findByText('original')
    fireEvent.click(screen.getByRole('button', { name: '修改字幕' }))
    fireEvent.click(screen.getByRole('button', { name: '导出 SRT' }))

    await waitFor(() => expect(screen.getByText(/已阻止导出旧版 SRT/)).toBeInTheDocument())
    expect(downloadSrt).not.toHaveBeenCalled()
  })

  it('keeps stale edits as a conflict draft after a 409', async () => {
    saveSubtitles.mockRejectedValue(Object.assign(new Error('conflict'), { status: 409 }))
    renderWorkspace()
    await screen.findByText('original')
    fireEvent.click(screen.getByRole('button', { name: '修改字幕' }))

    await waitFor(() => expect(screen.getByText(/版本冲突：服务端内容未被覆盖/)).toBeInTheDocument(), { timeout: 2000 })
    expect(saveSubtitleDraft).toHaveBeenCalled()
    expect(screen.getByText('任务已保存 · 版本冲突')).toBeInTheDocument()
  })

  it('detects and restores a task-scoped IndexedDB draft on re-entry', async () => {
    getSubtitleDraft.mockResolvedValue({
      taskId: '00000000-0000-4000-8000-000000000001',
      revision: 3,
      updatedAt: '2026-07-17T00:00:00.000Z',
      subtitles: [{ id: 'line-1', text: 'local draft', start_time: 0, end_time: 1 }],
    })
    renderWorkspace()
    expect(await screen.findByRole('dialog', { name: '发现本地字幕草稿' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '恢复草稿' }))
    expect(screen.getByText('local draft')).toBeInTheDocument()
    expect(screen.getByText(/当前为离线草稿/)).toBeInTheDocument()
  })

  it('offers save, discard and cancel choices before route navigation', async () => {
    renderWorkspace()
    await screen.findByText('original')
    fireEvent.click(screen.getByRole('button', { name: '修改字幕' }))
    fireEvent.click(screen.getByRole('button', { name: '返回任务中心' }))

    expect(screen.getByRole('dialog', { name: '字幕修改尚未同步' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存并离开' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '放弃修改' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
  })

  it('loads visual and audio sources independently when one endpoint fails', async () => {
    getVisualSubtitles.mockRejectedValue(new Error('visual unavailable'))
    getAudioSubtitles.mockResolvedValue([{
      taskId: '00000000-0000-4000-8000-000000000001',
      text: 'audio survived',
      start: 1,
      end: 2,
      words: [],
      confidence: 0.9,
    }])

    renderWorkspace()

    await waitFor(() => expect(screen.getByTestId('visual-source')).toHaveTextContent('visual unavailable'))
    expect(screen.getByTestId('audio-source')).toHaveTextContent('audio survived')
  })

  it('loads final and audio tracks but skips the visual endpoint in audio-only mode', async () => {
    useTaskPolling.mockReturnValue({
      task: {
        taskId: '00000000-0000-4000-8000-000000000001',
        status: 'completed',
        filename: 'podcast.mp4',
        analysis_mode: 'audio',
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    })
    getAudioSubtitles.mockResolvedValue([{
      taskId: '00000000-0000-4000-8000-000000000001',
      text: 'audio only result',
      start: 1,
      end: 2,
      words: [],
    }])

    renderWorkspace()

    expect(await screen.findByText('original')).toBeInTheDocument()
    await waitFor(() => expect(getAudioSubtitles).toHaveBeenCalledTimes(1))
    expect(getSubtitles).toHaveBeenCalledTimes(1)
    expect(getVisualSubtitles).not.toHaveBeenCalled()
    expect(screen.getByTestId('analysis-mode')).toHaveTextContent('audio')
    expect(screen.getByTestId('audio-source')).toHaveTextContent('audio only result')
  })

  it('replaces the whole final track from audio words and saves only FinalSubtitle fields', async () => {
    getAudioSubtitles.mockResolvedValue([{
      taskId: '00000000-0000-4000-8000-000000000001',
      text: 'watch out',
      words: [
        { word: 'watch', start: 21.05, end: 21.25 },
        { word: 'out', start: 21.25, end: 21.4 },
      ],
      confidence: 0.9,
    }])
    saveSubtitles.mockImplementation(async (_taskId, subtitles) => ({ subtitles, revision: 4 }))

    renderWorkspace()
    await waitFor(() => expect(screen.getByTestId('audio-source')).toHaveTextContent('watch out'))
    fireEvent.click(screen.getByRole('button', { name: 'Use Audio' }))

    await waitFor(() => expect(saveSubtitles).toHaveBeenCalled(), { timeout: 2000 })
    const savedTrack = saveSubtitles.mock.calls.at(-1)[1]
    expect(savedTrack).toHaveLength(1)
    expect(savedTrack[0]).toMatchObject({
      text: 'watch out',
      start_time: 21.05,
      end_time: 21.4,
      confidence: 0.9,
      source: 'audio',
    })
    expect(savedTrack[0]).not.toHaveProperty('words')
    expect(savedTrack[0]).not.toHaveProperty('taskId')
  })
})
