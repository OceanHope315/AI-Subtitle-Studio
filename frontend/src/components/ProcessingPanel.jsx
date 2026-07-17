import { useState } from 'react'
import { getTaskPreviewUrl } from '../api/tasks'
import usePreloadedAsset from '../hooks/usePreloadedAsset'
import usePrefersReducedMotion from '../hooks/usePrefersReducedMotion'
import { STAGE_LABELS } from '../utils/analysisProgress'
import AnalysisFrame from './AnalysisFrame'
import { AlertIcon, CheckIcon, RotateIcon, SparklesIcon } from './Icons'

const STAGES = [
  'probing',
  'coarse_ocr',
  'short_event_discovery',
  'event_aggregation',
  'boundary_refinement',
  'whisper_correction',
  'artifact_generation',
]

const CONNECTION_LABELS = {
  idle: '等待任务启动',
  connecting: '正在连接实时分析',
  live: '实时分析中',
  recovered: '连接已恢复 · 实时分析中',
  reconnecting: '暂时断线，自动重连',
  offline: '实时连接已暂停',
  completed: '分析完成',
  failed: '分析失败',
}

function clampProgress(progress) {
  const value = Number(progress)
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function valueOrDash(value) {
  return value === null || value === undefined || value === '' ? '—' : value
}

function formatAnalysisTime(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value < 0) return '—'
  const milliseconds = Math.round(value * 1000)
  const hours = Math.floor(milliseconds / 3600000)
  const minutes = Math.floor((milliseconds % 3600000) / 60000)
  const secs = Math.floor((milliseconds % 60000) / 1000)
  const millis = milliseconds % 1000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}

function formatConfidence(confidence) {
  const value = Number(confidence)
  if (!Number.isFinite(value)) return '—'
  return `${Math.round(value * (value <= 1 ? 100 : 1))}%`
}

function formatPosition(position) {
  if (!Array.isArray(position)) return '坐标不可用'
  if (position.length >= 4 && !Array.isArray(position[0])) {
    return position.slice(0, 4).map((value) => Math.round(Number(value) || 0)).join(', ')
  }
  return position
    .filter(Array.isArray)
    .map((point) => `(${Math.round(Number(point[0]) || 0)}, ${Math.round(Number(point[1]) || 0)})`)
    .join(' ')
}

function RoiPreview({ asset }) {
  const [failedSource, setFailedSource] = useState('')
  const failed = Boolean(asset?.source && asset.source === failedSource)
  if (!asset?.source || failed) {
    return (
      <div className="analysis-roi-placeholder">
        <span>{failed ? 'ROI 预览读取失败' : '等待 ROI 放大图'}</span>
      </div>
    )
  }
  return <img src={asset.source} alt="当前字幕 ROI 放大图" onError={() => setFailedSource(asset.source)} />
}

function ProgressThumbnail({ item, taskId }) {
  const [failed, setFailed] = useState(false)
  const source = getTaskPreviewUrl(taskId, item.previewId, item.runId)
  return (
    <li title={`帧 ${valueOrDash(item.frameIndex)} · ${formatAnalysisTime(item.mediaTime)}`}>
      {!failed && source
        ? <img src={source} alt={`最近分析帧 ${valueOrDash(item.frameIndex)}`} onError={() => setFailed(true)} />
        : <span>预览不可用</span>}
      <small>#{valueOrDash(item.frameIndex)}</small>
    </li>
  )
}

