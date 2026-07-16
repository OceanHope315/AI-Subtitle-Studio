import { AlertIcon, RotateIcon } from './Icons'

export default function TaskNotFound({ error, onRetry, onNewTask }) {
  return (
    <main className="state-page">
      <section className="failure-card" role="alert">
        <span className="failure-icon"><AlertIcon width="30" height="30" /></span>
        <div>
          <p className="state-kicker">无法打开任务</p>
          <h1>{error?.status === 404 ? '任务不存在或已过期' : '暂时无法连接服务'}</h1>
          <p>{error?.message || '请确认后端服务正在运行，然后重试。'}</p>
        </div>
        <div className="state-actions">
          <button className="button button-primary" type="button" onClick={onRetry}><RotateIcon /> 重新加载</button>
          <button className="button button-secondary" type="button" onClick={onNewTask}>返回上传</button>
        </div>
      </section>
    </main>
  )
}
