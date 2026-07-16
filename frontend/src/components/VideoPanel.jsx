import { forwardRef } from 'react'
import { ClockIcon, FilmIcon } from './Icons'
import { formatCompactTime } from '../utils/subtitles'

const VideoPanel = forwardRef(function VideoPanel(
  { videoUrl, filename, currentSubtitle, duration, onTimeUpdate, onDurationChange, onError },
  ref,
) {
  return (
    <section className="video-card">
      <div className="panel-heading video-heading">
        <div>
          <span className="panel-icon"><FilmIcon /></span>
          <div><h2>视频预览</h2><p title={filename}>{filename || '已上传视频'}</p></div>
        </div>
        {duration > 0 && <span className="duration-badge"><ClockIcon width="15" height="15" /> {formatCompactTime(duration)}</span>}
      </div>
      <div className="video-stage">
        <video
          ref={ref}
          controls
          preload="metadata"
          src={videoUrl}
          onTimeUpdate={(event) => onTimeUpdate(event.currentTarget.currentTime)}
          onLoadedMetadata={(event) => onDurationChange(event.currentTarget.duration)}
          onDurationChange={(event) => {
            if (Number.isFinite(event.currentTarget.duration)) onDurationChange(event.currentTarget.duration)
          }}
          onError={onError}
        >
          当前浏览器不支持 HTML5 视频播放。
        </video>
        {currentSubtitle?.text && (
          <div className="subtitle-preview" aria-live="off"><span>{currentSubtitle.text}</span></div>
        )}
      </div>
    </section>
  )
})

export default VideoPanel
