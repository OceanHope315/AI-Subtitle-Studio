import { CaptionsIcon, DownloadIcon, PlusIcon, SaveIcon, SparklesIcon } from './Icons'

export default function AppHeader({
  editor = false,
  task,
  dirty,
  saving,
  exporting,
  syncStatus = 'synced',
  onHome,
  onSave,
  onExport,
  onNewTask,
}) {
  return (
    <header className="app-header">
      <div className="header-inner">
        <button className="brand" type="button" onClick={onHome} aria-label="返回任务中心">
          <span className="brand-mark"><CaptionsIcon /></span>
          <span className="brand-copy">
            <strong>AI Subtitle Studio</strong>
            <small>智能字幕工作台</small>
          </span>
        </button>

        {editor ? (
          <div className="header-actions">
            <div className="task-state" title={task?.filename || ''}>
              <span className={`status-dot status-${syncStatus}`} />
              <span className="task-state-label">{
                syncStatus === 'saving' ? '任务已保存 · 字幕保存中' :
                  syncStatus === 'offline' ? '任务已保存 · 离线草稿' :
                    syncStatus === 'conflict' ? '任务已保存 · 版本冲突' :
                      dirty ? '任务已保存 · 字幕未同步' : '任务已保存 · 字幕已同步'
              }</span>
            </div>
            <button className="button button-ghost button-compact" type="button" onClick={onNewTask}>
              <PlusIcon />
              <span>新建任务</span>
            </button>
            <button
              className="button button-secondary button-compact"
              type="button"
              disabled={saving || !dirty}
              onClick={onSave}
            >
              <SaveIcon />
              <span>{saving ? '保存中…' : '保存'}</span>
            </button>
            <button
              className="button button-primary button-compact"
              type="button"
              disabled={saving || exporting}
              onClick={onExport}
            >
              {exporting ? <span className="mini-spinner" /> : <DownloadIcon />}
              <span>{exporting ? '导出中…' : '导出 SRT'}</span>
            </button>
          </div>
        ) : (
          <div className="header-tagline">
            <SparklesIcon />
            <span>OCR + AI 智能识别</span>
          </div>
        )}
      </div>
    </header>
  )
}
