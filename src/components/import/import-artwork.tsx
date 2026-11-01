import { CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react'

export function ChatImportArt() {
  return <svg className="import-art" viewBox="0 0 96 84" aria-hidden="true" fill="none" strokeLinecap="round" strokeLinejoin="round">
    <ellipse cx="48" cy="71" rx="27" ry="4" fill="#f2e6dd" />
    <g className="import-art-sheet">
      <rect x="28" y="14" width="33" height="40" rx="6" transform="rotate(-12 44 34)" fill="#ffead8" stroke="#d89c76" strokeWidth="1.6" />
      <path d="M40 12h23a6 6 0 0 1 6 6v24a6 6 0 0 1-6 6H49l-8 6v-6h-1a6 6 0 0 1-6-6V18a6 6 0 0 1 6-6Z" fill="#fffaf5" stroke="#aa6040" strokeWidth="1.8" />
      <path d="M43 24h16m-16 7h10" stroke="#c18c71" strokeWidth="2.4" />
    </g>
    <path d="m24 54 6-12h6m24 0h6l6 12" fill="#ffd9bd" stroke="#b35a33" strokeWidth="2" />
    <path d="M23 53h15l4 6h12l4-6h15v10a6 6 0 0 1-6 6H29a6 6 0 0 1-6-6Z" fill="#ffe7d4" stroke="#ad522b" strokeWidth="2" />
    <g className="import-art-arrow">
      <circle cx="70" cy="27" r="11" fill="#b83b12" stroke="white" strokeWidth="2" />
      <path d="M70 22v10m-4-4 4 4 4-4" stroke="white" strokeWidth="2" />
    </g>
  </svg>
}

export function ImportStateMark({ state = 'working' }: { state?: 'working' | 'saved' | 'failed' }) {
  const Icon = state === 'working' ? LoaderCircle : state === 'saved' ? CircleCheck : CircleAlert
  return <span className={`import-state-mark is-${state}`} aria-hidden="true"><Icon size={23} strokeWidth={1.8} /></span>
}
