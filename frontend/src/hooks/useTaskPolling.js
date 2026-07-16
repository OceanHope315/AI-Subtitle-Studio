import { useCallback, useEffect, useRef, useState } from 'react'
import { getTask } from '../api/tasks'

const ACTIVE_STATES = new Set(['queued', 'processing'])
const POLL_INTERVAL = 1400

function unwrapTask(payload) {
  return payload?.task || payload?.data || payload
}

export default function useTaskPolling(taskId) {
  const [task, setTask] = useState(null)
  const [loadedTaskId, setLoadedTaskId] = useState('')
  const [error, setError] = useState(null)
  const [errorTaskId, setErrorTaskId] = useState('')
  const refreshSequence = useRef(0)
  const [refreshToken, setRefreshToken] = useState(0)

  const refresh = useCallback(() => {
    refreshSequence.current += 1
    setRefreshToken(refreshSequence.current)
  }, [])

  useEffect(() => {
    if (!taskId) return undefined

    let stopped = false
    let timer = null
    let controller = null

    const poll = async () => {
      controller = new AbortController()
      try {
        const payload = await getTask(taskId, controller.signal)
        if (stopped) return
        const nextTask = unwrapTask(payload)
        setTask(nextTask)
        setLoadedTaskId(taskId)
        setError(null)
        setErrorTaskId('')

        if (ACTIVE_STATES.has(nextTask?.status)) {
          timer = window.setTimeout(poll, POLL_INTERVAL)
        }
      } catch (requestError) {
        if (stopped || requestError.name === 'AbortError') return
        setError(requestError)
        setErrorTaskId(taskId)
        timer = window.setTimeout(poll, POLL_INTERVAL * 2)
      }
    }

    poll()

    return () => {
      stopped = true
      window.clearTimeout(timer)
      controller?.abort()
    }
  }, [taskId, refreshToken])

  const taskMatches = loadedTaskId === taskId
  const errorMatches = errorTaskId === taskId
  return {
    task: taskMatches ? task : null,
    loading: Boolean(taskId && !taskMatches && !errorMatches),
    error: errorMatches ? error : null,
    refresh,
  }
}
