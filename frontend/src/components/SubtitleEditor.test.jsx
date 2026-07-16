import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import SubtitleEditor from './SubtitleEditor'

const subtitles = [{
  _clientId: 'subtitle-1',
  text: 'Hello world',
  start_time: 1,
  end_time: 3,
  confidence: 0.92,
}]

function renderEditor(overrides = {}) {
  const props = {
    subtitles,
    currentSubtitleId: null,
    selectedId: null,
    loading: false,
    error: null,
    onSelect: vi.fn(),
    onSeek: vi.fn(),
    onChange: vi.fn(),
    onDelete: vi.fn(),
    onAdd: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  }
  render(<SubtitleEditor {...props} />)
  return props
}

describe('SubtitleEditor', () => {
  it('edits text and seeks from the row play button', () => {
    const props = renderEditor()
    fireEvent.change(screen.getByLabelText('第 1 条字幕文本'), { target: { value: 'Updated' } })
    fireEvent.click(screen.getByRole('button', { name: '播放第 1 条字幕' }))

    expect(props.onChange).toHaveBeenCalledWith('subtitle-1', { text: 'Updated' })
    expect(props.onSeek).toHaveBeenCalledWith(1, true)
  })

  it('supports adding and deleting subtitles', () => {
    const props = renderEditor()
    fireEvent.click(screen.getByRole('button', { name: '添加字幕' }))
    fireEvent.click(screen.getByRole('button', { name: '删除第 1 条字幕' }))

    expect(props.onAdd).toHaveBeenCalledTimes(1)
    expect(props.onDelete).toHaveBeenCalledWith('subtitle-1')
  })

  it('renders a useful empty state', () => {
    renderEditor({ subtitles: [] })
    expect(screen.getByText('暂未识别到字幕')).toBeInTheDocument()
  })
})