export default function ProcessingPanel({
  task,
  loading,
  pollingError,
  analysis,
  onRetry,
  onNewTask,
}) {
  const reducedMotion = usePrefersReducedMotion()
  const taskId = task?.taskId || task?.id || ''
  const model = analysis?.progress
  const connection = analysis?.connection || { status: 'idle', attempts: 0 }
  const pipelineFrame = model?.frame || null
  const requestedPreviewFrame = model?.previewFrame
    || (pipelineFrame?.previewId ? pipelineFrame : null)
  const runId = model?.runId || ''
  const frameSource = requestedPreviewFrame?.previewId
    ? getTaskPreviewUrl(taskId, requestedPreviewFrame.previewId, runId)
    : ''
  const roiSource = requestedPreviewFrame?.roiPreviewId
    ? getTaskPreviewUrl(taskId, requestedPreviewFrame.roiPreviewId, runId)
    : ''
  const frameAsset = usePreloadedAsset(frameSource, requestedPreviewFrame, runId)
  const roiAsset = usePreloadedAsset(roiSource, requestedPreviewFrame, runId)
  // Keep pixels, overlay, facts, and OCR candidates on the same event. The
  // pipeline cursor can advance between rate-limited preview images.
  const frame = frameAsset.displayed?.value || requestedPreviewFrame || pipelineFrame
  const progress = clampProgress(model?.overallProgress ?? task?.progress)
  const failed = task?.status === 'failed' || model?.terminal === 'failed'
  const completed = task?.status === 'completed' || model?.terminal === 'completed'
  const currentStageIndex = STAGES.indexOf(model?.stage)
  const candidates = frame?.candidates || []
  const previewLagging = Boolean(
    frameAsset.displayed
      && pipelineFrame
      && (
        !pipelineFrame.previewId
        || pipelineFrame.seq !== frameAsset.displayed.value?.seq
      ),
  )
  const derivedStageProgress = model?.total > 0
    ? (Number(model.processed) / Number(model.total)) * 100
    : 0
  const stageProgress = clampProgress(model?.stageProgress ?? derivedStageProgress)

  const retryAll = () => {
    analysis?.retry?.()
    onRetry?.()
  }

  if (failed) {
    return (
      <main className="state-page">
        <section className="failure-card" role="alert">
          <span className="failure-icon"><AlertIcon width="30" height="30" /></span>
          <div>
            <p className="state-kicker">处理未完成</p>
            <h1>视频分析失败</h1>
            <p>{model?.failureMessage || task?.error || task?.message || 'AI 服务处理视频时遇到问题，请稍后重试。'}</p>
          </div>
          <div className="state-actions">
            <button className="button button-primary" type="button" onClick={retryAll}>
              <RotateIcon /> 重试查询
            </button>
            <button className="button button-secondary" type="button" onClick={onNewTask}>上传新视频</button>
          </div>
        </section>
      </main>
    )
  }

  const status = completed ? 'completed' : connection.status
  const connectionLabel = CONNECTION_LABELS[status] || CONNECTION_LABELS.idle

  return (
    <main className="state-page analysis-progress-page">
      <section className={`processing-card analysis-processing-card ${reducedMotion ? 'is-reduced-motion' : ''}`} data-reduced-motion={reducedMotion ? 'true' : 'false'}>
        <header className="analysis-progress-header">
          <div>
            <p className="state-kicker"><SparklesIcon width="14" height="14" /> AI 可视化分析</p>
            <h1>{loading && !task ? '正在读取任务快照…' : (model?.stage ? model.stageLabel : '正在提取视频字幕')}</h1>
            <p>{model?.message || '等待真实管线进度；分析会在后台持续运行。'}</p>
          </div>
          <span className={`analysis-connection is-${status}`} role="status" aria-live="polite">
            <i /> {connectionLabel}
          </span>
        </header>

        <div className="main-progress analysis-main-progress">
          <div className="main-progress-label">
            <span title={task?.filename}>{task?.filename || '视频处理任务'}</span>
            <strong>{progress}%</strong>
          </div>
          <div
            className="progress-track progress-track-large"
            role="progressbar"
            aria-label="总体分析进度"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={progress}
          ><span style={{ width: `${progress}%` }} /></div>
        </div>

        <div className="analysis-progress-grid">
          <section className="analysis-frame-panel" aria-labelledby="analysis-frame-title">
            <div className="analysis-section-heading">
              <div>
                <span>原始帧 + ROI / OCR Overlay</span>
                <strong id="analysis-frame-title">最近可视分析帧</strong>
              </div>
              <span>{frame ? `#${valueOrDash(frame.frameIndex)}` : '等待帧事件'}</span>
            </div>
            <AnalysisFrame asset={frameAsset.displayed} />
            {(frameAsset.status === 'failed' || previewLagging) && (
              <p className="analysis-image-note" role="status">
                {frameAsset.status === 'failed'
                  ? '新预览加载失败，已保留上一张可用帧。'
                  : '预览按频率采样，当前显示上一张可用帧。'}
              </p>
            )}
            <dl className="analysis-frame-facts">
              <div><dt>帧号</dt><dd>{valueOrDash(frame?.frameIndex)}</dd></div>
              <div><dt>PTS</dt><dd>{valueOrDash(frame?.pts)}</dd></div>
              <div><dt>Time base</dt><dd>{frame?.timeBaseNum !== null && frame?.timeBaseDen ? `${frame.timeBaseNum}/${frame.timeBaseDen}` : '—'}</dd></div>
              <div><dt>媒体时间</dt><dd>{formatAnalysisTime(frame?.mediaTime)}</dd></div>
            </dl>

            <div className="analysis-thumbnails">
              <div><strong>最近关键帧</strong><span>最多保留 5 张</span></div>
              {model?.thumbnails?.length ? (
                <ol>
                  {model.thumbnails.map((item) => <ProgressThumbnail item={item} taskId={taskId} key={item.key} />)}
                </ol>
              ) : <p>首张进度预览生成后会显示在这里。</p>}
            </div>
          </section>

          <aside className="analysis-detail-panel">
            <section className="analysis-roi-card">
              <div className="analysis-section-heading">
                <div><span>手动选择区域</span><strong>ROI 放大图</strong></div>
              </div>
              <div className="analysis-roi-image"><RoiPreview asset={roiAsset.displayed} /></div>
              {roiAsset.status === 'failed' && <small className="analysis-image-note">新 ROI 图片不可用，数值进度不受影响。</small>}
            </section>

            <dl className="analysis-metrics">
              <div><dt>已处理 / 总帧</dt><dd>{model?.processed ?? 0} <span>/ {model?.total ?? '—'}</span></dd></div>
              <div><dt>发现字幕事件</dt><dd>{model?.detectedCueCount ?? 0} <span>条</span></dd></div>
              <div><dt>管线当前帧</dt><dd>{pipelineFrame ? `#${valueOrDash(pipelineFrame.frameIndex)}` : '—'}</dd></div>
              <div><dt>当前阶段</dt><dd>{model?.stage || '—'}</dd></div>
              <div><dt>事件游标</dt><dd>{runId ? `#${model?.lastSeq || 0}` : '—'}</dd></div>
            </dl>

            <section className="analysis-stage-progress" aria-label="当前阶段进度">
              <div><span>阶段进度</span><strong>{stageProgress}%</strong></div>
              <div
                className="progress-track"
                role="progressbar"
                aria-label="当前阶段进度"
                aria-valuemin="0"
                aria-valuemax="100"
                aria-valuenow={stageProgress}
              ><span style={{ width: `${stageProgress}%` }} /></div>
            </section>

            <section className="analysis-candidates" aria-labelledby="ocr-candidates-title">
              <div className="analysis-section-heading">
                <div><span>全局视频坐标</span><strong id="ocr-candidates-title">PaddleOCR 候选</strong></div>
                <span>{candidates.length} 项</span>
              </div>
              {frame && candidates.length === 0 && <p className="analysis-empty-candidates">当前采样帧未检出字幕文字。</p>}
              {!frame && <p className="analysis-empty-candidates">等待真实 OCR 帧结果。</p>}
              {candidates.length > 0 && (
                <ol>
                  {candidates.map((candidate, index) => (
                    <li key={`${index}:${candidate.text}`}>
                      <span>{index + 1}</span>
                      <div><strong>{candidate.text || '（空文本）'}</strong><small>[{formatPosition(candidate.position)}]</small></div>
                      <em>{formatConfidence(candidate.confidence)}</em>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </aside>
        </div>

        <ol className="analysis-stage-track" aria-label="分析阶段">
          {STAGES.map((stage, index) => {
            const done = completed || (currentStageIndex >= 0 && index < currentStageIndex)
            const active = !completed && index === currentStageIndex
            return (
              <li key={stage} className={`${done ? 'is-done' : ''} ${active ? 'is-active' : ''}`}>
                <span>{done ? <CheckIcon width="12" height="12" /> : index + 1}</span>
                <small>{STAGE_LABELS[stage]}</small>
              </li>
            )
          })}
        </ol>

        {(pollingError || status === 'reconnecting' || status === 'offline') && (
          <div className="connection-warning">
            <AlertIcon width="17" height="17" />
            <span>
              {status === 'offline'
                ? '有限次数自动重连已结束；任务仍在服务器后台运行。'
                : `暂时无法获取最新实时进度${connection.attempts ? `（第 ${connection.attempts} 次重连）` : ''}。`}
            </span>
            <button type="button" onClick={retryAll}>立即重试</button>
          </div>
        )}
      </section>
    </main>
  )
}
