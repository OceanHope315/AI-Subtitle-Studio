import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { archiveTask, listTasks } from '../api/tasks'
import AppHeader from '../components/AppHeader'

const STATUS_LABELS = {
  awaiting_roi: '等待确认区域',
  queued: '排队中',
  processing: '识别中',
  completed: '已完成',
  failed: '失败',
}

const ACTION_LABELS = {
  awaiting_roi: '确认字幕区域',
  queued: '查看进度',
  processing: '查看进度',
  completed: '继续编辑',
  failed: '查看失败',
}

function formatDate(value) {
  if (!value) return '—'
  return new Date(value).toLocaleString()
}

export default function TasksPage() {
  const navigate = useNavigate()
  const [tasks, setTasks] = useState([])
  const [pagination, setPagination] = useState({ page: 1, pages: 0, total: 0 })
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    const startTimer = window.setTimeout(() => {
      setLoading(true)
      setError(null)
      listTasks({ page, status, search, signal: controller.signal })
      .then((result) => {
        setTasks(result.tasks)
        setPagination(result.pagination)
      })
      .catch((nextError) => {
        if (nextError.name !== 'AbortError') setError(nextError)
      })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
    }, 0)
    return () => {
      window.clearTimeout(startTimer)
      controller.abort()
    }
  }, [page, reload, search, status])

  const handleArchive = useCallback(async (task) => {
    if (!window.confirm(`归档“${task.filename}”？视频和字幕产物会保留。`)) return
    try {
      await archiveTask(task.taskId || task.id)
      setReload((value) => value + 1)
    } catch (nextError) {
      setError(nextError)
    }
  }, [])

  return (
    <div className="app-shell">
      <AppHeader onHome={() => navigate('/tasks')} onNewTask={() => navigate('/tasks/new')} />
      <main className="tasks-page">
        <div className="tasks-hero">
          <div><span>任务已持久化</span><h1>任务中心</h1><p>从历史任务继续确认字幕区域、查看进度或校对字幕。</p></div>
          <button className="button button-primary" type="button" onClick={() => navigate('/tasks/new')}>新建任务</button>
        </div>

        <form className="task-filters" onSubmit={(event) => {
          event.preventDefault()
          setPage(1)
          setSearch(searchInput.trim())
        }}>
          <label>
            <span>状态</span>
            <select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1) }}>
              <option value="">全部状态</option>
              {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="task-search">
            <span>搜索</span>
            <input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="按文件名搜索" />
          </label>
          <button className="button button-secondary" type="submit">搜索</button>
        </form>

        {loading && <div className="task-center-state"><span className="large-spinner" /><p>正在读取已保存任务…</p></div>}
        {!loading && error && <div className="task-center-state panel-state-error" role="alert"><strong>任务列表加载失败</strong><p>{error.message}</p><button className="button button-secondary" type="button" onClick={() => setReload((value) => value + 1)}>重试</button></div>}
        {!loading && !error && tasks.length === 0 && <div className="task-center-state"><strong>没有符合条件的任务</strong><p>历史任务不会因新建任务而被清除。</p></div>}

        {!loading && !error && tasks.length > 0 && (
          <div className="task-grid">
            {tasks.map((task) => {
              const id = task.taskId || task.id
              return (
                <article className="task-card" key={id}>
                  <div className="task-card-heading"><span className={`task-status status-${task.status}`}>{STATUS_LABELS[task.status] || task.status}</span><button type="button" onClick={() => handleArchive(task)}>归档</button></div>
                  <h2 title={task.filename}>{task.filename || '未命名视频'}</h2>
                  <div className="task-progress"><i style={{ width: `${Math.max(0, Math.min(100, Number(task.progress) || 0))}%` }} /></div>
                  <dl>
                    <div><dt>进度</dt><dd>{Math.round(Number(task.progress) || 0)}%</dd></div>
                    <div><dt>字幕</dt><dd>{task.subtitle_count || 0} 条</dd></div>
                    <div><dt>创建</dt><dd>{formatDate(task.created_at)}</dd></div>
                    <div><dt>更新</dt><dd>{formatDate(task.updated_at)}</dd></div>
                  </dl>
                  <button className="button button-secondary task-open" type="button" onClick={() => navigate(`/tasks/${id}`)}>{ACTION_LABELS[task.status] || '打开任务'}</button>
                </article>
              )
            })}
          </div>
        )}

        {pagination.pages > 1 && (
          <nav className="task-pagination" aria-label="任务分页">
            <button type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button>
            <span>第 {page} / {pagination.pages} 页 · 共 {pagination.total} 个任务</span>
            <button type="button" disabled={page >= pagination.pages} onClick={() => setPage((value) => value + 1)}>下一页</button>
          </nav>
        )}
      </main>
    </div>
  )
}
