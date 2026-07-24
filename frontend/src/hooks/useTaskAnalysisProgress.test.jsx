import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import useTaskAnalysisProgress, { ANALYSIS_RETRY_DELAYS } from './useTaskAnalysisProgress'

const streamTaskEvents = vi.hoisted(() => vi.fn())

vi.mock('../api/tasks', () => ({
  streamTaskEvents,
}))

function untilAborted(signal) {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  })
}

function snapshotTask() {
  return {
    taskId: 'task-one',
    status: 'processing',
    progress: 20,
    progress_snapshot: {
      run_id: 'run-one',
      latest_seq: 3,
      latest_event: {
        seq: 3,
        run_id: 'run-one',
        type: 'stage.progress',
        payload: { stage: 'coarse_ocr', overall_progress: 20, processed: 2, total: 10 },
      },
    },
  }
}

beforeEach(() => {
  vi.useRealTimers()
  streamTaskEvents.mockReset()
})

describe('useTaskAnalysisProgress connection recovery', () => {
  it('does not open the visual event stream for an audio-only task', async () => {
    const task = {
      ...snapshotTask(),
      analysis_mode: 'audio',
      progress_snapshot: undefined,
    }
    const view = renderHook(() => useTaskAnalysisProgress('task-one', task))

    await act(async () => {
      await Promise.resolve()
    })

    expect(streamTaskEvents).not.toHaveBeenCalled()
    expect(view.result.current.connection.status).toBe('idle')
    view.unmount()
  })

  it('starts after snapshot hydration, reconnects from the accepted cursor, and reports recovery', async () => {
    let calls = 0
    streamTaskEvents.mockImplementation(async (_taskId, options) => {
      calls += 1
      options.onOpen()
      if (calls === 1) throw new Error('network dropped')
      return untilAborted(options.signal)
    })
    const onTerminal = vi.fn()
    const view = renderHook(() => useTaskAnalysisProgress('task-one', snapshotTask(), onTerminal))

    await waitFor(() => expect(view.result.current.connection.status).toBe('reconnecting'))
    expect(streamTaskEvents.mock.calls[0][1]).toMatchObject({
      afterSeq: 3,
      lastEventId: 'run-one:3',
    })
    await waitFor(() => expect(view.result.current.connection.status).toBe('recovered'), { timeout: 1500 })
    expect(streamTaskEvents).toHaveBeenCalledTimes(2)
    expect(view.result.current.progress).toMatchObject({
      runId: 'run-one',
      lastSeq: 3,
      overallProgress: 20,
    })
    view.unmount()
  })

  it('stops the stream and refreshes the task snapshot on a terminal event', async () => {
    streamTaskEvents.mockImplementation(async (_taskId, options) => {
      options.onOpen()
      options.onEvent({
        seq: 4,
        run_id: 'run-one',
        type: 'job.completed',
        payload: { message: 'done' },
      })
      return untilAborted(options.signal)
    })
    const onTerminal = vi.fn()
    const view = renderHook(() => useTaskAnalysisProgress('task-one', snapshotTask(), onTerminal))

    await waitFor(() => expect(view.result.current.progress.terminal).toBe('completed'))
    expect(view.result.current.progress).toMatchObject({ lastSeq: 4, overallProgress: 100 })
    await waitFor(() => expect(view.result.current.connection.status).toBe('completed'))
    expect(onTerminal).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('resets the retry budget after each connection advances the event cursor', async () => {
    vi.useFakeTimers()
    let calls = 0
    streamTaskEvents.mockImplementation(async (_taskId, options) => {
      calls += 1
      options.onOpen()
      options.onEvent({
        seq: 3 + calls,
        run_id: 'run-one',
        type: 'stage.progress',
        payload: { stage: 'coarse_ocr', overall_progress: 20 + calls },
      })
      if (calls >= 7) return untilAborted(options.signal)
      return undefined
    })
    const view = renderHook(() => useTaskAnalysisProgress('task-one', snapshotTask()))

    await act(async () => {
      await Promise.resolve()
    })
    expect(streamTaskEvents).toHaveBeenCalledTimes(1)
    for (let expectedCalls = 2; expectedCalls <= 7; expectedCalls += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ANALYSIS_RETRY_DELAYS[0])
      })
      expect(streamTaskEvents).toHaveBeenCalledTimes(expectedCalls)
    }

    expect(view.result.current.progress.lastSeq).toBe(10)
    expect(view.result.current.connection).toMatchObject({ status: 'recovered', attempts: 0 })
    view.unmount()
  })

  it('exhausts the bounded retry budget when reopened connections make no progress', async () => {
    vi.useFakeTimers()
    streamTaskEvents.mockImplementation(async (_taskId, options) => {
      options.onOpen()
      return undefined
    })
    const view = renderHook(() => useTaskAnalysisProgress('task-one', snapshotTask()))

    await act(async () => {
      await Promise.resolve()
    })
    expect(streamTaskEvents).toHaveBeenCalledTimes(1)
    for (const delay of ANALYSIS_RETRY_DELAYS) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay)
      })
    }

    expect(streamTaskEvents).toHaveBeenCalledTimes(ANALYSIS_RETRY_DELAYS.length + 1)
    expect(view.result.current.connection).toMatchObject({
      status: 'offline',
      attempts: ANALYSIS_RETRY_DELAYS.length,
    })
    view.unmount()
  })
})
