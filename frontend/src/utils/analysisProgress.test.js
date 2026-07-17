import { describe, expect, it } from 'vitest'
import {
  MAX_PROGRESS_THUMBNAILS,
  createEmptyAnalysisProgress,
  hydrateAnalysisSnapshot,
  reduceAnalysisEvent,
} from './analysisProgress'

function event(seq, type, payload, runId = 'run-one') {
  return {
    seq,
    run_id: runId,
    task_id: 'task-one',
    type,
    occurred_at: '2026-07-17T10:00:00.000Z',
    payload,
  }
}

describe('analysis progress event model', () => {
  it('consumes stage.progress without synthesizing pipeline values', () => {
    const next = reduceAnalysisEvent(createEmptyAnalysisProgress(), event(1, 'stage.progress', {
      stage: 'coarse_ocr',
      stage_label: '真实 OCR',
      overall_progress: 38,
      stage_progress: 24.5,
      processed: 44,
      total: 180,
      message: '正在识别采样帧',
    }))

    expect(next).toMatchObject({
      runId: 'run-one',
      lastSeq: 1,
      stage: 'coarse_ocr',
      stageLabel: '真实 OCR',
      overallProgress: 38,
      stageProgress: 24.5,
      processed: 44,
      total: 180,
      message: '正在识别采样帧',
    })
  })

  it('consumes a complete frame.analyzed payload and ignores duplicate run + seq', () => {
    const frameEvent = event(2, 'frame.analyzed', {
      stage: 'coarse_ocr',
      frame_index: 923,
      pts: 46150,
      time_base_num: 1,
      time_base_den: 30000,
      media_time: 1.538,
      processed: 44,
      total: 180,
      detected_cue_count: 12,
      preview_id: 'preview-full',
      roi_preview_id: 'preview-roi',
      video_width: 1920,
      video_height: 1080,
      coordinate_space: 'video',
      roi: { x: 0.08, y: 0.52, width: 0.84, height: 0.24 },
      candidates: [{
        text: 'PROTECT YOURSELF',
        confidence: 0.98,
        position: [10, 20, 300, 70],
        coordinate_space: 'video',
      }],
    })
    const next = reduceAnalysisEvent(createEmptyAnalysisProgress(), frameEvent)

    expect(next.frame).toMatchObject({
      frameIndex: 923,
      pts: 46150,
      mediaTime: 1.538,
      previewId: 'preview-full',
      roiPreviewId: 'preview-roi',
      frameWidth: 1920,
      frameHeight: 1080,
    })
    expect(next.frame.candidates[0]).toMatchObject({
      text: 'PROTECT YOURSELF',
      confidence: 0.98,
      coordinateSpace: 'video',
    })
    expect(next.thumbnails).toHaveLength(1)
    expect(reduceAnalysisEvent(next, frameEvent)).toBe(next)
  })

  it('keeps only five thumbnails and resets all old-run visual state on a new run_id', () => {
    let state = createEmptyAnalysisProgress()
    for (let seq = 1; seq <= 8; seq += 1) {
      state = reduceAnalysisEvent(state, event(seq, 'frame.analyzed', {
        frame_index: seq,
        preview_id: `preview-${seq}`,
        video_width: 1280,
        video_height: 720,
        candidates: [],
      }))
    }

    expect(state.thumbnails).toHaveLength(MAX_PROGRESS_THUMBNAILS)
    expect(state.thumbnails.map((item) => item.previewId)).toEqual([
      'preview-4', 'preview-5', 'preview-6', 'preview-7', 'preview-8',
    ])

    const restarted = reduceAnalysisEvent(state, event(1, 'stage.progress', {
      stage: 'probing',
      overall_progress: 1,
      processed: 0,
      total: 20,
    }, 'run-two'))
    expect(restarted).toMatchObject({ runId: 'run-two', lastSeq: 1, overallProgress: 1 })
    expect(restarted.frame).toBeNull()
    expect(restarted.thumbnails).toEqual([])
  })

  it('hydrates the latest frame and preview IDs from the lightweight task snapshot', () => {
    const latestEvent = event(12, 'frame.analyzed', {
      frame_index: 400,
      media_time: 8,
      preview_id: 'snapshot-frame',
      roi_preview_id: 'snapshot-roi',
      video_width: 1920,
      video_height: 1080,
      processed: 9,
      total: 100,
      candidates: [{ text: 'restored', confidence: 0.9, position: [10, 10, 80, 40] }],
    }, 'snapshot-run')
    const task = {
      status: 'processing',
      progress: 9,
      progress_snapshot: {
        run_id: 'snapshot-run',
        latest_seq: 12,
        latest_event: latestEvent,
      },
    }

    const restored = hydrateAnalysisSnapshot(createEmptyAnalysisProgress(), task)
    expect(restored).toMatchObject({ runId: 'snapshot-run', lastSeq: 12, overallProgress: 9 })
    expect(restored.frame).toMatchObject({
      frameIndex: 400,
      previewId: 'snapshot-frame',
      roiPreviewId: 'snapshot-roi',
    })
    expect(restored.thumbnails).toHaveLength(1)
  })

  it('restores an earlier latest_frame_event before a newer stage latest_event', () => {
    const task = {
      status: 'processing',
      progress: 51,
      subtitle_count: 0,
      progress_snapshot: {
        run_id: 'snapshot-run',
        latest_seq: 22,
        latest_preview_event: event(19, 'frame.analyzed', {
          frame_index: 590,
          preview_id: 'last-visible-frame',
          roi_preview_id: 'last-visible-roi',
          video_width: 1280,
          video_height: 720,
          detected_cue_count: 7,
          candidates: [{ text: 'matches pixels', confidence: 0.8, position: [1, 2, 3, 4] }],
        }, 'snapshot-run'),
        latest_frame_event: event(20, 'frame.analyzed', {
          frame_index: 600,
          video_width: 1280,
          video_height: 720,
          detected_cue_count: 7,
          candidates: [],
        }, 'snapshot-run'),
        latest_event: event(22, 'stage.progress', {
          stage: 'event_aggregation',
          stage_label: '正在聚合字幕事件',
          overall_progress: 51,
          processed: 18,
          total: 30,
        }, 'snapshot-run'),
      },
    }

    const restored = hydrateAnalysisSnapshot(createEmptyAnalysisProgress(), task)
    expect(restored).toMatchObject({
      runId: 'snapshot-run',
      lastSeq: 22,
      stage: 'event_aggregation',
      overallProgress: 51,
    })
    expect(restored.frame).toMatchObject({
      frameIndex: 600,
      previewId: '',
    })
    expect(restored.previewFrame).toMatchObject({
      frameIndex: 590,
      previewId: 'last-visible-frame',
      roiPreviewId: 'last-visible-roi',
    })
    expect(restored.detectedCueCount).toBe(7)
  })

  it('does not replay older frame snapshots after live events reach the same cursor', () => {
    let current = reduceAnalysisEvent(createEmptyAnalysisProgress(), event(20, 'frame.analyzed', {
      stage: 'coarse_ocr',
      frame_index: 600,
      preview_id: 'live-frame',
      roi_preview_id: 'live-roi',
      video_width: 1280,
      video_height: 720,
      processed: 12,
      total: 30,
      detected_cue_count: 7,
      candidates: [{ text: 'live pixels', confidence: 0.95, position: [1, 2, 3, 4] }],
    }, 'snapshot-run'))
    current = reduceAnalysisEvent(current, event(22, 'stage.progress', {
      stage: 'event_aggregation',
      stage_label: '正在聚合字幕事件',
      overall_progress: 51,
      processed: 18,
      total: 30,
      detected_cue_count: 8,
    }, 'snapshot-run'))
    const liveFrame = current.frame
    const livePreview = current.previewFrame
    const liveThumbnails = current.thumbnails
    const task = {
      status: 'failed',
      error: 'worker stopped after the latest event',
      progress: 20,
      progress_snapshot: {
        run_id: 'snapshot-run',
        latest_seq: 22,
        latest_preview_event: event(19, 'frame.analyzed', {
          stage: 'coarse_ocr',
          frame_index: 590,
          preview_id: 'older-preview',
          processed: 11,
          detected_cue_count: 6,
        }, 'snapshot-run'),
        latest_frame_event: event(20, 'frame.analyzed', {
          stage: 'coarse_ocr',
          frame_index: 600,
          preview_id: 'persisted-frame',
          processed: 12,
          detected_cue_count: 7,
        }, 'snapshot-run'),
        latest_event: event(22, 'stage.progress', {
          stage: 'event_aggregation',
          overall_progress: 51,
          processed: 18,
          total: 30,
        }, 'snapshot-run'),
      },
    }

    const restored = hydrateAnalysisSnapshot(current, task)

    expect(restored).toMatchObject({
      runId: 'snapshot-run',
      lastSeq: 22,
      stage: 'event_aggregation',
      stageLabel: '正在聚合字幕事件',
      overallProgress: 51,
      processed: 18,
      total: 30,
      detectedCueCount: 8,
      terminal: 'failed',
      failureMessage: 'worker stopped after the latest event',
    })
    expect(restored.frame).toBe(liveFrame)
    expect(restored.previewFrame).toBe(livePreview)
    expect(restored.thumbnails).toBe(liveThumbnails)
    expect(restored.previewFrame.previewId).toBe('live-frame')
  })

  it('handles cue count and terminal events without retaining cue history', () => {
    let state = reduceAnalysisEvent(createEmptyAnalysisProgress(), event(1, 'cue.upserted', {
      detected_cue_count: 7,
    }))
    expect(state.detectedCueCount).toBe(7)
    expect(state).not.toHaveProperty('cues')

    state = reduceAnalysisEvent(state, event(2, 'job.completed', {
      message: 'done',
      subtitle_count: 3,
    }))
    expect(state).toMatchObject({ terminal: 'completed', overallProgress: 100, detectedCueCount: 3 })

    const failed = reduceAnalysisEvent(createEmptyAnalysisProgress(), event(1, 'job.failed', {
      error: 'OCR crashed',
    }, 'failed-run'))
    expect(failed).toMatchObject({ terminal: 'failed', failureMessage: 'OCR crashed' })
  })
})
