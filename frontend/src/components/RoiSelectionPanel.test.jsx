import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RoiSelectionPanel from './RoiSelectionPanel'
import { DEFAULT_SUBTITLE_ROI } from '../utils/roi'

function loadVideoMetadata(container, stageRect = { left: 0, top: 0, width: 800, height: 600 }) {
  const stage = screen.getByTestId('roi-video-stage')
  const video = container.querySelector('video')
  stage.getBoundingClientRect = () => ({
    ...stageRect,
    right: stageRect.left + stageRect.width,
    bottom: stageRect.top + stageRect.height,
  })
  Object.defineProperties(video, {
    videoWidth: { configurable: true, value: 1920 },
    videoHeight: { configurable: true, value: 1080 },
    duration: { configurable: true, value: 30 },
  })
  fireEvent.loadedMetadata(video)
  return video
}

describe('RoiSelectionPanel', () => {
  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('aligns the selection surface with the actual letterboxed video content', () => {
    const { container } = render(
      <RoiSelectionPanel
        task={{ taskId: 'task-1', filename: 'lesson.mp4' }}
        videoUrl="/api/tasks/task-1/video"
        onConfirm={vi.fn()}
        onNewTask={vi.fn()}
      />,
    )

    loadVideoMetadata(container)
    const surface = screen.getByTestId('roi-coordinate-surface')
    expect(surface).toHaveStyle({ left: '0px', top: '75px', width: '800px', height: '450px' })
    expect(screen.getByRole('group', { name: '字幕识别区域' })).toHaveStyle({
      left: '8%',
      top: '52%',
      width: '84%',
      height: '24%',
    })
  })

  it('supports drawing a new ROI and confirms normalized coordinates', () => {
    const onConfirm = vi.fn()
    const { container } = render(
      <RoiSelectionPanel
        task={{ taskId: 'task-2' }}
        videoUrl="/video.mp4"
        onConfirm={onConfirm}
        onNewTask={vi.fn()}
      />,
    )
    loadVideoMetadata(container)
    const surface = screen.getByTestId('roi-coordinate-surface')
    surface.getBoundingClientRect = () => ({ left: 0, top: 75, width: 800, height: 450, right: 800, bottom: 525 })

    fireEvent.pointerDown(surface, { button: 0, pointerId: 3, clientX: 80, clientY: 345 })
    fireEvent.pointerMove(surface, { pointerId: 3, clientX: 720, clientY: 480 })
    fireEvent.pointerUp(surface, { pointerId: 3 })
    fireEvent.click(screen.getByRole('button', { name: '确认区域并开始识别' }))

    expect(onConfirm).toHaveBeenCalledWith({ x: 0.1, y: 0.6, width: 0.8, height: 0.3 })
  })

  it('moves and resizes the region without crossing the video boundary', () => {
    const onConfirm = vi.fn()
    const { container } = render(
      <RoiSelectionPanel
        task={{ taskId: 'task-3', roi: { x: 0.2, y: 0.6, width: 0.5, height: 0.2 } }}
        videoUrl="/video.mp4"
        onConfirm={onConfirm}
        onNewTask={vi.fn()}
      />,
    )
    loadVideoMetadata(container)
    const surface = screen.getByTestId('roi-coordinate-surface')
    surface.getBoundingClientRect = () => ({ left: 0, top: 75, width: 800, height: 450, right: 800, bottom: 525 })
    const selection = screen.getByRole('group', { name: '字幕识别区域' })

    fireEvent.pointerDown(selection, { button: 0, pointerId: 4, clientX: 360, clientY: 390 })
    fireEvent.pointerMove(surface, { pointerId: 4, clientX: 680, clientY: 525 })
    fireEvent.pointerUp(surface, { pointerId: 4 })
    fireEvent.pointerDown(screen.getByRole('button', { name: '调整字幕区域左边' }), {
      button: 0,
      pointerId: 5,
      clientX: 400,
      clientY: 435,
    })
    fireEvent.pointerMove(surface, { pointerId: 5, clientX: 240, clientY: 435 })
    fireEvent.pointerUp(surface, { pointerId: 5 })
    fireEvent.click(screen.getByRole('button', { name: '确认区域并开始识别' }))

    expect(onConfirm).toHaveBeenCalledWith({ x: 0.3, y: 0.8, width: 0.7, height: 0.2 })
  })

  it('restores the recommended bottom region and exposes submission errors', () => {
    const onConfirm = vi.fn()
    const { container } = render(
      <RoiSelectionPanel
        task={{ taskId: 'task-4', roi: { x: 0.2, y: 0.2, width: 0.4, height: 0.3 } }}
        videoUrl="/video.mp4"
        error="无法启动识别"
        onConfirm={onConfirm}
        onNewTask={vi.fn()}
      />,
    )
    loadVideoMetadata(container)

    fireEvent.click(screen.getByRole('button', { name: '恢复推荐区域' }))
    fireEvent.click(screen.getByRole('button', { name: '确认区域并开始识别' }))

    expect(onConfirm).toHaveBeenCalledWith(DEFAULT_SUBTITLE_ROI)
    expect(screen.getByRole('alert')).toHaveTextContent('无法启动识别')
  })

  it('keeps seeking and confirmation enabled when play() is rejected', async () => {
    const { container } = render(
      <RoiSelectionPanel
        task={{ taskId: 'task-5' }}
        videoUrl="/video.mp4"
        onConfirm={vi.fn()}
        onNewTask={vi.fn()}
      />,
    )
    const video = loadVideoMetadata(container)
    Object.defineProperty(video, 'paused', { configurable: true, value: true })
    Object.defineProperty(video, 'play', {
      configurable: true,
      value: vi.fn().mockRejectedValue(new Error('play blocked')),
    })

    fireEvent.click(screen.getByRole('button', { name: '播放视频' }))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('浏览器阻止了视频播放'))
    expect(screen.getByRole('slider', { name: '视频播放进度' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '确认区域并开始识别' })).toBeEnabled()
  })
})
