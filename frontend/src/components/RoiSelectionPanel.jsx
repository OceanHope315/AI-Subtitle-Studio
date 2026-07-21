import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertIcon, CaptionsIcon, CheckIcon, FilmIcon, PlayIcon, RotateIcon } from './Icons'
import { formatCompactTime } from '../utils/subtitles'
import {
  DEFAULT_SUBTITLE_ROI,
  createRoiFromPoints,
  getContainedRect,
  moveRoi,
  pointToNormalized,
  resizeRoi,
  roundRoi,
  sanitizeRoi,
} from '../utils/roi'

const RESIZE_HANDLES = [
  ['nw', '左上角'],
  ['n', '上边'],
  ['ne', '右上角'],
  ['e', '右边'],
  ['se', '右下角'],
  ['s', '下边'],
  ['sw', '左下角'],
  ['w', '左边'],
]

function sameRect(left, right) {
  return ['left', 'top', 'width', 'height'].every((key) => Math.abs(left[key] - right[key]) < 0.5)
}

function percent(value) {
  return `${Math.round(value * 100)}%`
}

function cssPercent(value) {
  return `${value * 100}%`
}

export default function RoiSelectionPanel({
  task,
  videoUrl,
  submitting = false,
  error = '',
  notice = '',
  onConfirm,
  onNewTask,
}) {
  const stageRef = useRef(null)
  const videoRef = useRef(null)
  const surfaceRef = useRef(null)
  const interactionRef = useRef(null)
  const [roi, setRoi] = useState(() => sanitizeRoi(task?.roi || task?.subtitleRoi))
  const [contentRect, setContentRect] = useState({ left: 0, top: 0, width: 0, height: 0 })
  const [metadataReady, setMetadataReady] = useState(false)
  const [videoError, setVideoError] = useState('')
  const [playbackWarning, setPlaybackWarning] = useState('')
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(false)

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

  const pointFromEvent = (event) => pointToNormalized(
    event.clientX,
    event.clientY,
    surfaceRef.current?.getBoundingClientRect(),
  )

  const beginInteraction = (event, type, handle = '') => {
    if (event.button !== undefined && event.button !== 0) return
    event.preventDefault()
    const point = pointFromEvent(event)
    interactionRef.current = {
      pointerId: event.pointerId,
      captureTarget: event.currentTarget,
      type,
      handle,
      startPoint: point,
      startRoi: roi,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    if (type === 'draw') setRoi(createRoiFromPoints(point, point))
  }

  const handlePointerMove = (event) => {
    const interaction = interactionRef.current
    if (!interaction || (interaction.pointerId !== undefined && event.pointerId !== interaction.pointerId)) return
    const point = pointFromEvent(event)
    const deltaX = point.x - interaction.startPoint.x
    const deltaY = point.y - interaction.startPoint.y

    if (interaction.type === 'draw') {
      setRoi(createRoiFromPoints(interaction.startPoint, point))
    } else if (interaction.type === 'move') {
      setRoi(moveRoi(interaction.startRoi, deltaX, deltaY))
    } else if (interaction.type === 'resize') {
      setRoi(resizeRoi(interaction.startRoi, interaction.handle, deltaX, deltaY))
    }
  }

  const endInteraction = (_event) => {
    if (!interactionRef.current) return
    const { captureTarget, pointerId } = interactionRef.current
    if (!captureTarget.hasPointerCapture || captureTarget.hasPointerCapture(pointerId)) {
      captureTarget.releasePointerCapture?.(pointerId)
    }
    interactionRef.current = null
  }

  const handleSelectionKeyDown = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const step = event.shiftKey ? 0.02 : 0.005
    const deltaX = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
    const deltaY = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
    setRoi((current) => moveRoi(current, deltaX, deltaY))
  }

  const togglePlayback = async () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      try {
        await video.play()
      } catch {
        // A rejected play() is non-fatal (for example an autoplay policy).
        // Seeking and ROI confirmation must remain available.
        setPlaybackWarning('浏览器阻止了视频播放，请拖动下方进度条定位字幕画面。')
      }
    } else {
      video.pause()
    }
  }

  const handleSeek = (event) => {
    const nextTime = Number(event.target.value)
    setCurrentTime(nextTime)
    if (videoRef.current) videoRef.current.currentTime = nextTime
  }

  const filename = task?.filename || task?.originalName || '已上传视频'
  const hasVideoSurface = metadataReady && contentRect.width > 0 && contentRect.height > 0

  return (
    <main className="roi-page">
      <section className="roi-workspace" aria-labelledby="roi-title">
        <header className="roi-heading">
          <div>
            <span className="panel-icon"><CaptionsIcon /></span>
            <div>
              <p className="state-kicker">识别前设置 · 第 2 步</p>
              <h1 id="roi-title">框选画面中的字幕区域</h1>
              <p>只会扫描框内内容，可避开角色名、血量和游戏 HUD。</p>
            </div>
          </div>
          <button className="button button-ghost button-small" type="button" onClick={onNewTask} disabled={submitting}>
            更换视频
          </button>
        </header>

        {notice && <div className="auto-roi-fallback" role="status">{notice}</div>}

        <div className="roi-content">
          <div className="roi-preview-card">
            <div className="roi-video-title">
              <span><FilmIcon /> <strong>视频预览</strong></span>
              <span title={filename}>{filename}</span>
            </div>

            <div ref={stageRef} className="roi-video-stage" data-testid="roi-video-stage">
              <video
                ref={videoRef}
                src={videoUrl}
                preload="metadata"
                playsInline
                onLoadedMetadata={(event) => {
                  const nextDuration = Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0
                  setDuration(nextDuration)
                  setMetadataReady(true)
                  setVideoError('')
                  setPlaybackWarning('')
                  window.requestAnimationFrame(updateContentRect)
                }}
                onDurationChange={(event) => {
                  if (Number.isFinite(event.currentTarget.duration)) setDuration(event.currentTarget.duration)
                }}
                onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
                onPlay={() => {
                  setPlaying(true)
                  setPlaybackWarning('')
                }}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
                onError={() => setVideoError('视频预览加载失败，请确认后端视频接口可访问。')}
              >
                当前浏览器不支持 HTML5 视频播放。
              </video>

              {!metadataReady && !videoError && (
                <div className="roi-video-state" aria-live="polite">
                  <span className="large-spinner" />
                  <span>正在加载视频预览…</span>
                </div>
              )}

              {videoError && (
                <div className="roi-video-state roi-video-error" role="alert">
                  <AlertIcon />
                  <span>{videoError}</span>
                </div>
              )}

              {hasVideoSurface && (
                <div
                  ref={surfaceRef}
                  className="roi-coordinate-surface"
                  data-testid="roi-coordinate-surface"
                  style={{
                    left: `${contentRect.left}px`,
                    top: `${contentRect.top}px`,
                    width: `${contentRect.width}px`,
                    height: `${contentRect.height}px`,
                  }}
                  onPointerDown={(event) => {
                    if (event.target === event.currentTarget) beginInteraction(event, 'draw')
                  }}
                  onPointerMove={handlePointerMove}
                  onPointerUp={endInteraction}
                  onPointerCancel={endInteraction}
                >
                  <div
                    className="roi-selection"
                    role="group"
                    aria-label="字幕识别区域"
                    tabIndex={0}
                    style={{
                      left: cssPercent(roi.x),
                      top: cssPercent(roi.y),
                      width: cssPercent(roi.width),
                      height: cssPercent(roi.height),
                    }}
                    onPointerDown={(event) => {
                      event.stopPropagation()
                      beginInteraction(event, 'move')
                    }}
                    onKeyDown={handleSelectionKeyDown}
                  >
                    <span className="roi-selection-label"><CaptionsIcon /> 字幕识别区域</span>
                    <span className="roi-move-hint">拖动移动</span>
                    {RESIZE_HANDLES.map(([handle, label]) => (
                      <button
                        key={handle}
                        className={`roi-handle roi-handle-${handle}`}
                        type="button"
                        aria-label={`调整字幕区域${label}`}
                        onPointerDown={(event) => {
                          event.stopPropagation()
                          beginInteraction(event, 'resize', handle)
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="roi-video-controls">
              <button
                className="roi-play-button"
                type="button"
                aria-label={playing ? '暂停视频' : '播放视频'}
                onClick={togglePlayback}
                disabled={!metadataReady || Boolean(videoError)}
              >
                {playing ? <span className="pause-symbol" aria-hidden="true">Ⅱ</span> : <PlayIcon />}
              </button>
              <span>{formatCompactTime(currentTime)}</span>
              <input
                type="range"
                aria-label="视频播放进度"
                min="0"
                max={duration || 0}
                step="0.01"
                value={Math.min(currentTime, duration || 0)}
                disabled={!duration || Boolean(videoError)}
                onChange={handleSeek}
              />
              <span>{formatCompactTime(duration)}</span>
            </div>
            {playbackWarning && (
              <div className="roi-playback-warning" role="status">{playbackWarning}</div>
            )}
          </div>

          <aside className="roi-guide">
            <div className="roi-guide-icon"><CaptionsIcon /></div>
            <h2>怎么框最准？</h2>
            <ol>
              <li><span>1</span><p><strong>找到字幕出现的画面</strong>拖动视频进度条，停在有字幕的一帧。</p></li>
              <li><span>2</span><p><strong>包住完整字幕范围</strong>在画面拖出新框，或拖动边角调整现有框。</p></li>
              <li><span>3</span><p><strong>避开固定 HUD</strong>框可以稍宽，但尽量不要包含角色名和血量。</p></li>
            </ol>

            <div className="roi-values" aria-label="区域坐标">
              <span><small>X</small><strong>{percent(roi.x)}</strong></span>
              <span><small>Y</small><strong>{percent(roi.y)}</strong></span>
              <span><small>宽</small><strong>{percent(roi.width)}</strong></span>
              <span><small>高</small><strong>{percent(roi.height)}</strong></span>
            </div>

            <button
              className="button button-secondary roi-reset-button"
              type="button"
              onClick={() => setRoi({ ...DEFAULT_SUBTITLE_ROI })}
              disabled={submitting}
            >
              <RotateIcon /> 恢复推荐区域
            </button>
          </aside>
        </div>

        <footer className="roi-footer">
          <div>
            <CheckIcon />
            <span><strong>坐标按原视频归一化保存</strong>播放器缩放或黑边不会改变识别范围。</span>
          </div>
          <button
            className="button button-primary roi-confirm-button"
            type="button"
            disabled={!hasVideoSurface || submitting || Boolean(videoError)}
            onClick={() => onConfirm(roundRoi(roi))}
          >
            {submitting ? <span className="mini-spinner" /> : <CheckIcon />}
            {submitting ? '正在启动识别…' : '确认区域并开始识别'}
          </button>
        </footer>

        {error && <div className="inline-error roi-submit-error" role="alert">{error}</div>}
      </section>
    </main>
  )
}
