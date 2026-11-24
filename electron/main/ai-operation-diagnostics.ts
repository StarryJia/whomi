import { performance } from 'node:perf_hooks'
import type { AiModel, AiUsage } from '../../src/shared/ai-contract'
import { isSubscriptionId } from '../../src/shared/chatgpt-plan'
import { defaultModelProtocol, isModelProtocol } from '../../src/shared/model-protocol'
import { cherryProviderPresets } from '../../src/vendor/cherry-providers'
import type { createOperationDiagnostics } from './operation-diagnostics'
import { diagnosticErrorCode } from './app-error-logs'
import type { RuntimeInput, RuntimeRunner } from './ai-service'

export type AiDiagnostics = Pick<ReturnType<typeof createOperationDiagnostics>, 'begin' | 'event' | 'end' | 'bind' | 'findByTask' | 'resume' | 'discardUnstarted'>
type Fields = Record<string, unknown>
const presetEndpoints = new Set(cherryProviderPresets.flatMap(preset => Object.values(preset.baseUrls)))

export function aiOperation(diagnostics: AiDiagnostics | undefined, area: 'model' | 'insight' | 'conversation', action: string, recoveredId?: string | null) {
  const id = recoveredId ?? diagnostics?.begin(area, action)
  if (id && recoveredId) diagnostics?.resume(id)
  return {
    id,
    discardUnstarted() { if (id) return diagnostics?.discardUnstarted(id) },
    bind(taskId: string, createdAt: number | null | undefined) {
      if (id && typeof createdAt === 'number') diagnostics?.bind(id, taskId, createdAt)
    },
    event(stage: string, fields?: Fields, flags?: { progress?: boolean; retry?: boolean }) {
      if (id) diagnostics?.event(id, stage, fields, flags)
    },
    end(outcome: 'success' | 'cancelled' | 'failed' | 'interrupted', fields?: Fields) {
      if (id) diagnostics?.end(id, outcome, fields)
    },
  }
}
export type AiOperation = ReturnType<typeof aiOperation>
export type ModelRetry = { stage: 'shrink' | 'retry'; code: string }

function usageFields(usage?: AiUsage) {
  return {
    inputTokens: usage?.totalInputTokens ?? usage?.inputTokens, outputTokens: usage?.outputTokens,
    cacheReadTokens: usage?.cacheReadTokens, cacheWriteTokens: usage?.cacheWriteTokens,
  }
}

function providerFields(model: AiModel) {
  const subscription = isSubscriptionId(model.planProvider) ? model.planProvider : model.planAccount ? 'openai-codex' : undefined
  return {
    provider: subscription ?? (isModelProtocol(model.protocol) ? model.protocol : defaultModelProtocol),
    customService: !subscription && !presetEndpoints.has(model.baseUrl.replace(/\/+$/, '')),
  }
}

export async function runDiagnosedModel(runtime: RuntimeRunner, input: RuntimeInput, signal: AbortSignal,
  onText: (text: string) => void, operation: AiOperation, request: Fields, retry?: ModelRetry) {
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)
  let first = true
  if (retry) operation.event(retry.stage, { ...request, code: retry.code }, { retry: true })
  operation.event('request', { ...request, ...providerFields(input.model) })
  const unknown = () => operation.event('requestUnknown', { ...request, durationMs: elapsed() })
  signal.addEventListener('abort', unknown, { once: true })
  try {
    const result = await runtime.run(input, { signal, onText: text => {
      if (first && text && !signal.aborted) {
        first = false
        operation.event('firstResponse', { ...request, firstTokenMs: elapsed() })
      }
      onText(text)
    } })
    if (!signal.aborted) {
      if (first && result.text) operation.event('firstResponse', { ...request, firstTokenMs: result.usage.firstTokenMs ?? elapsed() })
      operation.event('returned', { ...request, ...usageFields(result.usage), durationMs: elapsed() })
    }
    return result
  } catch (error) {
    if (!signal.aborted) operation.event('requestFailed', { ...request, code: diagnosticErrorCode(error), durationMs: elapsed(), ...usageFields((error as { usage?: AiUsage })?.usage) })
    throw error
  } finally {
    signal.removeEventListener('abort', unknown)
  }
}
