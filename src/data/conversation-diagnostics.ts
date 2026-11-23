import type { ConversationAction, ConversationStep, ConversationTrace } from '../shared/operation-diagnostics-api'

export function traceConversation(action: ConversationAction) {
  const send = window.whomi?.operationDiagnostics?.conversation
  const id = send && crypto.randomUUID()
  let ended = false
  function record(event: ConversationTrace) {
    try { send?.(event) } catch { /* 诊断通道关闭时，原操作仍可完成。 */ }
  }
  if (id) record({ id, kind: 'start', action })
  return {
    step(stage: ConversationStep, fields: { count?: number; hasMore?: boolean; found?: boolean } = {}) {
      if (id && !ended) record({ id, kind: 'step', stage, ...fields })
    },
    end(outcome: 'success' | 'failed' | 'unknown', error?: unknown) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined
      if (id && !ended) record({ id, kind: 'end', outcome, ...(code && { code }) })
      ended = true
    },
  }
}
