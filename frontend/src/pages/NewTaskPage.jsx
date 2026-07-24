import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { uploadVideo } from '../api/tasks'
import AppHeader from '../components/AppHeader'
import UploadPanel from '../components/UploadPanel'
import { ANALYSIS_MODES } from '../utils/analysisMode'

function resolveTaskId(payload) {
  const task = payload?.task || payload?.data || payload
  return task?.taskId || task?.id || task?._id || payload?.taskId || ''
}

export default function NewTaskPage() {
  const navigate = useNavigate()
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadError, setUploadError] = useState('')
  const [analysisMode, setAnalysisMode] = useState(ANALYSIS_MODES.AUDIO_VISUAL)

  const handleUpload = async (file, validationError = '') => {
    if (!file) {
      setUploadError(validationError || '请选择一个 MP4 视频。')
      return
    }
    setUploading(true)
    setUploadProgress(0)
    setUploadError('')
    try {
      const payload = await uploadVideo(file, setUploadProgress, analysisMode)
      const taskId = resolveTaskId(payload)
      if (!taskId) throw new Error('后端未返回有效的任务编号。')
      navigate(`/tasks/${taskId}`, { replace: true })
    } catch (error) {
      setUploadError(error.message || '上传失败，请稍后重试。')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="app-shell">
      <AppHeader onHome={() => navigate('/tasks')} onNewTask={() => navigate('/tasks/new')} />
      <UploadPanel
        uploading={uploading}
        uploadProgress={uploadProgress}
        error={uploadError}
        analysisMode={analysisMode}
        onAnalysisModeChange={setAnalysisMode}
        onUpload={handleUpload}
      />
    </div>
  )
}
