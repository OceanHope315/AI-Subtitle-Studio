import { useCallback, useEffect, useRef, useState } from 'react'
import { useBlocker, useNavigate, useParams } from 'react-router-dom'
import {
  downloadSrt,
  estimateTaskRoi,
  getSubtitles,
  getVideoUrl,
  saveSubtitles,
  startTaskRecognition,
} from '../api/tasks'
import AppHeader from '../components/AppHeader'
import AutoROIPreview from '../components/AutoROIPreview'
import ProcessingPanel from '../components/ProcessingPanel'
import RoiSelectionPanel from '../components/RoiSelectionPanel'
import { DraftRecoveryDialog, LeaveSafetyDialog } from '../components/SafetyDialogs'
import TaskNotFound from '../components/TaskNotFound'
import Toast from '../components/Toast'
import useTaskAnalysisProgress from '../hooks/useTaskAnalysisProgress'
import useTaskPolling from '../hooks/useTaskPolling'
import EditorPage from './EditorPage'
import { deleteSubtitleDraft, getSubtitleDraft, saveSubtitleDraft } from '../utils/draftStore'
import { isValidRoi, roundRoi } from '../utils/roi'
import {
  makeClientId,
  normalizeSubtitles,
  toApiSubtitles,
  validateSubtitles,
} from '../utils/subtitles'

