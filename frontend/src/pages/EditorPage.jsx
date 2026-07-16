import { useMemo, useRef, useState } from 'react'
import { getVideoUrl } from '../api/tasks'
import SubtitleEditor from '../components/SubtitleEditor'
import Timeline from '../components/Timeline'
import VideoPanel from '../components/VideoPanel'

export default function EditorPage({
  task,
  subtitles,
  subtitlesLoading,
  subtitlesError,
  onSubtitleChange,
  onSubtitleDelete,
  onSubtitleAdd,
  onRetrySubtitles,
  onVideoError,
}) {
  const videoRef = useRef(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [selectedId, setSelectedId] = useState(null)

  const currentSubtitle = useMemo(
    () => subtitles.find((subtitle) => currentTime >= subtitle.start_time && currentTime < subtitle.end_time),
    [currentTime, subtitles],
  )

  const seek = (time, shouldPlay = false) => {
    const safeTime = Math.max(0, Math.min(Number(time) || 0, duration || Number(time) || 0))
    setCurrentTime(safeTime)
    if (videoRef.current) {
      videoRef.current.currentTime = safeTime
      if (shouldPlay) videoRef.current.play().catch(() => {})
    }
  }

  const addAtPlayhead = () => {
    const newId = onSubtitleAdd(currentTime, duration)
    if (newId) setSelectedId(newId)
  }

  return (
    <main className="editor-layout">
      <div className="editor-primary">
        <VideoPanel
          ref={videoRef}
          videoUrl={getVideoUrl(task.taskId || task.id || task._id)}
          filename={task.filename || task.originalName}
          currentSubtitle={currentSubtitle}
          duration={duration}
          onTimeUpdate={setCurrentTime}
          onDurationChange={setDuration}
          onError={onVideoError}
        />
        <Timeline
          subtitles={subtitles}
          duration={duration}
          currentTime={currentTime}
          selectedId={selectedId}
          onSeek={seek}
          onSelect={setSelectedId}
        />
      </div>
      <SubtitleEditor
        subtitles={subtitles}
        currentSubtitleId={currentSubtitle?._clientId}
        selectedId={selectedId}
        loading={subtitlesLoading}
        error={subtitlesError}
        onSelect={setSelectedId}
        onSeek={seek}
        onChange={onSubtitleChange}
        onDelete={(id) => {
          onSubtitleDelete(id)
          if (selectedId === id) setSelectedId(null)
        }}
        onAdd={addAtPlayhead}
        onRetry={onRetrySubtitles}
      />
    </main>
  )
}
