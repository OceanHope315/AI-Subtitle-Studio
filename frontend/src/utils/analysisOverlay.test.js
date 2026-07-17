import { describe, expect, it } from 'vitest'
import {
  calculateContainedMediaRect,
  normalizeOcrBox,
  normalizeRoiBox,
} from './analysisOverlay'

describe('analysis overlay geometry', () => {
  it('accounts for object-fit contain letterboxing', () => {
    expect(calculateContainedMediaRect(800, 600, 1920, 1080)).toEqual({
      left: 0,
      top: 75,
      width: 800,
      height: 450,
    })
    expect(calculateContainedMediaRect(600, 800, 1080, 1920)).toEqual({
      left: 75,
      top: 0,
      width: 450,
      height: 800,
    })
  })

  it('maps global video OCR coordinates to source-relative percentages', () => {
    expect(normalizeOcrBox([192, 108, 960, 540], 1920, 1080, 'video')).toEqual({
      left: 10,
      top: 10,
      width: 40,
      height: 40,
    })
  })

  it('supports ROI-local fallback coordinates and normalized ROI boxes', () => {
    const roi = { x: 0.1, y: 0.5, width: 0.8, height: 0.2 }
    expect(normalizeOcrBox([0, 0, 100, 50], 1000, 500, 'roi', roi)).toEqual({
      left: 10,
      top: 50,
      width: 10,
      height: 10,
    })
    const roiBox = normalizeRoiBox(roi, 1000, 500)
    expect(roiBox.left).toBeCloseTo(10)
    expect(roiBox.top).toBeCloseTo(50)
    expect(roiBox.width).toBeCloseTo(80)
    expect(roiBox.height).toBeCloseTo(20)
  })
})
