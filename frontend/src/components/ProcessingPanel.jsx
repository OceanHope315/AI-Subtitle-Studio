import { AlertIcon, CheckIcon, FilmIcon, RotateIcon, SparklesIcon } from './Icons'

const steps = [
  { at: 0, label: '视频已上传', detail: '文件已安全保存' },
  { at: 8, label: '解析视频画面', detail: '读取帧率与分辨率' },
  { at: 24, label: '识别画面字幕', detail: 'OCR 扫描已框选字幕区域' },
  { at: 82, label: '生成字幕时间轴', detail: '去重、合并并生成片段' },
]

function clampProgress(progress) {
  const value = Number(progress)
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

export default function ProcessingPanel({ task, loading, pollingError, onRetry, onNewTask }) {
  const progress = clampProgress(task?.progress)
  const failed = task?.status === 'failed'
  const activeIndex = [...steps].reverse().findIndex((step) => progress >= step.at)
  const actualActiveIndex = activeIndex < 0 ? 0 : steps.length - 1 - activeIndex

  if (failed) {
    return (
      <main className="state-page">
        <section className="failure-card" role="alert">
          <span className="failure-icon"><AlertIcon width="30" height="30" /></span>
          <div>
            <p className="state-kicker">处理未完成</p>
            <h1>视频分析失败</h1>
            <p>{task?.error || task?.message || 'AI 服务处理视频时遇到问题，请稍后重试。'}</p>
          </div>
          <div className="state-actions">
            <button className="button button-primary" type="button" onClick={onRetry}>
              <RotateIcon /> 重试查询
            </button>
            <button className="button button-secondary" type="button" onClick={onNewTask}>上传新视频</button>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="state-page">
      <section className="processing-card" aria-live="polite">
        <div className="processing-visual">
          <div className="scan-frame">
            <span className="corner corner-tl" /><span className="corner corner-tr" />
            <span className="corner corner-bl" /><span className="corner corner-br" />
            <FilmIcon width="38" height="38" />
            <i className="scan-line" />
          </div>
          <span className="ai-badge"><SparklesIcon width="14" height="14" /> AI 分析中</span>
        </div>

        <div className="processing-copy">
          <p className="state-kicker">任务正在后台运行</p>
          <h1>{loading && !task ? '正在读取任务…' : '正在提取视频字幕'}</h1>
          <p>AI 正在逐帧分析画面。你可以保持此页面开启，完成后会自动进入编辑器。</p>
        </div>

        <div className="main-progress">
          <div className="main-progress-label">
            <span>{task?.filename || '视频处理任务'}</span>
            <strong>{progress}%</strong>
          </div>
          <div className="progress-track progress-track-large"><span style={{ width: `${progress}%` }} /></div>
        </div>

        <ol className="processing-steps">
          {steps.map((step, index) => {
            const done = index < actualActiveIndex || progress >= 100
            const active = index === actualActiveIndex && progress < 100
            return (
              <li key={step.label} className={`${done ? 'is-done' : ''} ${active ? 'is-active' : ''}`}>
                <span className="step-marker">
                  {done ? <CheckIcon width="14" height="14" /> : active ? <span className="pulse-dot" /> : index + 1}
                </span>
                <div><strong>{step.label}</strong><small>{step.detail}</small></div>
              </li>
            )
          })}
        </ol>

        {pollingError && (
          <div className="connection-warning">
            <AlertIcon width="17" height="17" />
            <span>暂时无法获取最新进度，正在自动重连。</span>
            <button type="button" onClick={onRetry}>立即重试</button>
          </div>
        )}
      </section>
    </main>
  )
}
