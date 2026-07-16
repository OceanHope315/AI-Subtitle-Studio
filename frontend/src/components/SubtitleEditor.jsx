import { CaptionsIcon, PlayIcon, PlusIcon, TrashIcon } from './Icons'
import TimeInput from './TimeInput'

function SubtitleRow({
  subtitle,
  index,
  current,
  selected,
  onSelect,
  onSeek,
  onChange,
  onDelete,
}) {
  const timingInvalid = subtitle.end_time <= subtitle.start_time
  const confidence = subtitle.confidence == null ? null : Number(subtitle.confidence)

  return (
    <article
      className={`subtitle-row ${current ? 'is-current' : ''} ${selected ? 'is-selected' : ''} ${timingInvalid ? 'has-error' : ''}`}
      onClick={(event) => {
        onSelect(subtitle._clientId)
        if (!event.target.closest('input, textarea, button')) onSeek(subtitle.start_time)
      }}
    >
      <div className="subtitle-row-index">
        <button
          type="button"
          aria-label={`播放第 ${index + 1} 条字幕`}
          onClick={() => {
            onSelect(subtitle._clientId)
            onSeek(subtitle.start_time, true)
          }}
        >
          {current ? <PlayIcon width="14" height="14" /> : String(index + 1).padStart(2, '0')}
        </button>
        {confidence !== null && Number.isFinite(confidence) && (
          <span title="OCR 置信度">{Math.round(confidence * (confidence <= 1 ? 100 : 1))}%</span>
        )}
      </div>

      <div className="subtitle-row-fields">
        <textarea
          value={subtitle.text}
          rows="2"
          aria-label={`第 ${index + 1} 条字幕文本`}
          placeholder="输入字幕内容…"
          onFocus={() => onSelect(subtitle._clientId)}
          onChange={(event) => onChange(subtitle._clientId, { text: event.target.value })}
        />
        <div className="subtitle-time-fields">
          <TimeInput
            key={`${subtitle._clientId}-start-${subtitle.start_time}`}
            label="开始"
            value={subtitle.start_time}
            invalid={timingInvalid}
            onFocus={() => onSelect(subtitle._clientId)}
            onCommit={(value) => onChange(subtitle._clientId, { start_time: value })}
          />
          <span className="time-arrow">→</span>
          <TimeInput
            key={`${subtitle._clientId}-end-${subtitle.end_time}`}
            label="结束"
            value={subtitle.end_time}
            invalid={timingInvalid}
            onFocus={() => onSelect(subtitle._clientId)}
            onCommit={(value) => onChange(subtitle._clientId, { end_time: value })}
          />
        </div>
      </div>

      <button
        type="button"
        className="icon-button delete-button"
        aria-label={`删除第 ${index + 1} 条字幕`}
        title="删除字幕"
        onClick={(event) => {
          event.stopPropagation()
          onDelete(subtitle._clientId)
        }}
      >
        <TrashIcon width="17" height="17" />
      </button>
    </article>
  )
}

export default function SubtitleEditor({
  subtitles,
  currentSubtitleId,
  selectedId,
  loading,
  error,
  onSelect,
  onSeek,
  onChange,
  onDelete,
  onAdd,
  onRetry,
}) {
  return (
    <section className="subtitle-panel">
      <div className="panel-heading subtitle-panel-heading">
        <div>
          <span className="panel-icon"><CaptionsIcon /></span>
          <div><h2>字幕校对</h2><p>{loading ? '正在读取字幕…' : `共 ${subtitles.length} 条字幕`}</p></div>
        </div>
        <button className="button button-secondary button-small" type="button" onClick={onAdd} disabled={loading || Boolean(error)}>
          <PlusIcon width="17" height="17" /> 添加字幕
        </button>
      </div>

      <div className="subtitle-list" aria-busy={loading}>
        {loading && (
          <div className="panel-state">
            <span className="large-spinner" />
            <strong>正在加载字幕</strong>
            <p>马上就好…</p>
          </div>
        )}

        {!loading && error && (
          <div className="panel-state panel-state-error" role="alert">
            <strong>字幕加载失败</strong>
            <p>{error.message || '无法读取字幕数据。'}</p>
            <button className="button button-secondary button-small" type="button" onClick={onRetry}>重新加载</button>
          </div>
        )}

        {!loading && !error && subtitles.length === 0 && (
          <div className="panel-state empty-subtitles">
            <span><CaptionsIcon width="27" height="27" /></span>
            <strong>暂未识别到字幕</strong>
            <p>可以手动添加第一条字幕，继续完成时间轴。</p>
            <button className="button button-primary button-small" type="button" onClick={onAdd}>
              <PlusIcon width="17" height="17" /> 添加字幕
            </button>
          </div>
        )}

        {!loading && !error && subtitles.map((subtitle, index) => (
          <SubtitleRow
            key={subtitle._clientId}
            subtitle={subtitle}
            index={index}
            current={subtitle._clientId === currentSubtitleId}
            selected={subtitle._clientId === selectedId}
            onSelect={onSelect}
            onSeek={onSeek}
            onChange={onChange}
            onDelete={onDelete}
          />
        ))}
      </div>

      {!loading && !error && subtitles.length > 0 && (
        <div className="subtitle-panel-footer">
          <span>提示：时间支持输入秒数或 00:00:00.000</span>
          <button type="button" onClick={onAdd}><PlusIcon width="15" height="15" /> 在播放位置添加</button>
        </div>
      )}
    </section>
  )
}
