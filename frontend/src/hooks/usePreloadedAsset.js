import { useEffect, useState } from 'react'

export default function usePreloadedAsset(source, value, resetKey) {
  const requestKey = source ? `${resetKey}\u0000${source}` : ''
  const [result, setResult] = useState({
    displayed: null,
    settledKey: '',
    failed: false,
  })
  const displayed = result.displayed?.resetKey === resetKey ? result.displayed : null

  useEffect(() => {
    if (!source || result.settledKey === requestKey) return undefined
    let active = true
    const image = new Image()
    image.onload = () => {
      if (!active) return
      setResult({
        displayed: { source, value, resetKey },
        settledKey: requestKey,
        failed: false,
      })
    }
    image.onerror = () => {
      if (!active) return
      setResult((current) => ({
        displayed: current.displayed,
        settledKey: requestKey,
        failed: true,
      }))
    }
    image.src = source
    return () => {
      active = false
      image.onload = null
      image.onerror = null
    }
  }, [requestKey, resetKey, result.settledKey, source, value])

  let status = 'empty'
  if (source) {
    if (result.settledKey !== requestKey) status = 'loading'
    else status = result.failed ? 'failed' : 'ready'
  }
  return { displayed, status }
}
