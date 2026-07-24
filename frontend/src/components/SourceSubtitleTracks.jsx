import { CaptionsIcon, PlayIcon, RotateIcon } from './Icons'
import { formatTimestamp } from '../utils/subtitles'

function formatTime(value) {
  return Number.isFinite(value) ? formatTimestamp(value) : '—'
}

function formatConfidence(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—'
}

function formatBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length === 0) return '—'
  if (bbox.length >= 4 && !Array.isArray(bbox[0])) {
    return bbox.slice(0, 4).map((value) => Number(value).toFixed(1).replace(/\.0$/, '')).join(', ')
  }
  return bbox
    .filter(Array.isArray)
    .map((point) => `(${point.slice(0, 2).map((value) => Number(value).toFixed(1).replace(/\.0$/, '')).join(', ')})`)
    .join(' ')
}

function SourceState({ loading, error, emptyMessage, onRetry }) {
  if (loading) {
    return (
      <div className="source-track-state" role="status">
        <span className="large-spinner" />
        <p>正在加载来源字幕…</p>
      </div>
    )
  }
  if (error) {
    return (
      <div className="source-track-state source-track-error" role="alert">
        <strong>来源字幕加载失败</strong>
        <p>{error.message || '暂时无法读取该字幕轨。'}</p>
        <button className="button button-secondary button-small" type="button" onClick={onRetry}>
          <RotateIcon width="14" height="14" /> 重新加载
        </button>
      </div>
    )
  }
  return <div className="source-track-state"><p>{emptyMessage}</p></div>
}

function SourceHeader({ title, subtitle, count, actionLabel, onUse, disabled }) {
  return (
    <header className="source-track-heading">
      <div>
        <span className="panel-icon"><CaptionsIcon /></span>
        <div><h2>{title}</h2><p>{subtitle} · {count} 条</p></div>
      </div>
      <button className="button button-secondary button-small" type="button" onClick={onUse} disabled={disabled}>
        {actionLabel}
      </button>
    </header>
  )
}

function VisualTrack({ subtitles, loading, error, actionsDisabled, onRetry, onUse, onSeek }) {
  return (
    <section className="source-track source-track-visual" aria-labelledby="visual-track-title">
      <SourceHeader
        title={<span id="visual-track-title">视觉字幕 OCR</span>}
        subtitle="PaddleOCR"
        count={subtitles.length}
        actionLabel="Use Visual"
        onUse={onUse}
        disabled={actionsDisabled || loading || Boolean(error) || subtitles.length === 0}
      />
      <div className="source-track-list">
        {(loading || error || subtitles.length === 0) && (
          <SourceState loading={loading} error={error} emptyMessage="未检测到视觉字幕。" onRetry={onRetry} />
        )}
        {!loading && !error && subtitles.map((subtitle, index) => (
          <button
            className="source-subtitle-row"
            type="button"
            key={subtitle._sourceId}
            disabled={!Number.isFinite(subtitle.start)}
            onClick={() => onSeek?.(subtitle.start)}
            aria-label={`跳转至视觉字幕 ${index + 1}`}
          >
            <span className="source-row-time"><PlayIcon width="12" height="12" /> {formatTime(subtitle.start)} → {formatTime(subtitle.end)}</span>
            <strong>{subtitle.text || '（空文本）'}</strong>
            <dl>
              <div><dt>bbox</dt><dd>{formatBbox(subtitle.bbox)}</dd></div>
              <div><dt>置信度</dt><dd>{formatConfidence(subtitle.confidence)}</dd></div>
            </dl>
          </button>
        ))}
      </div>
    </section>
  )
}

function AudioTrack({ subtitles, loading, error, actionsDisabled, onRetry, onUse, onSeek }) {
  return (
    <section className="source-track source-track-audio" aria-labelledby="audio-track-title">
      <SourceHeader
        title={<span id="audio-track-title">音频字幕 WhisperX</span>}
        subtitle="词级时间戳"
        count={subtitles.length}
        actionLabel="Use Audio"
        onUse={onUse}
        disabled={actionsDisabled || loading || Boolean(error) || subtitles.length === 0}
      />
      <div className="source-track-list">
        {(loading || error || subtitles.length === 0) && (
          <SourceState loading={loading} error={error} emptyMessage="未检测到音频字幕。" onRetry={onRetry} />
        )}
        {!loading && !error && subtitles.map((subtitle, index) => (
          <article className="source-subtitle-row audio-source-row" key={subtitle._sourceId}>
            <button
              className="source-row-seek"
              type="button"
              disabled={!Number.isFinite(subtitle.start)}
              onClick={() => onSeek?.(subtitle.start)}
              aria-label={`跳转至音频字幕 ${index + 1}`}
            >
              <span className="source-row-time"><PlayIcon width="12" height="12" /> {formatTime(subtitle.start)} → {formatTime(subtitle.end)}</span>
              <strong>{subtitle.text || '（空文本）'}</strong>
              <small>置信度 {formatConfidence(subtitle.confidence)}</small>
            </button>
            <ol className="audio-word-list" aria-label={`第 ${index + 1} 条字幕的词级时间戳`}>
              {subtitle.words.length === 0 && <li className="audio-word-empty">无词级时间戳</li>}
              {subtitle.words.map((word) => (
                <li key={`${subtitle._sourceId}:${word._sourceId}`}>
                  <strong>{word.word || '（空词）'}</strong>
                  <span>{formatTime(word.start)}–{formatTime(word.end)}</span>
                  {Number.isFinite(word.confidence) && <em>{formatConfidence(word.confidence)}</em>}
                </li>
              ))}
            </ol>
          </article>
        ))}
      </div>
    </section>
  )
}

export default function SourceSubtitleTracks({
  visualSubtitles = [],
  audioSubtitles = [],
  visualLoading = false,
  audioLoading = false,
  visualError = null,
  audioError = null,
  actionsDisabled = false,
  onRetryVisual,
  onRetryAudio,
  onUseVisual,
  onUseAudio,
  onSeek,
}) {
  return (
    <section className="source-tracks" aria-label="独立字幕来源">
      <VisualTrack
        subtitles={visualSubtitles}
        loading={visualLoading}
        error={visualError}
        actionsDisabled={actionsDisabled}
        onRetry={onRetryVisual}
        onUse={onUseVisual}
        onSeek={onSeek}
      />
      <AudioTrack
        subtitles={audioSubtitles}
        loading={audioLoading}
        error={audioError}
        actionsDisabled={actionsDisabled}
        onRetry={onRetryAudio}
        onUse={onUseAudio}
        onSeek={onSeek}
      />
    </section>
  )
}
