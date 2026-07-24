import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import SourceSubtitleTracks from './SourceSubtitleTracks'

const visualSubtitles = [{
  _sourceId: 'visual:1',
  text: 'WATCH OUT',
  start: 21.1,
  end: 21.4,
  bbox: [[10, 20], [30, 40]],
  confidence: 0.95,
}]

const audioSubtitles = [{
  _sourceId: 'audio:1',
  text: 'watch out',
  start: 21.05,
  end: 21.4,
  confidence: 0.9,
  words: [
    { _sourceId: 'word:0', word: 'watch', start: 21.05, end: 21.25, confidence: 0.93 },
    { _sourceId: 'word:1', word: 'out', start: 21.25, end: 21.4, confidence: null },
    { _sourceId: 'word:2', word: 'unaligned', start: null, end: null, confidence: null },
  ],
}]

describe('SourceSubtitleTracks', () => {
  it('renders independent visual and audio metadata and seeks from either source', () => {
    const onSeek = vi.fn()
    const onUseVisual = vi.fn()
    const onUseAudio = vi.fn()
    render(
      <SourceSubtitleTracks
        visualSubtitles={visualSubtitles}
        audioSubtitles={audioSubtitles}
        onSeek={onSeek}
        onUseVisual={onUseVisual}
        onUseAudio={onUseAudio}
      />,
    )

    expect(screen.getByRole('region', { name: '独立字幕来源' })).toBeInTheDocument()
    expect(screen.getByText('WATCH OUT')).toBeInTheDocument()
    expect(screen.getByText('(10, 20) (30, 40)')).toBeInTheDocument()
    expect(screen.getByText('watch')).toBeInTheDocument()
    expect(screen.getByText('out')).toBeInTheDocument()
    expect(screen.getByText('unaligned')).toBeInTheDocument()
    expect(screen.getByText('00:00:21.050–00:00:21.250')).toBeInTheDocument()
    expect(screen.getByText('—–—')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '跳转至视觉字幕 1' }))
    fireEvent.click(screen.getByRole('button', { name: '跳转至音频字幕 1' }))
    expect(onSeek).toHaveBeenNthCalledWith(1, 21.1)
    expect(onSeek).toHaveBeenNthCalledWith(2, 21.05)

    fireEvent.click(screen.getByRole('button', { name: 'Use Visual' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use Audio' }))
    expect(onUseVisual).toHaveBeenCalledTimes(1)
    expect(onUseAudio).toHaveBeenCalledTimes(1)
  })

  it('keeps loading and failure states independent', () => {
    render(
      <SourceSubtitleTracks
        visualSubtitles={[]}
        audioSubtitles={audioSubtitles}
        visualError={new Error('visual unavailable')}
        onRetryVisual={vi.fn()}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('visual unavailable')
    expect(screen.getByText('watch out')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use Audio' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Use Visual' })).toBeDisabled()
  })
})
