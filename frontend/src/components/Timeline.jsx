import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { formatCompactTime } from '../utils/subtitles'

const TICK_COUNT = 5
const ZOOM_LEVELS = [
  { id: 'full', label: '全片', seconds: null },
  { id: '5s', label: '5 秒', seconds: 5 },
  { id: '1s', label: '1 秒', seconds: 1 },
]

const Timeline = forwardRef(function Timeline(
  { subtitles, duration, initialTime = 0, frameRate = 30, selectedId, onSeek, onSelect },
  ref,
) {
  const currentTimeRef = useRef(initialTime)
  const playheadRef = useRef(null)
  const timeLabelRef = useRef(null)
  const [zoomId, setZoomId] = useState('full')
  const [anchor, setAnchor] = useState(initialTime)
  const lastEnd = subtitles.reduce((max, subtitle) => Math.max(max, subtitle.end_time), 0)
  const timelineDuration = Math.max(duration || 0, lastEnd, 1)
  const zoom = ZOOM_LEVELS.find((item) => item.id === zoomId) || ZOOM_LEVELS[0]
  const windowDuration = Math.min(zoom.seconds || timelineDuration, timelineDuration)
  const viewStart = zoom.seconds
    ? Math.max(0, Math.min(anchor - windowDuration / 2, timelineDuration - windowDuration))
    : 0
  const viewEnd = viewStart + windowDuration

  const updateDom = useCallback((time) => {
    const ratio = Math.min(1, Math.max(0, (time - viewStart) / windowDuration))
    if (playheadRef.current) playheadRef.current.style.left = `${ratio * 100}%`
    if (timeLabelRef.current) {
      timeLabelRef.current.textContent = `${formatCompactTime(time)} / ${formatCompactTime(timelineDuration)}`
    }
  }, [timelineDuration, viewStart, windowDuration])

  useImperativeHandle(ref, () => ({
    syncTime(time) {
      currentTimeRef.current = time
      updateDom(time)
      if (zoom.seconds && (time < viewStart || time >= viewEnd)) setAnchor(time)
    },
  }), [updateDom, viewEnd, viewStart, zoom.seconds])

  const ticks = useMemo(
    () => Array.from({ length: TICK_COUNT }, (_, index) => viewStart + (windowDuration * index) / (TICK_COUNT - 1)),
    [viewStart, windowDuration],
  )
  const visibleSubtitles = subtitles.filter(
    (subtitle) => subtitle.start_time < viewEnd && subtitle.end_time > viewStart,
  )

  const seekFromPointer = (event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (!rect.width) return
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    const time = viewStart + ratio * windowDuration
    currentTimeRef.current = time
    updateDom(time)
    onSeek(time)
  }

  return (
    <section className="timeline-card" aria-label="字幕时间轴">
      <div className="timeline-heading">
        <div><strong>时间轴</strong><span>{subtitles.length} 个字幕片段</span></div>
        <div className="timeline-heading-tools">
          <div className="timeline-zoom" aria-label="时间轴缩放">
            {ZOOM_LEVELS.map((level) => (
              <button
                key={level.id}
                type="button"
                className={zoomId === level.id ? 'is-active' : ''}
                onClick={() => {
                  setAnchor(currentTimeRef.current)
                  setZoomId(level.id)
                }}
              >
                {level.label}
              </button>
            ))}
          </div>
          <span ref={timeLabelRef}>{formatCompactTime(initialTime)} / {formatCompactTime(timelineDuration)}</span>
        </div>
      </div>
      <div className="timeline-ruler" aria-hidden="true">
        {ticks.map((tick) => <span key={tick}>{formatCompactTime(tick)}</span>)}
      </div>
      <div
        className="timeline-track"
        role="slider"
        tabIndex="0"
        aria-label="视频时间"
        aria-valuemin={viewStart}
        aria-valuemax={viewEnd}
        aria-valuenow={currentTimeRef.current}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture?.(event.pointerId)
          seekFromPointer(event)
        }}
        onPointerMove={(event) => {
          if (event.buttons === 1) seekFromPointer(event)
        }}
        onKeyDown={(event) => {
          const frameDuration = 1 / (Number(frameRate) || 30)
          if (event.key === 'ArrowRight') onSeek(Math.min(timelineDuration, currentTimeRef.current + frameDuration))
          if (event.key === 'ArrowLeft') onSeek(Math.max(0, currentTimeRef.current - frameDuration))
        }}
      >
        <div className="timeline-grid" />
        {visibleSubtitles.map((subtitle, index) => {
          const left = Math.max(0, ((subtitle.start_time - viewStart) / windowDuration) * 100)
          const right = Math.min(100, ((subtitle.end_time - viewStart) / windowDuration) * 100)
          const width = Math.max(0.5, right - left)
          const active = currentTimeRef.current >= subtitle.start_time && currentTimeRef.current < subtitle.end_time
          return (
            <button
              type="button"
              key={subtitle._clientId}
              className={`timeline-segment ${active ? 'is-active' : ''} ${selectedId === subtitle._clientId ? 'is-selected' : ''}`}
              style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
              title={`${index + 1}. ${subtitle.text}`}
              aria-label={`跳转至字幕：${subtitle.text}`}
              onClick={(event) => {
                event.stopPropagation()
                onSelect(subtitle._clientId)
                onSeek(subtitle.start_time)
              }}
            >
              <span>{subtitles.indexOf(subtitle) + 1}</span>
            </button>
          )
        })}
        <span
          ref={playheadRef}
          className="timeline-playhead"
          style={{ left: `${Math.min(100, Math.max(0, ((initialTime - viewStart) / windowDuration) * 100))}%` }}
          aria-hidden="true"
        ><i /></span>
      </div>
    </section>
  )
})

export default Timeline
