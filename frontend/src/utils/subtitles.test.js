import { describe, expect, it } from 'vitest'
import {
  findSubtitleAtTime,
  formatCompactTime,
  formatTimestamp,
  normalizeSubtitles,
  parseTimestamp,
  toApiSubtitles,
  validateSubtitles,
} from './subtitles'

describe('subtitle time utilities', () => {
  it('formats seconds as editor and compact timestamps', () => {
    expect(formatTimestamp(3723.456)).toBe('01:02:03.456')
    expect(formatCompactTime(125)).toBe('02:05')
    expect(formatCompactTime(3723)).toBe('1:02:03')
  })

  it('parses seconds, SRT commas, and colon timestamps', () => {
    expect(parseTimestamp('2.5')).toBe(2.5)
    expect(parseTimestamp('01:02.500')).toBe(62.5)
    expect(parseTimestamp('00:01:02,250')).toBe(62.25)
    expect(parseTimestamp('00:72.000')).toBeNull()
    expect(parseTimestamp('invalid')).toBeNull()
  })

  it('finds ordered cues with a binary search and uses an exclusive end boundary', () => {
    const cues = Array.from({ length: 10_000 }, (_, index) => ({
      _clientId: `cue-${index}`,
      start_time: index,
      end_time: index + 0.5,
    }))
    expect(findSubtitleAtTime(cues, 6789.25)?._clientId).toBe('cue-6789')
    expect(findSubtitleAtTime(cues, 6789.5)).toBeNull()
    expect(findSubtitleAtTime(cues, -1)).toBeNull()
  })
})

describe('subtitle normalization and validation', () => {
  it('normalizes legacy fields and sorts by start time', () => {
    const result = normalizeSubtitles([
      { text: 'second', start_time: 3, end_time: 4 },
      { text: 'first', startTime: 1, endTime: 2 },
    ])

    expect(result.map((subtitle) => subtitle.text)).toEqual(['first', 'second'])
    expect(result[0]).toMatchObject({ start_time: 1, end_time: 2 })
    expect(result[0]._clientId).toBeTruthy()
  })

  it('strips UI-only fields before saving', () => {
    const result = toApiSubtitles([
      { _clientId: 'local', text: '  hello  ', start_time: 2, end_time: 3 },
    ])

    expect(result).toEqual([{ text: 'hello', start_time: 2, end_time: 3 }])
  })

  it('rejects empty text and invalid time ranges', () => {
    expect(validateSubtitles([{ text: '', start_time: 0, end_time: 2 }])).toContain('内容为空')
    expect(validateSubtitles([{ text: 'hello', start_time: 2, end_time: 1 }])).toContain('结束时间')
    expect(validateSubtitles([{ text: 'hello', start_time: 0, end_time: 2 }])).toBeNull()
  })
})
