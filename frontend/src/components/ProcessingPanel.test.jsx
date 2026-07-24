import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { API_BASE_URL } from '../api/tasks'
import ProcessingPanel from './ProcessingPanel'

function makeProgress(frameOverrides = {}, progressOverrides = {}) {
  const frame = {
    frameIndex: 923,
    pts: 46150,
    timeBaseNum: 1,
    timeBaseDen: 30000,
    mediaTime: 1.538,
    processed: 44,
    total: 180,
    detectedCueCount: 12,
    roi: { x: 0.08, y: 0.52, width: 0.84, height: 0.24 },
    candidates: [{
      text: 'PROTECT YOURSELF',
      confidence: 0.98,
      position: [10, 20, 300, 70],
      coordinateSpace: 'video',
    }],
    coordinateSpace: 'video',
    previewId: 'frame-good',
    roiPreviewId: 'roi-good',
    frameWidth: 1920,
    frameHeight: 1080,
    previewWidth: 640,
    previewHeight: 360,
    ...frameOverrides,
  }
  return {
    runId: 'run-one',
    lastSeq: 8,
    stage: 'coarse_ocr',
    stageLabel: 'PaddleOCR 抽帧识别',
    message: '正在识别采样帧',
    overallProgress: 38,
    stageProgress: 25,
    processed: frame.processed,
    total: frame.total,
    detectedCueCount: frame.detectedCueCount,
    frame,
    previewFrame: frame,
    thumbnails: [{
      key: 'run-one:8:frame-good',
      runId: 'run-one',
      seq: 8,
      previewId: 'frame-good',
      frameIndex: 923,
      mediaTime: 1.538,
    }],
    terminal: null,
    failureMessage: '',
    ...progressOverrides,
  }
}

function analysis(progress = makeProgress(), connection = { status: 'live', attempts: 0 }) {
  return { progress, connection, retry: vi.fn(), snapshotRestored: false }
}

function renderPanel(progress = makeProgress(), connection, taskOverrides = {}) {
  return render(
    <ProcessingPanel
      task={{ taskId: 'task-one', status: 'processing', filename: 'lesson.mp4', progress: 1, ...taskOverrides }}
      loading={false}
      pollingError={null}
      analysis={analysis(progress, connection)}
      onRetry={vi.fn()}
      onNewTask={vi.fn()}
    />,
  )
}

class SelectiveImage {
  set src(value) {
    this.value = value
    queueMicrotask(() => {
      if (value.includes('bad')) this.onerror?.(new Event('error'))
      else this.onload?.(new Event('load'))
    })
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ProcessingPanel real analysis UI', () => {
  it('renders stage/frame details, both progress bars, OCR data and preview URLs', async () => {
    vi.stubGlobal('Image', SelectiveImage)
    renderPanel()

    expect(screen.getByRole('progressbar', { name: '总体分析进度' })).toHaveAttribute('aria-valuenow', '1')
    expect(screen.getByRole('progressbar', { name: '当前阶段进度' })).toHaveAttribute('aria-valuenow', '25')
    expect(screen.getByRole('status')).toHaveTextContent('实时分析中')
    expect(screen.getAllByText('PaddleOCR 抽帧识别')).toHaveLength(2)
    expect(screen.getByText('PROTECT YOURSELF')).toBeInTheDocument()
    expect(screen.getByText('98%')).toBeInTheDocument()
    expect(screen.getByText('[10, 20, 300, 70]')).toBeInTheDocument()
    expect(screen.getByText('00:00:01.538')).toBeInTheDocument()

    const fullFrame = await screen.findByAltText('当前分析原帧')
    expect(fullFrame).toHaveAttribute(
      'src',
      `${API_BASE_URL}/tasks/task-one/previews/frame-good?run_id=run-one`,
    )
    expect(await screen.findByAltText('当前字幕 ROI 放大图')).toHaveAttribute(
      'src',
      `${API_BASE_URL}/tasks/task-one/previews/roi-good?run_id=run-one`,
    )
    expect(screen.getAllByTestId('analysis-ocr-box')).toHaveLength(1)
  })

  it('shows visual and audio job progress independently while keeping visual SSE details', () => {
    renderPanel(makeProgress(), undefined, {
      visual_progress: 72,
      audio_progress: 31,
      visual_status: 'processing',
      audio_status: 'queued',
    })

    expect(screen.getByRole('progressbar', { name: '视觉字幕提取进度' })).toHaveAttribute('aria-valuenow', '72')
    expect(screen.getByRole('progressbar', { name: '音频字幕提取进度' })).toHaveAttribute('aria-valuenow', '31')
    expect(screen.getByText('WhisperX 音频字幕')).toBeInTheDocument()
    expect(screen.getByText('PaddleOCR 视觉字幕')).toBeInTheDocument()
    expect(screen.getByText('正在识别采样帧')).toBeInTheDocument()
  })

  it('uses polling-only audio progress and hides visual analysis for audio-only tasks', () => {
    renderPanel(makeProgress(), undefined, {
      analysis_mode: 'audio',
      visual_status: 'skipped',
      audio_status: 'processing',
      audio_progress: 48,
    })

    expect(screen.getByText(/纯音频模式/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('音频分析中')
    expect(screen.getByRole('progressbar', { name: '音频字幕提取进度' }))
      .toHaveAttribute('aria-valuenow', '48')
    expect(screen.queryByText('PaddleOCR 视觉字幕')).not.toBeInTheDocument()
    expect(screen.queryByRole('progressbar', { name: '视觉字幕提取进度' })).not.toBeInTheDocument()
    expect(screen.queryByRole('progressbar', { name: '当前阶段进度' })).not.toBeInTheDocument()
    expect(screen.queryByAltText('当前分析原帧')).not.toBeInTheDocument()
  })

  it('uses audio-specific failure copy for an audio-only task', () => {
    renderPanel(makeProgress(), undefined, {
      analysis_mode: 'audio',
      status: 'failed',
    })

    expect(screen.getByRole('alert')).toHaveTextContent('音频分析失败')
    expect(screen.getByRole('alert')).toHaveTextContent('AI 服务处理音频时遇到问题')
    expect(screen.queryByText('视频分析失败')).not.toBeInTheDocument()
  })

  it('keeps processing when the visual SSE fails but the independent audio job is still running', () => {
    renderPanel(makeProgress({}, {
      terminal: 'failed',
      failureMessage: 'visual failed',
    }), undefined, {
      status: 'processing',
      progress: 55,
      visual_progress: 10,
      audio_progress: 65,
      visual_status: 'failed',
      audio_status: 'processing',
      visual_error: 'visual failed',
    })

    expect(screen.queryByText('视频分析失败')).not.toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: '总体分析进度' })).toHaveAttribute('aria-valuenow', '55')
    expect(screen.getByText('WhisperX 音频字幕')).toBeInTheDocument()
  })

