import { act, createRef } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import Timeline from './Timeline'

describe('Timeline inspection controls', () => {
  it('supports full, five-second and one-second views around the playhead', async () => {
    const ref = createRef()
    render(
      <Timeline
        ref={ref}
        subtitles={[{ _clientId: 'line', text: 'line', start_time: 4.9, end_time: 5.2 }]}
        duration={10}
        initialTime={0}
        frameRate={25}
        selectedId={null}
        onSeek={vi.fn()}
        onSelect={vi.fn()}
      />,
    )
    const slider = screen.getByRole('slider', { name: '视频时间' })
    expect(slider).toHaveAttribute('aria-valuemax', '10')

    fireEvent.click(screen.getByRole('button', { name: '1 秒' }))
    expect(slider).toHaveAttribute('aria-valuemax', '1')
    act(() => ref.current.syncTime(5))
    await waitFor(() => expect(slider).toHaveAttribute('aria-valuemin', '4.5'))
    expect(slider).toHaveAttribute('aria-valuemax', '5.5')

    fireEvent.click(screen.getByRole('button', { name: '5 秒' }))
    expect(slider).toHaveAttribute('aria-valuemin', '2.5')
    expect(slider).toHaveAttribute('aria-valuemax', '7.5')
  })

  it('moves one frame per keyboard arrow', () => {
    const onSeek = vi.fn()
    render(<Timeline subtitles={[]} duration={10} initialTime={1} frameRate={25} selectedId={null} onSeek={onSeek} onSelect={vi.fn()} />)
    fireEvent.keyDown(screen.getByRole('slider', { name: '视频时间' }), { key: 'ArrowRight' })
    expect(onSeek).toHaveBeenCalledWith(1.04)
  })
})
