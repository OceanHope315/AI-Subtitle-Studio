export function DraftRecoveryDialog({ draft, conflict, onRecover, onDiscard }) {
  if (!draft) return null
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="safety-dialog" role="dialog" aria-modal="true" aria-labelledby="draft-dialog-title">
        <h2 id="draft-dialog-title">发现本地字幕草稿</h2>
        <p>
          {conflict
            ? '草稿基于较旧的服务端版本。恢复后会保留冲突状态，绝不会静默覆盖其他标签页的修改。'
            : '上次的字幕修改已安全保存在此浏览器中，可以继续编辑。'}
        </p>
        <small>草稿时间：{new Date(draft.updatedAt).toLocaleString()}</small>
        <div className="dialog-actions">
          <button className="button button-ghost" type="button" onClick={onDiscard}>放弃本地草稿</button>
          <button className="button button-primary" type="button" onClick={onRecover}>恢复草稿</button>
        </div>
      </section>
    </div>
  )
}

export function LeaveSafetyDialog({ open, saving, onSaveAndLeave, onDiscard, onCancel }) {
  if (!open) return null
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="safety-dialog" role="dialog" aria-modal="true" aria-labelledby="leave-dialog-title">
        <h2 id="leave-dialog-title">字幕修改尚未同步</h2>
        <p>任务本身已经保存。请选择如何处理当前字幕修改。</p>
        <div className="dialog-actions dialog-actions-three">
          <button className="button button-ghost" type="button" onClick={onCancel}>取消</button>
          <button className="button button-secondary" type="button" onClick={onDiscard}>放弃修改</button>
          <button className="button button-primary" type="button" disabled={saving} onClick={onSaveAndLeave}>
            {saving ? '保存中…' : '保存并离开'}
          </button>
        </div>
      </section>
    </div>
  )
}