  it('keeps the previous image when a new preview fails to preload', async () => {
    vi.stubGlobal('Image', SelectiveImage)
    const first = makeProgress()
    const view = renderPanel(first)
    const original = await screen.findByAltText('当前分析原帧')
    expect(original.getAttribute('src')).toContain('frame-good')

    const failedFrame = {
      ...first.frame,
      frameIndex: 924,
      previewId: 'frame-bad',
      roiPreviewId: 'roi-bad',
    }
    view.rerender(
      <ProcessingPanel
        task={{ taskId: 'task-one', status: 'processing', filename: 'lesson.mp4' }}
        loading={false}
        pollingError={null}
        analysis={analysis(makeProgress(failedFrame, { lastSeq: 9 }))}
        onRetry={vi.fn()}
        onNewTask={vi.fn()}
      />,
    )

    expect(await screen.findByText('新预览加载失败，已保留上一张可用帧。')).toBeInTheDocument()
    expect(screen.getByAltText('当前分析原帧').getAttribute('src')).toContain('frame-good')
    expect(screen.getByText('新 ROI 图片不可用，数值进度不受影响。')).toBeInTheDocument()
  })

  it('keeps image facts aligned while a rate-limited pipeline frame advances', async () => {
    vi.stubGlobal('Image', SelectiveImage)
    const first = makeProgress()
    const view = renderPanel(first)
    await screen.findByAltText('当前分析原帧')

    const pipelineFrame = {
      ...first.frame,
      seq: 9,
      frameIndex: 950,
      previewId: '',
      roiPreviewId: '',
      candidates: [{
        text: 'NEW PIPELINE TEXT',
        confidence: 0.7,
        position: [20, 30, 200, 80],
        coordinateSpace: 'video',
      }],
    }
    view.rerender(
      <ProcessingPanel
        task={{ taskId: 'task-one', status: 'processing', filename: 'lesson.mp4' }}
        loading={false}
        pollingError={null}
        analysis={analysis(makeProgress(pipelineFrame, {
          lastSeq: 9,
          previewFrame: first.frame,
        }))}
        onRetry={vi.fn()}
        onNewTask={vi.fn()}
      />,
    )

    expect(screen.getByAltText('当前分析原帧').getAttribute('src')).toContain('frame-good')
    expect(screen.getByText('PROTECT YOURSELF')).toBeInTheDocument()
    expect(screen.queryByText('NEW PIPELINE TEXT')).not.toBeInTheDocument()
    expect(screen.getByText('#950')).toBeInTheDocument()
    expect(screen.getByText('预览按频率采样，当前显示上一张可用帧。')).toBeInTheDocument()
  })

  it('exposes reconnect/recovered states and a manual retry after bounded reconnects', () => {
    const view = renderPanel(makeProgress(), { status: 'reconnecting', attempts: 3 })
    expect(screen.getByRole('status')).toHaveTextContent('暂时断线，自动重连')
    expect(screen.getByText(/第 3 次重连/)).toBeInTheDocument()

    view.rerender(
      <ProcessingPanel
        task={{ taskId: 'task-one', status: 'processing', filename: 'lesson.mp4' }}
        loading={false}
        pollingError={null}
        analysis={analysis(makeProgress(), { status: 'recovered', attempts: 3 })}
        onRetry={vi.fn()}
        onNewTask={vi.fn()}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('连接已恢复')
  })

  it('marks the panel as reduced-motion when the OS preference requests it', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
    renderPanel(makeProgress({ previewId: '', roiPreviewId: '' }))
    expect(document.querySelector('.analysis-processing-card')).toHaveAttribute('data-reduced-motion', 'true')
  })

  it('falls back to processed/total when stage_progress is absent', () => {
    renderPanel(makeProgress({}, { stageProgress: null, processed: 45, total: 180 }))
    expect(screen.getByRole('progressbar', { name: '当前阶段进度' })).toHaveAttribute('aria-valuenow', '25')
  })
})
