const baseProps = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
}

export function SparklesIcon(props) {
  return (
    <svg {...baseProps} {...props}>
      <path d="m12 3-1.1 3.1a7 7 0 0 1-4.2 4.2L3.5 11.5l3.2 1.1a7 7 0 0 1 4.2 4.2L12 20l1.1-3.2a7 7 0 0 1 4.2-4.2l3.2-1.1-3.2-1.2a7 7 0 0 1-4.2-4.2L12 3Z" />
      <path d="m19 3-.35 1a2.6 2.6 0 0 1-1.6 1.6l-1.05.4 1.05.4A2.6 2.6 0 0 1 18.65 8L19 9l.35-1a2.6 2.6 0 0 1 1.6-1.6L22 6l-1.05-.4A2.6 2.6 0 0 1 19.35 4L19 3Z" />
    </svg>
  )
}

export function UploadIcon(props) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5" />
      <path d="M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" />
    </svg>
  )
}

export function FilmIcon(props) {
  return (
    <svg {...baseProps} {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 5v14M17 5v14M3 9h4m10 0h4M3 15h4m10 0h4" />
    </svg>
  )
}

export function CaptionsIcon(props) {
  return (
    <svg {...baseProps} {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 11h4M7 15h6m2-4h2m-2 4h2" />
    </svg>
  )
}

export function DownloadIcon(props) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M12 4v11m0 0 4-4m-4 4-4-4" />
      <path d="M5 19h14" />
    </svg>
  )
}

export function SaveIcon(props) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M5 4h12l2 2v14H5z" />
      <path d="M8 4v6h8V4M8 20v-6h8v6" />
    </svg>
  )
}

export function PlusIcon(props) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function TrashIcon(props) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7" />
      <path d="M10 11v5m4-5v5" />
    </svg>
  )
}

export function PlayIcon(props) {
  return (
    <svg {...baseProps} {...props}>
      <path d="m8 5 11 7-11 7z" />
    </svg>
  )
}

export function RotateIcon(props) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M20 7v5h-5" />
      <path d="M18.5 16A8 8 0 1 1 20 12" />
    </svg>
  )
}

export function CheckIcon(props) {
  return (
    <svg {...baseProps} {...props}>
      <path d="m5 12 4 4L19 6" />
    </svg>
  )
}

export function AlertIcon(props) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M12 4 3 20h18L12 4Z" />
      <path d="M12 9v5m0 3h.01" />
    </svg>
  )
}

export function CloseIcon(props) {
  return (
    <svg {...baseProps} {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  )
}

export function ClockIcon(props) {
  return (
    <svg {...baseProps} {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}
