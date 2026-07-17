import { useCallback, useEffect, useRef, useState } from 'react'
import {
  calculateContainedMediaRect,
  normalizeOcrBox,
  normalizeRoiBox,
} from '../utils/analysisOverlay'
import { FilmIcon } from './Icons'

function percentStyle(box) {
  if (!box) return undefined
  return {
    left: `${box.left}%`,
    top: `${box.top}%`,
    width: `${box.width}%`,
    height: `${box.height}%`,
  }
}

export default function AnalysisFrame({ asset, label = '当前分析原帧' }) {
  const stageRef = useRef(null)
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 })
  const [renderedRect, setRenderedRect] = useState(null)
  const [failedSource, setFailedSource] = useState('')
  const frame = asset?.value || null
  const displayFailed = Boolean(asset?.source && failedSource === asset.source)

  const updateRect = useCallback(() => {
    const stage = stageRef.current
    if (!stage || !frame) return
    const mediaWidth = frame.frameWidth || frame.previewWidth || naturalSize.width
    const mediaHeight = frame.frameHeight || frame.previewHeight || naturalSize.height
    const next = calculateContainedMediaRect(stage.clientWidth, stage.clientHeight, mediaWidth, mediaHeight)
    if (next) setRenderedRect(next)
  }, [frame, naturalSize.height, naturalSize.width])

  useEffect(() => {
    updateRect()
    const stage = stageRef.current
    if (!stage) return undefined
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateRect)
    observer?.observe(stage)
    window.addEventListener('resize', updateRect)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateRect)
    }
  }, [updateRect])

  const sourceWidth = frame?.frameWidth || frame?.previewWidth || naturalSize.width
  const sourceHeight = frame?.frameHeight || frame?.previewHeight || naturalSize.height
  const roiBox = normalizeRoiBox(frame?.roi, sourceWidth, sourceHeight)

  return (
    <div className="analysis-frame-stage" ref={stageRef} data-testid="analysis-frame-stage">
      {asset?.source && !displayFailed ? (
        <>
          <img
            className="analysis-frame-image"
            src={asset.source}
            alt={label}
            onLoad={(event) => {
              setNaturalSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }}
            onError={() => setFailedSource(asset.source)}
          />
          <div
            className="analysis-overlay-layer"
            data-testid="analysis-overlay-layer"
            style={renderedRect ? {
              left: `${renderedRect.left}px`,
              top: `${renderedRect.top}px`,
              width: `${renderedRect.width}px`,
              height: `${renderedRect.height}px`,
            } : undefined}
          >
            {roiBox && <span className="analysis-roi-box" style={percentStyle(roiBox)}><i>ROI</i></span>}
            {frame.candidates.map((candidate, index) => {
              const box = normalizeOcrBox(
                candidate.position,
                sourceWidth,
                sourceHeight,
                candidate.coordinateSpace || frame.coordinateSpace,
                frame.roi,
              )
              return box ? (
                <span
                  className="analysis-ocr-box"
                  data-testid="analysis-ocr-box"
                  key={`${index}:${candidate.text}`}
                  style={percentStyle(box)}
                  title={candidate.text || `OCR 候选 ${index + 1}`}
                ><i>{index + 1}</i></span>
              ) : null
            })}
          </div>
        </>
      ) : (
        <div className="analysis-frame-placeholder" role="img" aria-label="分析帧暂不可用">
          <FilmIcon width="40" height="40" />
          <strong>{displayFailed ? '当前预览读取失败' : '等待首张真实分析帧'}</strong>
          <span>文字进度和任务状态仍会继续更新</span>
        </div>
      )}
    </div>
  )
}
