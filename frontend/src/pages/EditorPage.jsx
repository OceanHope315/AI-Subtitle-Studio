import { useCallback, useMemo, useRef, useState } from 'react'
import { getVideoUrl } from '../api/tasks'
import SourceSubtitleTracks from '../components/SourceSubtitleTracks'
import SubtitleEditor from '../components/SubtitleEditor'
import Timeline from '../components/Timeline'
import VideoPanel from '../components/VideoPanel'
import { findSubtitleAtTime } from '../utils/subtitles'

export default function EditorPage({
  task,
  subtitles,
  subtitlesLoading,
  subtitlesError,
  visualSubtitles = [],
  visualSubtitlesLoading = false,
  visualSubtitlesError = null,
  audioSubtitles = [],
  audioSubtitlesLoading = false,
  audioSubtitlesError = null,
  onSubtitleChange,
  onSubtitleDelete,
  onSubtitleAdd,
  onRetrySubtitles,
  onRetryVisualSubtitles,
  onRetryAudioSubtitles,
  onUseVisual,
  onUseAudio,
  onVideoError,
}) {
  const videoRef = useRef(null)
  const timelineRef = useRef(null)
  const currentTimeRef = useRef(0)
  const [duration, setDuration] = useState(0)
  const [selectedId, setSelectedId] = useState(null)
  const [currentSubtitleId, setCurrentSubtitleId] = useState(null)
  const currentSubtitleIdRef = useRef(null)

  const subtitlesById = useMemo(
    () => new Map(subtitles.map((subtitle) => [subtitle._clientId, subtitle])),
    [subtitles],
  )
  const currentSubtitle = currentSubtitleId ? subtitlesById.get(currentSubtitleId) : null
  const frameRate = Number(task?.metadata?.fps) > 0 ? Number(task.metadata.fps) : 30

  const syncMediaTime = useCallback((time) => {
    const safeTime = Math.max(0, Number(time) || 0)
    currentTimeRef.current = safeTime
    timelineRef.current?.syncTime(safeTime)
    const nextId = findSubtitleAtTime(subtitles, safeTime)?._clientId || null
    if (currentSubtitleIdRef.current !== nextId) {
      currentSubtitleIdRef.current = nextId
      setCurrentSubtitleId(nextId)
    }
  }, [subtitles])

  const seek = (time, shouldPlay = false) => {
    const safeTime = Math.max(0, Math.min(Number(time) || 0, duration || Number(time) || 0))
    syncMediaTime(safeTime)
    if (videoRef.current) {
      videoRef.current.currentTime = safeTime
      if (shouldPlay) videoRef.current.play().catch(() => {})
    }
  }

  const addAtPlayhead = () => {
    const newId = onSubtitleAdd(currentTimeRef.current, duration)
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
          frameRate={frameRate}
          onMediaTime={syncMediaTime}
          onDurationChange={setDuration}
          onError={onVideoError}
        />
      </div>
      <SourceSubtitleTracks
        visualSubtitles={visualSubtitles}
        audioSubtitles={audioSubtitles}
        visualLoading={visualSubtitlesLoading}
        audioLoading={audioSubtitlesLoading}
        visualError={visualSubtitlesError}
        audioError={audioSubtitlesError}
        actionsDisabled={subtitlesLoading || Boolean(subtitlesError)}
        onRetryVisual={onRetryVisualSubtitles}
        onRetryAudio={onRetryAudioSubtitles}
        onUseVisual={onUseVisual}
        onUseAudio={onUseAudio}
        onSeek={seek}
      />
      <Timeline
        ref={timelineRef}
        subtitles={subtitles}
        duration={duration}
        initialTime={0}
        frameRate={frameRate}
        selectedId={selectedId}
        onSeek={seek}
        onSelect={setSelectedId}
      />
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
