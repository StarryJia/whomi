import { CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react'

export function ImportStateMark({ state = 'working' }: { state?: 'working' | 'saved' | 'failed' }) {
  const Icon = state === 'working' ? LoaderCircle : state === 'saved' ? CircleCheck : CircleAlert
  return <span className={`import-state-mark is-${state}`} aria-hidden="true"><Icon size={23} strokeWidth={1.8} /></span>
}
