import { formatCompactTime } from '../utils/subtitles'

const TICK_COUNT = 5

export default function Timeline({ subtitles, duration, currentTime, selectedId, onSeek, onSelect }) {
  const lastEnd = subtitles.reduce((max, subtitle) => Math.max(max, subtitle.end_time), 0)
  const timelineDuration = Math.max(duration || 0, lastEnd, 1)
  const playhead = Math.min(100, Math.max(0, (currentTime / timelineDuration) * 100))
  const ticks = Array.from({ length: TICK_COUNT }, (_, index) => (timelineDuration * index) / (TICK_COUNT - 1))

  const seekFromPointer = (event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    onSeek(ratio * timelineDuration)
  }

  return (
    <section className="timeline-card" aria-label="字幕时间轴">
      <div className="timeline-heading">
        <div><strong>时间轴</strong><span>{subtitles.length} 个字幕片段</span></div>
        <span>{formatCompactTime(currentTime)} / {formatCompactTime(timelineDuration)}</span>
      </div>
      <div className="timeline-ruler" aria-hidden="true">
        {ticks.map((tick) => <span key={tick}>{formatCompactTime(tick)}</span>)}
      </div>
      <div
        className="timeline-track"
        role="slider"
        tabIndex="0"
        aria-label="视频时间"
        aria-valuemin="0"
        aria-valuemax={timelineDuration}
        aria-valuenow={currentTime}
        onClick={seekFromPointer}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') onSeek(Math.min(timelineDuration, currentTime + 1))
          if (event.key === 'ArrowLeft') onSeek(Math.max(0, currentTime - 1))
        }}
      >
        <div className="timeline-grid" />
        {subtitles.map((subtitle, index) => {
          const left = Math.max(0, (subtitle.start_time / timelineDuration) * 100)
          const width = Math.max(0.5, ((subtitle.end_time - subtitle.start_time) / timelineDuration) * 100)
          const active = currentTime >= subtitle.start_time && currentTime < subtitle.end_time
          return (
            <button
              type="button"
              key={subtitle._clientId}
              className={`timeline-segment ${active ? 'is-active' : ''} ${selectedId === subtitle._clientId ? 'is-selected' : ''}`}
              style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
              title={`${index + 1}. ${subtitle.text}`}
              aria-label={`跳转至第 ${index + 1} 条字幕`}
              onClick={(event) => {
                event.stopPropagation()
                onSelect(subtitle._clientId)
                onSeek(subtitle.start_time)
              }}
            >
              <span>{index + 1}</span>
            </button>
          )
        })}
        <span className="timeline-playhead" style={{ left: `${playhead}%` }} aria-hidden="true"><i /></span>
      </div>
    </section>
  )
}
