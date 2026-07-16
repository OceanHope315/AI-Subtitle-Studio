import { describe, expect, it } from 'vitest'
import {
  createRoiFromPoints,
  getContainedRect,
  moveRoi,
  resizeRoi,
  roundRoi,
} from './roi'

describe('ROI geometry', () => {
  it('calculates the visible video rectangle for contain/letterbox layouts', () => {
    expect(getContainedRect(800, 600, 1920, 1080)).toEqual({
      left: 0,
      top: 75,
      width: 800,
      height: 450,
    })

    expect(getContainedRect(900, 400, 1080, 1920)).toEqual({
      left: 337.5,
      top: 0,
      width: 225,
      height: 400,
    })
  })

  it('creates a normalized selection regardless of drag direction', () => {
    expect(createRoiFromPoints({ x: 0.8, y: 0.9 }, { x: 0.2, y: 0.6 })).toEqual({
      x: 0.2,
      y: 0.6,
      width: 0.6000000000000001,
      height: 0.30000000000000004,
    })
  })

  it('keeps moved and resized regions inside the video', () => {
    const roi = { x: 0.2, y: 0.7, width: 0.6, height: 0.2 }

    expect(moveRoi(roi, 0.8, 0.8)).toEqual({ ...roi, x: 0.4, y: 0.8 })
    expect(resizeRoi(roi, 'se', 0.8, 0.8)).toEqual({
      x: 0.2,
      y: 0.7,
      width: 0.8,
      height: 0.30000000000000004,
    })
  })

  it('rounds a valid ROI for the API payload', () => {
    expect(roundRoi({ x: 0.12345678, y: 0.7, width: 0.5, height: 0.2 })).toEqual({
      x: 0.123457,
      y: 0.7,
      width: 0.5,
      height: 0.2,
    })
  })
})
