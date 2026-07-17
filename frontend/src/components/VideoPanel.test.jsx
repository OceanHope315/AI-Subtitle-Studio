import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import VideoPanel from './VideoPanel'

const baseProps = {
  videoUrl: '/video.mp4',
  filename: 'video.mp4',
  currentSubtitle: null,
  duration: 10,
  frameRate: 29.97,
  onMediaTime: vi.fn(),
  onDurationChange: vi.fn(),
  onError: vi.fn(),
}

afterEach(() => {
  vi.restoreAllMocks()
  delete HTMLVideoElement.prototype.requestVideoFrameCallback
  delete HTMLVideoElement.prototype.cancelVideoFrameCallback
})

describe('VideoPanel presentation-frame synchronization', () => {
  it('uses requestVideoFrameCallback mediaTime and does not depend on timeupdate', () => {
    let frameCallback
    HTMLVideoElement.prototype.requestVideoFrameCallback = vi.fn((callback) => {
      frameCallback = callback
      return 7
    })
    HTMLVideoElement.prototype.cancelVideoFrameCallback = vi.fn()
    const onMediaTime = vi.fn()
    const { container } = render(<VideoPanel {...baseProps} onMediaTime={onMediaTime} />)
    const video = container.querySelector('video')

    fireEvent.timeUpdate(video)
    expect(onMediaTime).not.toHaveBeenCalled()
    act(() => frameCallback(0, { mediaTime: 1.234 }))
    expect(onMediaTime).toHaveBeenCalledWith(1.234)
    expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(2)
  })

  it('falls back to requestAnimationFrame with currentTime', () => {
    let animationCallback
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      animationCallback = callback
      return 11
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    const onMediaTime = vi.fn()
    const { container } = render(<VideoPanel {...baseProps} onMediaTime={onMediaTime} />)
    const video = container.querySelector('video')
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 2.5 })

    act(() => animationCallback(0))
    expect(onMediaTime).toHaveBeenCalledWith(2.5)
  })

  it('steps by the exact task frame-rate interval and synchronizes immediately', () => {
    HTMLVideoElement.prototype.requestVideoFrameCallback = vi.fn(() => 1)
    HTMLVideoElement.prototype.cancelVideoFrameCallback = vi.fn()
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const onMediaTime = vi.fn()
    const { container } = render(<VideoPanel {...baseProps} onMediaTime={onMediaTime} />)
    const video = container.querySelector('video')
    Object.defineProperty(video, 'duration', { configurable: true, value: 10 })
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 1 })

    fireEvent.click(screen.getByRole('button', { name: '前进一帧' }))
    expect(video.currentTime).toBeCloseTo(1 + 1 / 29.97, 8)
    expect(onMediaTime).toHaveBeenLastCalledWith(video.currentTime)
  })
})
