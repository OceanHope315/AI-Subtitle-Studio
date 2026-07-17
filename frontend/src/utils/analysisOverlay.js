function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

export function calculateContainedMediaRect(containerWidth, containerHeight, mediaWidth, mediaHeight) {
  const width = finite(containerWidth)
  const height = finite(containerHeight)
  const sourceWidth = finite(mediaWidth)
  const sourceHeight = finite(mediaHeight)
  if (!width || !height || !sourceWidth || !sourceHeight || width <= 0 || height <= 0 || sourceWidth <= 0 || sourceHeight <= 0) {
    return null
  }
  const scale = Math.min(width / sourceWidth, height / sourceHeight)
  const renderedWidth = sourceWidth * scale
  const renderedHeight = sourceHeight * scale
  return {
    left: (width - renderedWidth) / 2,
    top: (height - renderedHeight) / 2,
    width: renderedWidth,
    height: renderedHeight,
  }
}

function pointsFromPosition(position) {
  if (Array.isArray(position)) {
    if (position.length >= 4 && position.every((value) => finite(value) !== null)) {
      return [
        [finite(position[0]), finite(position[1])],
        [finite(position[2]), finite(position[3])],
      ]
    }
    const points = position
      .filter((point) => Array.isArray(point) && point.length >= 2)
      .map((point) => [finite(point[0]), finite(point[1])])
      .filter((point) => point[0] !== null && point[1] !== null)
    return points.length ? points : null
  }
  if (!position || typeof position !== 'object') return null
  const x1 = finite(position.x1 ?? position.left ?? position.x)
  const y1 = finite(position.y1 ?? position.top ?? position.y)
  let x2 = finite(position.x2 ?? position.right)
  let y2 = finite(position.y2 ?? position.bottom)
  if (x2 === null && x1 !== null) x2 = x1 + (finite(position.width ?? position.w) || 0)
  if (y2 === null && y1 !== null) y2 = y1 + (finite(position.height ?? position.h) || 0)
  return [x1, y1, x2, y2].every((value) => value !== null)
    ? [[x1, y1], [x2, y2]]
    : null
}

/** Convert OCR coordinates into percentages of the uncropped source video. */
export function normalizeOcrBox(position, sourceWidth, sourceHeight, coordinateSpace = 'video', roi = null) {
  const width = finite(sourceWidth)
  const height = finite(sourceHeight)
  const points = pointsFromPosition(position)
  if (!width || !height || !points) return null

  let xs = points.map((point) => point[0])
  let ys = points.map((point) => point[1])
  const space = String(coordinateSpace || '').toLowerCase()
  if (space.includes('normalized')) {
    xs = xs.map((value) => value * width)
    ys = ys.map((value) => value * height)
  } else if (space.includes('roi') && roi) {
    const roiX = (finite(roi.x) || 0) * (Math.abs(finite(roi.x) || 0) <= 1 ? width : 1)
    const roiY = (finite(roi.y) || 0) * (Math.abs(finite(roi.y) || 0) <= 1 ? height : 1)
    xs = xs.map((value) => value + roiX)
    ys = ys.map((value) => value + roiY)
  }

  const left = clamp(Math.min(...xs), 0, width)
  const right = clamp(Math.max(...xs), 0, width)
  const top = clamp(Math.min(...ys), 0, height)
  const bottom = clamp(Math.max(...ys), 0, height)
  if (right <= left || bottom <= top) return null
  return {
    left: (left / width) * 100,
    top: (top / height) * 100,
    width: ((right - left) / width) * 100,
    height: ((bottom - top) / height) * 100,
  }
}

export function normalizeRoiBox(roi, sourceWidth, sourceHeight) {
  if (!roi) return null
  const width = finite(sourceWidth)
  const height = finite(sourceHeight)
  let x = finite(roi.x)
  let y = finite(roi.y)
  let roiWidth = finite(roi.width ?? roi.w)
  let roiHeight = finite(roi.height ?? roi.h)
  if (!width || !height || [x, y, roiWidth, roiHeight].some((value) => value === null)) return null
  if (Math.abs(x) > 1 || Math.abs(roiWidth) > 1) {
    x /= width
    roiWidth /= width
  }
  if (Math.abs(y) > 1 || Math.abs(roiHeight) > 1) {
    y /= height
    roiHeight /= height
  }
  const left = clamp(x, 0, 1)
  const top = clamp(y, 0, 1)
  const right = clamp(x + roiWidth, 0, 1)
  const bottom = clamp(y + roiHeight, 0, 1)
  if (right <= left || bottom <= top) return null
  return {
    left: left * 100,
    top: top * 100,
    width: (right - left) * 100,
    height: (bottom - top) * 100,
  }
}
