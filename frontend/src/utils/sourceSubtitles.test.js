import { describe, expect, it } from 'vitest'
import {
  audioTrackToFinalSubtitles,
  normalizeAudioSubtitles,
  normalizeVisualSubtitles,
  visualTrackToFinalSubtitles,
} from './sourceSubtitles'

describe('source subtitle adapters', () => {
  it('normalizes visual fields without changing the source schema', () => {
    const [subtitle] = normalizeVisualSubtitles([{
      taskId: 'task-1',
      text: 'WATCH OUT',
      start: 21.1,
      end: 21.4,
      bbox: [[1, 2], [3, 4]],
      confidence: 0.95,
    }])

    expect(subtitle).toMatchObject({
      taskId: 'task-1',
      text: 'WATCH OUT',
      start: 21.1,
      end: 21.4,
      bbox: [[1, 2], [3, 4]],
      confidence: 0.95,
    })
  })

  it('derives optional audio sentence bounds from word timestamps', () => {
    const [subtitle] = normalizeAudioSubtitles([{
      taskId: 'task-1',
      text: 'watch out',
      words: [
        { word: 'watch', start: 21.05, end: 21.25 },
        { word: 'out', start: 21.25, end: 21.4 },
      ],
      confidence: 0.9,
    }])

    expect(subtitle).toMatchObject({ start: 21.05, end: 21.4 })
    expect(subtitle.words).toHaveLength(2)
  })

  it('whitelists source cues into the existing final subtitle structure', () => {
    const [visual] = visualTrackToFinalSubtitles(normalizeVisualSubtitles([{
      taskId: 'task-1', text: 'Visual', start: 1, end: 2, bbox: [1, 2, 3, 4], confidence: 0.8,
    }]))
    const [audio] = audioTrackToFinalSubtitles(normalizeAudioSubtitles([{
      taskId: 'task-1', text: 'Audio', start: 3, end: 4, words: [{ word: 'Audio', start: 3, end: 4 }], confidence: 0.9,
    }]))

    expect(visual).toMatchObject({
      text: 'Visual', start_time: 1, end_time: 2, position: [1, 2, 3, 4], source: 'visual',
    })
    expect(visual).not.toHaveProperty('bbox')
    expect(visual).not.toHaveProperty('taskId')
    expect(audio).toMatchObject({ text: 'Audio', start_time: 3, end_time: 4, source: 'audio' })
    expect(audio).not.toHaveProperty('words')
    expect(audio).not.toHaveProperty('taskId')
  })

  it('drops invalid source cues rather than creating invalid final timestamps', () => {
    const source = normalizeAudioSubtitles([{ text: 'missing time', words: [] }])
    expect(audioTrackToFinalSubtitles(source)).toEqual([])
  })

  it('does not copy a polygon bbox into the flat FinalSubtitle position field', () => {
    const [visual] = visualTrackToFinalSubtitles(normalizeVisualSubtitles([{
      text: 'Visual', start: 1, end: 2, bbox: [[1, 2], [3, 4]],
    }]))
    expect(visual.position).toBeNull()
  })
})
