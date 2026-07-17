import { useCallback, useEffect, useRef, useState } from 'react'
import { streamTaskEvents } from '../api/tasks'
import {
  createEmptyAnalysisProgress,
  getAnalysisSnapshot,
  hydrateAnalysisSnapshot,
  reduceAnalysisEvent,
} from '../utils/analysisProgress'

export const ANALYSIS_RETRY_DELAYS = [600, 1200, 2400, 4800, 8000]
const ACTIVE_TASK_STATUSES = new Set(['queued', 'processing'])

function initialConnection() {
  return { status: 'idle', attempts: 0, retryIn: 0, error: '' }
}

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, milliseconds)
    const abort = () => {
      window.clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

export default function useTaskAnalysisProgress(taskId, task, onTerminal) {
  const [progress, setProgress] = useState(() => ({
    ...createEmptyAnalysisProgress(),
    _taskId: taskId,
  }))
  const [connection, setConnection] = useState(initialConnection)
  const [retryToken, setRetryToken] = useState(0)
  const progressRef = useRef(progress)
  const terminalRef = useRef(false)
  const terminalNotifiedRef = useRef('')
  const onTerminalRef = useRef(onTerminal)

  useEffect(() => {
    onTerminalRef.current = onTerminal
  }, [onTerminal])

  const replaceProgress = useCallback((next) => {
    const owned = { ...next, _taskId: taskId }
    progressRef.current = owned
    terminalRef.current = Boolean(owned.terminal)
    setProgress(owned)
    return owned
  }, [taskId])

  const acceptEvent = useCallback((event) => {
    const next = reduceAnalysisEvent(progressRef.current, event)
    if (next === progressRef.current) return next
    replaceProgress(next)

    if (next.terminal) {
      const terminalKey = `${next.runId}:${next.lastSeq}:${next.terminal}`
      if (terminalNotifiedRef.current !== terminalKey) {
        terminalNotifiedRef.current = terminalKey
        onTerminalRef.current?.()
      }
    }
    return next
  }, [replaceProgress])

  useEffect(() => {
    if (!taskId || !task) return
    let base = progressRef.current
    if (base._taskId !== taskId) {
      terminalNotifiedRef.current = ''
      terminalRef.current = false
      base = createEmptyAnalysisProgress()
    }
    const next = hydrateAnalysisSnapshot(base, task)
    if (next !== progressRef.current) replaceProgress(next)
  }, [replaceProgress, task, taskId])

  const taskStatus = task?.status
  useEffect(() => {
    if (!taskId || !ACTIVE_TASK_STATUSES.has(taskStatus)) return undefined

    let stopped = false
    let controller = null

    const connect = async () => {
      let failures = 0
      let hasDisconnected = false

      while (!stopped && !terminalRef.current) {
        controller = new AbortController()
        let connectionMadeProgress = false
        const cursor = progressRef.current
        const afterSeq = cursor.lastSeq || 0
        const lastEventId = cursor.runId && cursor.lastSeq
          ? `${cursor.runId}:${cursor.lastSeq}`
          : ''
        setConnection({
          status: hasDisconnected ? 'reconnecting' : 'connecting',
          attempts: failures,
          retryIn: 0,
          error: '',
        })

        try {
          await streamTaskEvents(taskId, {
            afterSeq,
            lastEventId,
            signal: controller.signal,
            onOpen: () => {
              if (stopped) return
              setConnection({
                status: hasDisconnected || afterSeq > 0 ? 'recovered' : 'live',
                attempts: failures,
                retryIn: 0,
                error: '',
              })
            },
            onEvent: (event) => {
              if (stopped) return
              const previous = progressRef.current
              const next = acceptEvent(event)
              const cursorAdvanced = next.runId !== previous.runId
                || next.lastSeq > previous.lastSeq
              if (cursorAdvanced && !connectionMadeProgress) {
                connectionMadeProgress = true
                const recoveredFromFailures = failures > 0
                failures = 0
                if (recoveredFromFailures) {
                  setConnection((current) => ({
                    ...current,
                    attempts: 0,
                    retryIn: 0,
                    error: '',
                  }))
                }
              }
              if (next.terminal) controller?.abort()
            },
          })
          if (terminalRef.current || stopped) break
          throw new Error('实时分析连接已关闭。')
        } catch (error) {
          if (stopped || (error.name === 'AbortError' && terminalRef.current)) break
          if (error.name === 'AbortError') break

          hasDisconnected = true
          if (failures >= ANALYSIS_RETRY_DELAYS.length) {
            setConnection({
              status: 'offline',
              attempts: failures,
              retryIn: 0,
              error: error.message || '实时连接暂时不可用。',
            })
            break
          }

          const retryIn = ANALYSIS_RETRY_DELAYS[failures]
          failures += 1
          setConnection({
            status: 'reconnecting',
            attempts: failures,
            retryIn,
            error: error.message || '实时连接暂时中断。',
          })
          try {
            await abortableDelay(retryIn, controller.signal)
          } catch (delayError) {
            if (delayError.name === 'AbortError') break
            throw delayError
          }
        }
      }

      if (terminalRef.current && !stopped) {
        setConnection({
          status: progressRef.current.terminal,
          attempts: 0,
          retryIn: 0,
          error: '',
        })
      }
    }

    connect()
    return () => {
      stopped = true
      controller?.abort()
    }
  }, [acceptEvent, retryToken, taskId, taskStatus])

  const retry = useCallback(() => {
    terminalRef.current = false
    setRetryToken((value) => value + 1)
  }, [])

  const snapshot = getAnalysisSnapshot(task)
  const visibleProgress = progress._taskId === taskId
    ? progress
    : createEmptyAnalysisProgress()
  let visibleConnection = connection
  if (taskStatus === 'completed') visibleConnection = { ...initialConnection(), status: 'completed' }
  else if (taskStatus === 'failed') visibleConnection = { ...initialConnection(), status: 'failed' }
  return {
    progress: visibleProgress,
    connection: visibleConnection,
    retry,
    snapshotRestored: Boolean(
      snapshot?.latestSeq || snapshot?.latestEvent || snapshot?.latestFrameEvent,
    ),
  }
}
