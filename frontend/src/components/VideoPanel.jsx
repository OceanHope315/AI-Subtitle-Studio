import { forwardRef, useEffect, useRef } from 'react'
import { ClockIcon, FilmIcon } from './Icons'
import { formatCompactTime } from '../utils/subtitles'

const VideoPanel = forwardRef(function VideoPanel(
  { videoUrl, filename, currentSubtitle, duration, frameRate, onMediaTime, onDurationChange, onError },
  forwardedRef,
) {
  const videoRef = useRef(null)
  const onMediaTimeRef = useRef(onMediaTime)
  onMediaTimeRef.current = onMediaTime

  const setVideoRef = (node) => {
    videoRef.current = node
    if (typeof forwardedRef === 'function') forwardedRef(node)
    else if (forwardedRef) forwardedRef.current = node
  }

  useEffect(() => {
    const video = videoRef.current
    if (!video) return undefined
    let cancelled = false
    let videoFrameId = null
    let animationFrameId = null

    const publish = (time) => onMediaTimeRef.current?.(Number.isFinite(time) ? time : video.currentTime)
    const onVideoFrame = (_now, metadata) => {
      if (cancelled) return
      publish(metadata.mediaTime)
      videoFrameId = video.requestVideoFrameCallback(onVideoFrame)
    }
    const onAnimationFrame = () => {
      if (cancelled) return
      publish(video.currentTime)
      animationFrameId = window.requestAnimationFrame(onAnimationFrame)
    }

    if (typeof video.requestVideoFrameCallback === 'function') {
      videoFrameId = video.requestVideoFrameCallback(onVideoFrame)
    } else {
      animationFrameId = window.requestAnimationFrame(onAnimationFrame)
    }

    return () => {
      cancelled = true
      if (videoFrameId !== null && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(videoFrameId)
      }
      if (animationFrameId !== null) window.cancelAnimationFrame(animationFrameId)
    }
  }, [videoUrl])

  const syncImmediately = (event) => onMediaTimeRef.current?.(event.currentTarget.currentTime)
  const stepFrame = (direction) => {
    const video = videoRef.current
    if (!video) return
    const fps = Number(frameRate) > 0 ? Number(frameRate) : 30
    video.pause()
    const next = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + direction / fps))
    video.currentTime = next
    onMediaTimeRef.current?.(next)
  }

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
          ref={setVideoRef}
          className="video-preview-media"
          controls
          preload="metadata"
          src={videoUrl}
          onLoadedMetadata={(event) => {
            onDurationChange(event.currentTarget.duration)
            syncImmediately(event)
          }}
          onDurationChange={(event) => {
            if (Number.isFinite(event.currentTarget.duration)) onDurationChange(event.currentTarget.duration)
          }}
          onPlay={syncImmediately}
          onPause={syncImmediately}
          onSeeking={syncImmediately}
          onSeeked={syncImmediately}
          onError={onError}
        >
          当前浏览器不支持 HTML5 视频播放。
        </video>
        {currentSubtitle?.text && (
          <div className="subtitle-preview" aria-live="off"><span>{currentSubtitle.text}</span></div>
        )}
      </div>
      <div className="frame-controls" aria-label="逐帧控制">
        <button type="button" onClick={() => stepFrame(-1)} aria-label="后退一帧">← 后退一帧</button>
        <span>{(Number(frameRate) || 30).toFixed(3).replace(/\.0+$/, '')} FPS</span>
        <button type="button" onClick={() => stepFrame(1)} aria-label="前进一帧">前进一帧 →</button>
      </div>
    </section>
  )
})

export default VideoPanel