export default function TaskWorkspace() {
  const { taskId } = useParams()
  const navigate = useNavigate()
  const [recognitionStarting, setRecognitionStarting] = useState(false)
  const [recognitionError, setRecognitionError] = useState('')
  const [roiStateTaskId, setRoiStateTaskId] = useState(taskId)
  const [roiStage, setRoiStage] = useState('estimating')
  const [predictedRoi, setPredictedRoi] = useState(null)
  const [autoRoiNotice, setAutoRoiNotice] = useState('')
  const [subtitles, setSubtitles] = useState([])
  const [subtitlesLoading, setSubtitlesLoading] = useState(false)
  const [subtitlesError, setSubtitlesError] = useState(null)
  const [subtitleReload, setSubtitleReload] = useState(0)
  const [revision, setRevision] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [saveStatus, setSaveStatus] = useState('synced')
  const [exporting, setExporting] = useState(false)
  const [pendingDraft, setPendingDraft] = useState(null)
  const [notice, setNotice] = useState(null)
  const [editVersion, setEditVersion] = useState(0)
  const [autosaveKick, setAutosaveKick] = useState(0)
  const subtitlesRef = useRef(subtitles)
  const revisionRef = useRef(revision)
  const dirtyRef = useRef(dirty)
  const editVersionRef = useRef(editVersion)
  const saveInFlightRef = useRef(null)
  const autoRoiAbortRef = useRef(null)
  const { task, loading: taskLoading, error: taskError, refresh } = useTaskPolling(taskId)
  const analysis = useTaskAnalysisProgress(taskId, task, refresh)
  const blocker = useBlocker(dirty)

  const dismissNotice = useCallback(() => setNotice(null), [])
  const notify = useCallback((message, type = 'success') => {
    setNotice({ message, type, id: Date.now() })
  }, [])

  useEffect(() => {
    if (!taskId || task?.status !== 'awaiting_roi') return undefined
    const controller = new AbortController()
    autoRoiAbortRef.current = controller
    const startTimer = window.setTimeout(() => {
      if (controller.signal.aborted) return
      setRoiStateTaskId(taskId)
      setRoiStage('estimating')
      setPredictedRoi(null)
      setAutoRoiNotice('')
      setRecognitionError('')

      estimateTaskRoi(taskId, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return
          if (result?.success === true && isValidRoi(result.roi)) {
            setPredictedRoi(roundRoi(result.roi))
            setRoiStage('preview')
            return
          }
          setRoiStage('manual')
          setAutoRoiNotice('未检测到稳定的字幕区域，已切换为人工选择。')
        })
        .catch((error) => {
          if (controller.signal.aborted || error?.name === 'AbortError') return
          if (error?.status === 409) {
            refresh()
            return
          }
          setRoiStage('manual')
          setAutoRoiNotice('自动字幕区域估计暂不可用，已切换为人工选择。')
        })
    }, 0)

    return () => {
      window.clearTimeout(startTimer)
      controller.abort()
      if (autoRoiAbortRef.current === controller) autoRoiAbortRef.current = null
    }
  }, [refresh, task?.status, taskId])

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
      Promise.all([
        getSubtitles(taskId, controller.signal),
        getSubtitleDraft(taskId).catch(() => null),
      ])
      .then(([result, draft]) => {
        if (controller.signal.aborted) return
        const serverSubtitles = Array.isArray(result) ? result : result.subtitles
        const serverRevision = Number(Array.isArray(result) ? task.revision : result.revision) || 0
        const normalized = normalizeSubtitles(serverSubtitles)
        setSubtitles(normalized)
        subtitlesRef.current = normalized
        setRevision(serverRevision)
        revisionRef.current = serverRevision
        setDirty(false)
        dirtyRef.current = false
        setSaveStatus('synced')
        if (draft?.subtitles) setPendingDraft(draft)
      })
      .catch((error) => {
        if (error.name === 'AbortError') return
        const embedded = task?.subtitles
        if (Array.isArray(embedded)) {
          setSubtitles(normalizeSubtitles(embedded))
          setRevision(Number(task.revision) || 0)
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
  }, [task?.revision, task?.status, task?.subtitles, taskId, subtitleReload])

  const markEdited = useCallback(() => {
    setDirty(true)
    dirtyRef.current = true
    setSaveStatus((current) => (current === 'conflict' ? current : 'dirty'))
    setEditVersion((value) => {
      editVersionRef.current = value + 1
      return value + 1
    })
  }, [])

  const persistSubtitles = useCallback(async (showSuccess = true) => {
    if (saveInFlightRef.current) await saveInFlightRef.current.catch(() => {})
    if (!dirtyRef.current) return true
    const snapshot = subtitlesRef.current
    const snapshotVersion = editVersionRef.current
    const validationError = validateSubtitles(snapshot)
    if (validationError) {
      notify(validationError, 'error')
      return false
    }

    const operation = (async () => {
      setSaveStatus('saving')
      try {
        const result = await saveSubtitles(taskId, toApiSubtitles(snapshot), revisionRef.current)
        revisionRef.current = result.revision
        setRevision(result.revision)
        if (editVersionRef.current === snapshotVersion) {
          const normalized = normalizeSubtitles(result.subtitles)
          subtitlesRef.current = normalized
          setSubtitles(normalized)
          dirtyRef.current = false
          setDirty(false)
          setSaveStatus('synced')
          await deleteSubtitleDraft(taskId).catch(() => {})
        } else {
          setSaveStatus('dirty')
          setAutosaveKick((value) => value + 1)
        }
        if (showSuccess) notify('字幕修改已同步')
        return true
      } catch (error) {
        let draftSaved = false
        try {
          await saveSubtitleDraft(taskId, subtitlesRef.current, revisionRef.current)
          draftSaved = true
        } catch (draftError) {
          notify(`字幕保存失败，且本地草稿无法写入：${draftError.message}`, 'error')
        }
        if (error?.status === 409) {
          setSaveStatus('conflict')
          notify('检测到其他标签页的新版本；本地修改已保留为冲突草稿。', 'error')
        } else {
          setSaveStatus('offline')
          if (draftSaved) notify('网络保存失败，字幕已安全保存为离线草稿。', 'error')
        }
        return draftSaved
      }
    })()
    saveInFlightRef.current = operation
    try {
      return await operation
    } finally {
      if (saveInFlightRef.current === operation) saveInFlightRef.current = null
    }
  }, [notify, taskId])

  useEffect(() => {
    if (!dirty || subtitlesLoading || saveStatus === 'conflict') return undefined
    const timer = window.setTimeout(() => persistSubtitles(false), 750)
    return () => window.clearTimeout(timer)
  }, [autosaveKick, dirty, persistSubtitles, saveStatus, subtitles, subtitlesLoading])

  const handleStartRecognition = async (roi) => {
    setRecognitionStarting(true)
    setRecognitionError('')
    try {
      await startTaskRecognition(taskId, roi)
      notify('字幕区域已确认，识别任务已启动')
      refresh()
    } catch (error) {
      if (error?.status === 409) notify('任务已启动，正在恢复最新处理状态')
      else {
        setRecognitionError(error.message || '识别任务启动失败，请稍后重试。')
        setRecognitionStarting(false)
      }
      refresh()
    }
  }

  const handleSubtitleChange = (clientId, patch) => {
    const timingChanged = 'start_time' in patch || 'end_time' in patch
    setSubtitles((current) => {
      const next = current.map((subtitle) => subtitle._clientId === clientId ? {
        ...subtitle,
        ...patch,
        ...(timingChanged ? {
          start_frame: null,
          end_frame_exclusive: null,
          start_pts: null,
          end_pts: null,
          time_base: null,
        } : {}),
      } : subtitle)
      subtitlesRef.current = next
      return next
    })
    markEdited()
  }

  const handleSubtitleDelete = (clientId) => {
    setSubtitles((current) => {
      const next = current.filter((subtitle) => subtitle._clientId !== clientId)
      subtitlesRef.current = next
      return next
    })
    markEdited()
  }

  const handleSubtitleAdd = (currentTime, duration) => {
    const clientId = makeClientId()
    const start = Math.max(0, Number(currentTime) || 0)
    let end = start + 2
    if (duration > start) end = Math.min(duration, end)
    if (end <= start) end = start + 2
    const nextSubtitle = {
      _clientId: clientId,
      id: clientId,
      text: '新字幕',
      start_time: Number(start.toFixed(3)),
      end_time: Number(end.toFixed(3)),
      confidence: 1,
    }
    setSubtitles((current) => {
      const next = [...current, nextSubtitle].sort((a, b) => a.start_time - b.start_time)
      subtitlesRef.current = next
      return next
    })
    markEdited()
    return clientId
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      if (dirtyRef.current && !await persistSubtitles(false)) return
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
  const roiStateIsCurrent = roiStateTaskId === taskId
  const currentRoiStage = roiStateIsCurrent ? roiStage : 'estimating'
  const currentPredictedRoi = roiStateIsCurrent ? predictedRoi : null

  return (
    <div className="app-shell">
      <AppHeader
        editor={editorReady}
        task={task}
        dirty={dirty}
        saving={saveStatus === 'saving'}
        syncStatus={saveStatus}
        exporting={exporting}
        onHome={() => navigate('/tasks')}
        onSave={() => persistSubtitles(true)}
        onExport={handleExport}
        onNewTask={() => navigate('/tasks/new')}
      />

      {unrecoverableTaskError && <TaskNotFound error={taskError} onRetry={refresh} onNewTask={() => navigate('/tasks/new')} />}
      {awaitingRoi && !unrecoverableTaskError && currentRoiStage !== 'manual' && (
        <AutoROIPreview
          task={task}
          videoUrl={getVideoUrl(taskId)}
          roi={currentPredictedRoi}
          loading={currentRoiStage === 'estimating'}
          submitting={recognitionStarting}
          error={recognitionError}
          onUse={handleStartRecognition}
          onReselect={() => {
            autoRoiAbortRef.current?.abort()
            setRoiStateTaskId(taskId)
            setAutoRoiNotice(currentPredictedRoi
              ? '可在 AI 预测区域的基础上继续调整。'
              : '已切换为人工字幕区域选择。')
            setRoiStage('manual')
          }}
          onNewTask={() => navigate('/tasks/new')}
        />
      )}
      {awaitingRoi && !unrecoverableTaskError && currentRoiStage === 'manual' && (
        <RoiSelectionPanel
          key={`manual-${taskId}`}
          task={currentPredictedRoi ? { ...task, roi: currentPredictedRoi } : task}
          videoUrl={getVideoUrl(taskId)}
          submitting={recognitionStarting}
          error={recognitionError}
          notice={autoRoiNotice}
          onConfirm={handleStartRecognition}
          onNewTask={() => navigate('/tasks/new')}
        />
      )}
      {!unrecoverableTaskError && !editorReady && !awaitingRoi && (
        <ProcessingPanel task={task} loading={taskLoading} pollingError={taskError} analysis={analysis} onRetry={refresh} onNewTask={() => navigate('/tasks/new')} />
      )}
      {editorReady && (
        <>
          {(saveStatus === 'offline' || saveStatus === 'conflict') && (
            <div className={`sync-banner sync-${saveStatus}`} role="status">
              {saveStatus === 'conflict'
                ? '版本冲突：服务端内容未被覆盖，本地修改已保留在 IndexedDB。'
                : '当前为离线草稿：任务已保存，但字幕修改尚未同步到服务端。'}
            </div>
          )}
          <EditorPage task={task} subtitles={subtitles} subtitlesLoading={subtitlesLoading} subtitlesError={subtitlesError} onSubtitleChange={handleSubtitleChange} onSubtitleDelete={handleSubtitleDelete} onSubtitleAdd={handleSubtitleAdd} onRetrySubtitles={() => setSubtitleReload((value) => value + 1)} onVideoError={() => notify('视频加载失败，请确认后端视频接口可访问。', 'error')} />
        </>
      )}

      <DraftRecoveryDialog
        draft={pendingDraft}
        conflict={Boolean(pendingDraft && Number(pendingDraft.revision) !== revision)}
        onRecover={() => {
          const normalized = normalizeSubtitles(pendingDraft.subtitles)
          subtitlesRef.current = normalized
          setSubtitles(normalized)
          revisionRef.current = Number(pendingDraft.revision) || 0
          setRevision(revisionRef.current)
          dirtyRef.current = true
          setDirty(true)
          setSaveStatus(Number(pendingDraft.revision) === revision ? 'offline' : 'conflict')
          setPendingDraft(null)
          setEditVersion((value) => {
            editVersionRef.current = value + 1
            return value + 1
          })
        }}
        onDiscard={async () => {
          await deleteSubtitleDraft(taskId).catch(() => {})
          setPendingDraft(null)
        }}
      />
      <LeaveSafetyDialog
        open={blocker.state === 'blocked'}
        saving={saveStatus === 'saving'}
        onSaveAndLeave={async () => {
          if (await persistSubtitles(false)) blocker.proceed?.()
        }}
        onDiscard={async () => {
          await deleteSubtitleDraft(taskId).catch(() => {})
          dirtyRef.current = false
          setDirty(false)
          blocker.proceed?.()
        }}
        onCancel={() => blocker.reset?.()}
      />
      {notice && <Toast key={notice.id} message={notice.message} type={notice.type} onDismiss={dismissNotice} />}
    </div>
  )
}
