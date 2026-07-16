export const DEFAULT_SUBTITLE_ROI = Object.freeze({
  x: 0.08,
  // Covers the usual lower-third caption band without dropping text that sits
  // slightly above the bottom HUD (the bundled portrait test video is around
  // y=0.56..0.70).
  y: 0.52,
  width: 0.84,
  height: 0.24,
})

export const MIN_ROI_SIZE = 0.03

export function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value))
}

export function getContainedRect(containerWidth, containerHeight, mediaWidth, mediaHeight) {
  if (![containerWidth, containerHeight, mediaWidth, mediaHeight].every((value) => Number(value) > 0)) {
    return { left: 0, top: 0, width: 0, height: 0 }
  }

  const scale = Math.min(containerWidth / mediaWidth, containerHeight / mediaHeight)
  const width = mediaWidth * scale
  const height = mediaHeight * scale

  return {
    left: (containerWidth - width) / 2,
    top: (containerHeight - height) / 2,
    width,
    height,
  }
}

export function isValidRoi(roi) {
  if (!roi) return false
  const values = [roi.x, roi.y, roi.width, roi.height].map(Number)
  if (!values.every(Number.isFinite)) return false
  const [x, y, width, height] = values
  return x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= 1 && y + height <= 1
}

export function sanitizeRoi(roi, fallback = DEFAULT_SUBTITLE_ROI) {
  if (!isValidRoi(roi)) return { ...fallback }

  const width = clamp(Number(roi.width), MIN_ROI_SIZE, 1)
  const height = clamp(Number(roi.height), MIN_ROI_SIZE, 1)
  return {
    x: clamp(Number(roi.x), 0, 1 - width),
    y: clamp(Number(roi.y), 0, 1 - height),
    width,
    height,
  }
}

export function roundRoi(roi, precision = 6) {
  const factor = 10 ** precision
  return Object.fromEntries(
    Object.entries(sanitizeRoi(roi)).map(([key, value]) => [key, Math.round(value * factor) / factor]),
  )
}

export function pointToNormalized(clientX, clientY, bounds) {
  if (!bounds?.width || !bounds?.height) return { x: 0, y: 0 }
  return {
    x: clamp((clientX - bounds.left) / bounds.width),
    y: clamp((clientY - bounds.top) / bounds.height),
  }
}

export function createRoiFromPoints(start, end, minimumSize = MIN_ROI_SIZE) {
  const startX = clamp(start.x)
  const startY = clamp(start.y)
  const endX = clamp(end.x)
  const endY = clamp(end.y)

  let x = Math.min(startX, endX)
  let y = Math.min(startY, endY)
  let width = Math.abs(endX - startX)
  let height = Math.abs(endY - startY)

  if (width < minimumSize) {
    x = endX < startX ? Math.max(0, startX - minimumSize) : Math.min(startX, 1 - minimumSize)
    width = Math.min(minimumSize, 1)
  }
  if (height < minimumSize) {
    y = endY < startY ? Math.max(0, startY - minimumSize) : Math.min(startY, 1 - minimumSize)
    height = Math.min(minimumSize, 1)
  }

  return { x, y, width, height }
}

export function moveRoi(roi, deltaX, deltaY) {
  return {
    ...roi,
    x: clamp(roi.x + deltaX, 0, 1 - roi.width),
    y: clamp(roi.y + deltaY, 0, 1 - roi.height),
  }
}

export function resizeRoi(roi, handle, deltaX, deltaY, minimumSize = MIN_ROI_SIZE) {
  let left = roi.x
  let top = roi.y
  let right = roi.x + roi.width
  let bottom = roi.y + roi.height

  if (handle.includes('w')) left = clamp(left + deltaX, 0, right - minimumSize)
  if (handle.includes('e')) right = clamp(right + deltaX, left + minimumSize, 1)
  if (handle.includes('n')) top = clamp(top + deltaY, 0, bottom - minimumSize)
  if (handle.includes('s')) bottom = clamp(bottom + deltaY, top + minimumSize, 1)

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  }
}
