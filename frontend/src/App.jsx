import { useCallback, useEffect, useState } from 'react'
import {
  downloadSrt,
  getSubtitles,
  getVideoUrl,
  saveSubtitles,
  startTaskRecognition,
  uploadVideo,
} from './api/tasks'
import AppHeader from './components/AppHeader'
import ProcessingPanel from './components/ProcessingPanel'
import RoiSelectionPanel from './components/RoiSelectionPanel'
import TaskNotFound from './components/TaskNotFound'
import Toast from './components/Toast'
import UploadPanel from './components/UploadPanel'
import useTaskPolling from './hooks/useTaskPolling'
import EditorPage from './pages/EditorPage'
import {
  makeClientId,
  normalizeSubtitles,
  toApiSubtitles,
  validateSubtitles,
} from './utils/subtitles'

function initialTaskId() {
  return new URLSearchParams(window.location.search).get('task') || ''
}

function resolveTaskId(payload) {
  const task = payload?.task || payload?.data || payload
  return task?.taskId || task?.id || task?._id || payload?.taskId || ''
}

function replaceTaskInUrl(taskId) {
  const url = new URL(window.location.href)
  if (taskId) url.searchParams.set('task', taskId)
  else url.searchParams.delete('task')
  window.history.replaceState({}, '', url)
}

