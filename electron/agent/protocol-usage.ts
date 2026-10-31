import type { AiUsage } from '../../src/shared/ai-contract'
import type { ModelProtocol } from '../../src/shared/model-protocol'

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

// Only wire-reported values establish presence; SDK zero defaults do not prove usage.
export function protocolUsage(protocol: ModelProtocol, event: unknown, previous: AiUsage): AiUsage {
  const chunk = record(event)
  const usage = protocol === 'google-generative-ai' ? record(chunk.usageMetadata)
    : protocol === 'anthropic-messages' ? record(chunk.usage ?? record(chunk.message).usage)
      : protocol === 'openai-responses' ? record(record(chunk.response).usage)
        : record(chunk.usage ?? (Array.isArray(chunk.choices) ? record(chunk.choices[0]).usage : undefined))
  const next = { ...previous }
  let input: number | undefined, output: number | undefined, cached: number | undefined, written: number | undefined
  if (protocol === 'google-generative-ai') {
    input = count(usage.promptTokenCount); output = count(usage.candidatesTokenCount)
    if (output !== undefined) output += count(usage.thoughtsTokenCount) ?? 0
    cached = count(usage.cachedContentTokenCount)
  } else if (protocol === 'anthropic-messages') {
    input = count(usage.input_tokens); output = count(usage.output_tokens)
    cached = count(usage.cache_read_input_tokens); written = count(usage.cache_creation_input_tokens)
  } else {
    const completions = protocol === 'openai-completions'
    input = count(usage[completions ? 'prompt_tokens' : 'input_tokens']); output = count(usage[completions ? 'completion_tokens' : 'output_tokens'])
    const details = record(usage[completions ? 'prompt_tokens_details' : 'input_tokens_details'])
    cached = count(details.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens)
    written = count(details.cache_write_tokens)
  }
  if (cached !== undefined) next.cacheReadTokens = cached
  if (written !== undefined) next.cacheWriteTokens = written
  if (input !== undefined) {
    next.inputTokens = protocol === 'anthropic-messages' ? input : Math.max(0, input - (cached ?? 0) - (written ?? 0))
    next.totalInputTokens = protocol === 'anthropic-messages' ? input + (cached ?? 0) + (written ?? 0) : input
  }
  if (output !== undefined) next.outputTokens = output
  return next
}
