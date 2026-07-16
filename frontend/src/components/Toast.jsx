import { useEffect } from 'react'
import { AlertIcon, CheckIcon, CloseIcon } from './Icons'

export default function Toast({ message, type = 'success', onDismiss }) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, 3200)
    return () => window.clearTimeout(timer)
  }, [message, onDismiss])

  return (
    <div className={`toast toast-${type}`} role={type === 'error' ? 'alert' : 'status'}>
      <span>{type === 'error' ? <AlertIcon /> : <CheckIcon />}</span>
      <p>{message}</p>
      <button type="button" aria-label="关闭提示" onClick={onDismiss}><CloseIcon width="16" height="16" /></button>
    </div>
  )
}
