import { useEffect, useState } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

export default function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia?.(QUERY).matches || false)

  useEffect(() => {
    const media = window.matchMedia?.(QUERY)
    if (!media) return undefined
    const update = (event) => setReduced(event.matches)
    media.addEventListener?.('change', update)
    return () => media.removeEventListener?.('change', update)
  }, [])

  return reduced
}
