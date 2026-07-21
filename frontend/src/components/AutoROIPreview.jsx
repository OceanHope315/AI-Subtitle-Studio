import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertIcon, CaptionsIcon, CheckIcon, FilmIcon, SparklesIcon } from './Icons'
import { getContainedRect, isValidRoi, roundRoi, sanitizeRoi } from '../utils/roi'

function sameRect(left, right) {
  return ['left', 'top', 'width', 'height'].every((key) => Math.abs(left[key] - right[key]) < 0.5)
}

function cssPercent(value) {
  return `${value * 100}%`
}

function percent(value) {
  return `${Math.round(value * 100)}%`
}

export default function AutoROIPreview({
  task,
  videoUrl,
  roi,
  loading = false,
  submitting = false,
  error = '',
  onUse,
  onReselect,
  onNewTask,
}) {
  const stageRef = useRef(null)
  const videoRef = useRef(null)
  const [contentRect, setContentRect] = useState({ left: 0, top: 0, width: 0, height: 0 })
  const [metadataReady, setMetadataReady] = useState(false)
  const [frameReady, setFrameReady] = useState(false)
  const [videoError, setVideoError] = useState('')
  const displayRoi = isValidRoi(roi) ? sanitizeRoi(roi) : null

  const updateContentRect = useCallback(() => {
    const stage = stageRef.current
    const video = videoRef.current
    if (!stage || !video?.videoWidth || !video?.videoHeight) return
    const bounds = stage.getBoundingClientRect()
    const nextRect = getContainedRect(bounds.width, bounds.height, video.videoWidth, video.videoHeight)
    setContentRect((current) => (sameRect(current, nextRect) ? current : nextRect))
  }, [])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return undefined
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateContentRect)
    observer?.observe(stage)
    window.addEventListener('resize', updateContentRect)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateContentRect)
    }
  }, [updateContentRect])

  const hasVideoSurface = metadataReady
    && frameReady
    && contentRect.width > 0
    && contentRect.height > 0
  const filename = task?.filename || task?.originalName || '已上传视频'

  return (
    <main className="roi-page">
      <section className="roi-workspace" aria-labelledby="auto-roi-title">
        <header className="roi-heading">
          <div>
            <span className="panel-icon auto-roi-heading-icon"><SparklesIcon /></span>
            <div>
              <p className="state-kicker">AI 自动定位 · 第 2 步</p>
              <h1 id="auto-roi-title">确认预测的字幕区域</h1>
              <p>AI 正在用代表帧寻找稳定字幕带，确认后进入原有 OCR 流程。</p>
            </div>
          </div>
          <button className="button button-ghost button-small" type="button" onClick={onNewTask} disabled={submitting}>
            更换视频
          </button>
        </header>

        <div className="roi-content">
          <div className="roi-preview-card">
            <div className="roi-video-title">
              <span><FilmIcon /> <strong>视频第一帧</strong></span>
              <span title={filename}>{filename}</span>
            </div>

            <div ref={stageRef} className="roi-video-stage" data-testid="auto-roi-video-stage">
              <video
                ref={videoRef}
                src={videoUrl}
                preload="auto"
                muted
                playsInline
                aria-label="预测区域视频第一帧"
                onLoadedMetadata={() => {
                  setMetadataReady(true)
                  setVideoError('')
                  window.requestAnimationFrame(updateContentRect)
                }}
                onLoadedData={() => {
                  setFrameReady(true)
                  setVideoError('')
                  window.requestAnimationFrame(updateContentRect)
                }}
                onError={() => setVideoError('视频第一帧加载失败，请改用人工区域选择。')}
              >
                当前浏览器不支持 HTML5 视频播放。
              </video>

              {!frameReady && !videoError && (
                <div className="roi-video-state" aria-live="polite">
                  <span className="large-spinner" />
                  <span>正在加载视频第一帧…</span>
                </div>
              )}
              {videoError && (
                <div className="roi-video-state roi-video-error" role="alert">
                  <AlertIcon />
                  <span>{videoError}</span>
                </div>
              )}
              {frameReady && loading && (
                <div className="roi-video-state auto-roi-analyzing" aria-live="polite">
                  <span className="large-spinner" />
                  <span>正在分析 10–20 个代表帧…</span>
                </div>
              )}

              {displayRoi && hasVideoSurface && !loading && (
                <div
                  className="roi-coordinate-surface auto-roi-surface"
                  data-testid="auto-roi-coordinate-surface"
                  style={{
                    left: `${contentRect.left}px`,
                    top: `${contentRect.top}px`,
                    width: `${contentRect.width}px`,
                    height: `${contentRect.height}px`,
                  }}
                >
                  <div
                    className="roi-selection auto-roi-selection"
                    role="group"
                    aria-label="AI 预测字幕区域"
                    style={{
                      left: cssPercent(displayRoi.x),
                      top: cssPercent(displayRoi.y),
                      width: cssPercent(displayRoi.width),
                      height: cssPercent(displayRoi.height),
                    }}
                  >
                    <span className="roi-selection-label auto-roi-selection-label">
                      <CaptionsIcon /> AI 预测字幕区域
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>

          <aside
            className="roi-guide auto-roi-guide"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-busy={loading}
          >
            <div className="roi-guide-icon auto-roi-guide-icon">
              {loading ? <span className="mini-spinner" /> : <CheckIcon />}
            </div>
            <h2>{loading ? '正在估计字幕区域' : '已检测到字幕区域'}</h2>
            <p>
              {loading
                ? 'PaddleOCR 正在比较文字出现频率、纵向聚类、连续性和底部位置。'
                : '绿色框是 AI 的预测结果。可直接使用，也可进入人工框选继续调整。'}
            </p>
            {displayRoi && !loading && (
              <div className="roi-values" aria-label="预测区域坐标">
                <span><small>X</small><strong>{percent(displayRoi.x)}</strong></span>
                <span><small>Y</small><strong>{percent(displayRoi.y)}</strong></span>
                <span><small>宽</small><strong>{percent(displayRoi.width)}</strong></span>
                <span><small>高</small><strong>{percent(displayRoi.height)}</strong></span>
              </div>
            )}
          </aside>
        </div>

        <footer className="roi-footer auto-roi-footer">
          <div>
            <CheckIcon />
            <span><strong>预测不会自动启动任务</strong>只有点击“使用该区域”后才会保存 ROI 并开始识别。</span>
          </div>
          <div className="auto-roi-actions">
            <button
              className="button button-primary roi-confirm-button"
              type="button"
              disabled={!displayRoi || !hasVideoSurface || loading || submitting || Boolean(videoError)}
              onClick={() => onUse(roundRoi(displayRoi))}
            >
              {submitting ? <span className="mini-spinner" /> : <CheckIcon />}
              {submitting ? '正在启动识别…' : '使用该区域'}
            </button>
            <button
              className="button button-secondary"
              type="button"
              disabled={submitting}
              onClick={onReselect}
            >
              重新选择
            </button>
          </div>
        </footer>

        {error && <div className="inline-error roi-submit-error" role="alert">{error}</div>}
      </section>
    </main>
  )
}
