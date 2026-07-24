import { useRef, useState } from 'react'
import { CaptionsIcon, ClockIcon, FilmIcon, SparklesIcon, UploadIcon } from './Icons'
import { ANALYSIS_MODES, isAudioOnlyMode } from '../utils/analysisMode'

const MAX_DISPLAY_SIZE = '建议不超过 2 GB'

const MODE_OPTIONS = [
  {
    value: ANALYSIS_MODES.AUDIO,
    title: '纯音频模式',
    description: '原视频无画面字幕，仅使用 WhisperX 识别声音，上传后直接开始分析。',
  },
  {
    value: ANALYSIS_MODES.AUDIO_VISUAL,
    title: '音频 + 视觉模式',
    description: '同时识别声音和画面硬字幕，可在工作区对比两条来源轨。',
  },
]

export default function UploadPanel({
  uploading,
  uploadProgress,
  error,
  analysisMode = ANALYSIS_MODES.AUDIO_VISUAL,
  onAnalysisModeChange,
  onUpload,
}) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef(null)
  const audioOnly = isAudioOnlyMode(analysisMode)

  const submitFile = (file) => {
    if (!file) return
    const hasMp4Extension = file.name.toLowerCase().endsWith('.mp4')
    const hasMp4Mime = !file.type || [
      'video/mp4',
      'application/mp4',
      'application/octet-stream',
    ].includes(file.type)
    if (!hasMp4Extension || !hasMp4Mime) {
      onUpload(null, '当前仅支持 MP4 视频，请重新选择。')
      return
    }
    onUpload(file)
  }

  const handleDrop = (event) => {
    event.preventDefault()
    setDragging(false)
    submitFile(event.dataTransfer.files?.[0])
  }

  return (
    <main className="landing">
      <section className="hero" aria-labelledby="hero-title">
        <div className="eyebrow"><SparklesIcon /> AI 驱动的视频字幕工具</div>
        <h1 id="hero-title">让字幕制作，从繁琐校对<br /><span>变成高效创作</span></h1>
        <p className="hero-description">
          上传游戏或讲解视频，可选择仅识别音频，或同时识别画面硬字幕，
          在一个工作台内完成校对与 SRT 导出。
        </p>

        <fieldset className="analysis-mode-selector" disabled={uploading}>
          <legend>选择分析模式</legend>
          <div className="analysis-mode-options">
            {MODE_OPTIONS.map((option) => {
              const selected = analysisMode === option.value
              return (
                <label
                  className={`analysis-mode-option ${selected ? 'is-selected' : ''}`}
                  key={option.value}
                >
                  <input
                    type="radio"
                    name="analysis-mode"
                    value={option.value}
                    checked={selected}
                    onChange={() => onAnalysisModeChange?.(option.value)}
                  />
                  <span className="analysis-mode-indicator" aria-hidden="true"><i /></span>
                  <span>
                    <strong>{option.title}</strong>
                    <small>{option.description}</small>
                  </span>
                </label>
              )
            })}
          </div>
        </fieldset>

        <div
          className={`upload-zone ${dragging ? 'is-dragging' : ''} ${uploading ? 'is-uploading' : ''}`}
          role="button"
          tabIndex={uploading ? -1 : 0}
          aria-label="上传 MP4 视频"
          onClick={() => !uploading && inputRef.current?.click()}
          onKeyDown={(event) => {
            if (!uploading && (event.key === 'Enter' || event.key === ' ')) inputRef.current?.click()
          }}
          onDragEnter={(event) => {
            event.preventDefault()
            if (!uploading) setDragging(true)
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false)
          }}
          onDrop={handleDrop}
        >
          <input
            ref={inputRef}
            type="file"
            accept="video/mp4,.mp4"
            hidden
            disabled={uploading}
            onChange={(event) => {
              submitFile(event.target.files?.[0])
              event.target.value = ''
            }}
          />

          {uploading ? (
            <div className="uploading-content">
              <div className="upload-orbit"><FilmIcon /></div>
              <div>
                <h2>正在安全上传视频</h2>
                <p>
                  {audioOnly
                    ? '请保持页面开启，上传完成后将直接开始音频识别'
                    : '请保持页面开启，上传完成后将自动估计字幕区域'}
                </p>
              </div>
              <div className="upload-progress-row">
                <div className="progress-track"><span style={{ width: `${uploadProgress}%` }} /></div>
                <strong>{uploadProgress}%</strong>
              </div>
            </div>
          ) : (
            <>
              <div className="upload-icon"><UploadIcon width="30" height="30" /></div>
              <h2>{dragging ? '松开即可上传' : '拖放视频到这里'}</h2>
              <p>或点击选择本地文件</p>
              <div className="upload-hints">
                <span>MP4 格式</span><i />
                <span>{MAX_DISPLAY_SIZE}</span><i />
                <span>本地安全处理</span>
              </div>
            </>
          )}
        </div>

        {error && <div className="inline-error" role="alert">{error}</div>}

        <div className="feature-strip" aria-label="产品能力">
          <div className="feature-item">
            <span><CaptionsIcon /></span>
            <div><strong>硬字幕识别</strong><small>定位画面字幕区域</small></div>
          </div>
          <div className="feature-divider" />
          <div className="feature-item">
            <span><ClockIcon /></span>
            <div><strong>智能时间轴</strong><small>自动合并重复帧</small></div>
          </div>
          <div className="feature-divider" />
          <div className="feature-item">
            <span><SparklesIcon /></span>
            <div><strong>一站式校对</strong><small>编辑后直接导出 SRT</small></div>
          </div>
        </div>
      </section>
    </main>
  )
}
