import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AutoROIPreview from './AutoROIPreview'

const PREDICTED_ROI = { x: 0.12, y: 0.7, width: 0.76, height: 0.16 }

function loadFirstFrame(container) {
  const stage = screen.getByTestId('auto-roi-video-stage')
  const video = container.querySelector('video')
  stage.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 800,
    height: 600,
    right: 800,
    bottom: 600,
  })
  Object.defineProperties(video, {
    videoWidth: { configurable: true, value: 1920 },
    videoHeight: { configurable: true, value: 1080 },
  })
  fireEvent.loadedMetadata(video)
  fireEvent.loadedData(video)
}

describe('AutoROIPreview', () => {
  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('aligns a green predicted ROI with the first video frame and confirms it', () => {
    const onUse = vi.fn()
    const { container } = render(
      <AutoROIPreview
        task={{ filename: 'gameplay.mp4' }}
        videoUrl="/api/tasks/task-1/video"
        roi={PREDICTED_ROI}
        onUse={onUse}
        onReselect={vi.fn()}
        onNewTask={vi.fn()}
      />,
    )
    loadFirstFrame(container)

    expect(screen.getByLabelText('预测区域视频第一帧')).toHaveAttribute('src', '/api/tasks/task-1/video')
    expect(screen.getByTestId('auto-roi-coordinate-surface')).toHaveStyle({
      left: '0px',
      top: '75px',
      width: '800px',
      height: '450px',
    })
    expect(screen.getByRole('group', { name: 'AI 预测字幕区域' })).toHaveClass('auto-roi-selection')
    expect(screen.getByRole('group', { name: 'AI 预测字幕区域' })).toHaveStyle({
      left: '12%',
      top: '70%',
      width: '76%',
      height: '16%',
    })
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'false')

    fireEvent.click(screen.getByRole('button', { name: '使用该区域' }))
    expect(onUse).toHaveBeenCalledWith(PREDICTED_ROI)
  })

  it('allows immediate manual selection while estimation is still running', () => {
    const onReselect = vi.fn()
    render(
      <AutoROIPreview
        task={{ filename: 'gameplay.mp4' }}
        videoUrl="/video.mp4"
        roi={null}
        loading
        onUse={vi.fn()}
        onReselect={onReselect}
        onNewTask={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: '使用该区域' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(screen.getByRole('button', { name: '重新选择' }))
    expect(onReselect).toHaveBeenCalledTimes(1)
  })
})
