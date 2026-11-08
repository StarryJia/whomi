import { AlertTriangle } from 'lucide-react'

const ErrorBlock = ({ error }: { error?: string }) => (
  <div
    role="alert"
    className="conversation-error group relative my-2 rounded-lg border border-border border-l-[3px] bg-transparent px-3.5 py-3 text-[13px]">
    <div className="flex items-center gap-2">
      <AlertTriangle className="shrink-0" size={15} aria-hidden="true" />
      <span className="font-medium leading-[1.4] [overflow-wrap:anywhere]">{error || '回答失败。'}</span>
    </div>
  </div>
)

export default ErrorBlock
