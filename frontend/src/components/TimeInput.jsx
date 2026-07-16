import { useState } from 'react'
import { formatTimestamp, parseTimestamp } from '../utils/subtitles'

export default function TimeInput({ value, label, invalid, onCommit, onFocus }) {
  const [draft, setDraft] = useState(() => formatTimestamp(value))

  const commit = () => {
    const parsed = parseTimestamp(draft)
    if (parsed === null) {
      setDraft(formatTimestamp(value))
      return
    }
    onCommit(parsed)
  }

  return (
    <label className={`time-field ${invalid ? 'is-invalid' : ''}`}>
      <span>{label}</span>
      <input
        value={draft}
        inputMode="decimal"
        spellCheck="false"
        aria-label={label}
        onFocus={(event) => {
          event.currentTarget.select()
          onFocus?.()
        }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') {
            setDraft(formatTimestamp(value))
            event.currentTarget.blur()
          }
        }}
      />
    </label>
  )
}