export default function App() {
  const [taskId, setTaskId] = useState(initialTaskId)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadError, setUploadError] = useState('')
  const [recognitionStarting, setRecognitionStarting] = useState(false)
  const [recognitionError, setRecognitionError] = useState('')
  const [subtitles, setSubtitles] = useState([])
  const [subtitlesLoading, setSubtitlesLoading] = useState(false)
  const [subtitlesError, setSubtitlesError] = useState(null)
  const [subtitleReload, setSubtitleReload] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [notice, setNotice] = useState(null)
  const { task, loading: taskLoading, error: taskError, refresh } = useTaskPolling(taskId)

  const dismissNotice = useCallback(() => setNotice(null), [])
  const notify = useCallback((message, type = 'success') => {
    setNotice({ message, type, id: Date.now() })
  }, [])

  useEffect(() => {
    if (!dirty) return undefined
    const warnBeforeLeaving = (event) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeLeaving)
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving)
  }, [dirty])

  useEffect(() => {
    if (!taskId || task?.status !== 'completed') return undefined

    const controller = new AbortController()
    const startTimer = window.setTimeout(() => {
      setSubtitlesLoading(true)
      setSubtitlesError(null)

      getSubtitles(taskId, controller.signal)
        .then((result) => {
          setSubtitles(normalizeSubtitles(result))
          setDirty(false)
        })
        .catch((error) => {
          if (error.name === 'AbortError') return
          const embedded = task?.subtitles
          if (Array.isArray(embedded)) {
            setSubtitles(normalizeSubtitles(embedded))
            setDirty(false)
            return
          }
          setSubtitlesError(error)
        })
        .finally(() => {
          if (!controller.signal.aborted) setSubtitlesLoading(false)
        })
    }, 0)

    return () => {
      window.clearTimeout(startTimer)
      controller.abort()
    }
  }, [taskId, task, subtitleReload])

  const startTask = (nextTaskId) => {
    setSubtitles([])
    setSubtitlesError(null)
    setDirty(false)
    setRecognitionStarting(false)
    setRecognitionError('')
    setTaskId(nextTaskId)
    replaceTaskInUrl(nextTaskId)
  }

  const handleUpload = async (file, validationError = '') => {
    if (!file) {
      setUploadError(validationError || '请选择一个 MP4 视频。')
      return
    }

    setUploading(true)
    setUploadProgress(0)
    setUploadError('')
    try {
      const payload = await uploadVideo(file, setUploadProgress)
      const nextTaskId = resolveTaskId(payload)
      if (!nextTaskId) throw new Error('后端未返回有效的任务编号。')
      setUploadProgress(100)
      startTask(nextTaskId)
    } catch (error) {
      setUploadError(error.message || '上传失败，请稍后重试。')
    } finally {
      setUploading(false)
    }
  }

  const handleNewTask = () => {
    if (dirty && !window.confirm('当前有未保存的字幕修改，确定返回上传页吗？')) return
    startTask('')
    setUploadError('')
    setUploadProgress(0)
  }

  const handleStartRecognition = async (roi) => {
    setRecognitionStarting(true)
    setRecognitionError('')
    try {
      await startTaskRecognition(taskId, roi)
      notify('字幕区域已确认，识别任务已启动')
      refresh()
    } catch (error) {
      if (error?.status === 409) {
        // The first request may have reached the server even when its response
        // was lost. A conflict therefore means that the task has already left
        // awaiting_roi; refresh instead of trapping the user on the ROI page.
        notify('任务已启动，正在恢复最新处理状态')
      } else {
        setRecognitionError(error.message || '识别任务启动失败，请稍后重试。')
        setRecognitionStarting(false)
      }
      // Refresh on every failure as well: for network errors it is ambiguous
      // whether the POST was accepted before the connection was interrupted.
      refresh()
    }
  }

  const handleSubtitleChange = (clientId, patch) => {
    setSubtitles((current) => current.map((subtitle) => (
      subtitle._clientId === clientId ? { ...subtitle, ...patch } : subtitle
    )))
    setDirty(true)
  }

  const handleSubtitleDelete = (clientId) => {
    setSubtitles((current) => current.filter((subtitle) => subtitle._clientId !== clientId))
    setDirty(true)
  }

  const handleSubtitleAdd = (currentTime, duration) => {
    const clientId = makeClientId()
    const start = Math.max(0, Number(currentTime) || 0)
    let end = start + 2
    if (duration > start) end = Math.min(duration, end)
    if (end <= start) end = start + 2
    const nextSubtitle = {
      _clientId: clientId,
      text: '新字幕',
      start_time: Number(start.toFixed(3)),
      end_time: Number(end.toFixed(3)),
      confidence: 1,
    }
    setSubtitles((current) => [...current, nextSubtitle].sort((a, b) => a.start_time - b.start_time))
    setDirty(true)
    return clientId
  }

  const persistSubtitles = async (showSuccess = true) => {
    const validationError = validateSubtitles(subtitles)
    if (validationError) {
      notify(validationError, 'error')
      return false
    }

    setSaving(true)
    try {
      const payload = toApiSubtitles(subtitles)
      const saved = await saveSubtitles(taskId, payload)
      setSubtitles(normalizeSubtitles(saved))
      setDirty(false)
      if (showSuccess) notify('字幕已保存')
      return true
    } catch (error) {
      notify(error.message || '字幕保存失败。', 'error')
      return false
    } finally {
      setSaving(false)
    }
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      if (dirty) {
        const saved = await persistSubtitles(false)
        if (!saved) return
      }
      const baseName = (task?.filename || 'final').replace(/\.mp4$/i, '')
      await downloadSrt(taskId, `${baseName}.srt`)
      notify('SRT 字幕已导出')
    } catch (error) {
      notify(error.message || 'SRT 导出失败。', 'error')
    } finally {
      setExporting(false)
    }
  }

  const editorReady = Boolean(taskId && task?.status === 'completed')
  const awaitingRoi = Boolean(taskId && task?.status === 'awaiting_roi')
  const unrecoverableTaskError = Boolean(taskId && taskError && !task && !taskLoading)

  return (
    <div className="app-shell">
      <AppHeader
        editor={editorReady}
        task={task}
        dirty={dirty}
        saving={saving}
        exporting={exporting}
        onSave={() => persistSubtitles(true)}
        onExport={handleExport}
        onNewTask={handleNewTask}
      />

      {!taskId && (
        <UploadPanel
          uploading={uploading}
          uploadProgress={uploadProgress}
          error={uploadError}
          onUpload={handleUpload}
        />
      )}

      {taskId && unrecoverableTaskError && (
        <TaskNotFound error={taskError} onRetry={refresh} onNewTask={handleNewTask} />
      )}

      {awaitingRoi && !unrecoverableTaskError && (
        <RoiSelectionPanel
          key={taskId}
          task={task}
          videoUrl={getVideoUrl(taskId)}
          submitting={recognitionStarting}
          error={recognitionError}
          onConfirm={handleStartRecognition}
          onNewTask={handleNewTask}
        />
      )}

      {taskId && !unrecoverableTaskError && !editorReady && !awaitingRoi && (
        <ProcessingPanel
          task={task}
          loading={taskLoading}
          pollingError={taskError}
          onRetry={refresh}
          onNewTask={handleNewTask}
        />
      )}

      {editorReady && (
        <EditorPage
          task={task}
          subtitles={subtitles}
          subtitlesLoading={subtitlesLoading}
          subtitlesError={subtitlesError}
          onSubtitleChange={handleSubtitleChange}
          onSubtitleDelete={handleSubtitleDelete}
          onSubtitleAdd={handleSubtitleAdd}
          onRetrySubtitles={() => setSubtitleReload((value) => value + 1)}
          onVideoError={() => notify('视频加载失败，请确认后端视频接口可访问。', 'error')}
        />
      )}

      {notice && (
        <Toast key={notice.id} message={notice.message} type={notice.type} onDismiss={dismissNotice} />
      )}
    </div>
  )
}
