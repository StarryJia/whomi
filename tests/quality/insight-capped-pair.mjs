import { appendFileSync, readFileSync } from 'node:fs'

export const cappedTrialActions = {
  TRIAL_COST_LIMIT: '下一次请求将超过费用上限。请核对 reservations.jsonl。',
  TRIAL_CALL_LIMIT: '已达请求次数上限。请查看各任务的运行结果。',
  INVALID_TRIAL_LEDGER: '请核对 reservations.jsonl 中的费用预留记录。',
  UNPRICED_TRIAL_REQUEST: '请核对模型、输入类型和标准档单价。',
  INSIGHT_BUDGET_EXHAUSTED: '本任务的预算已用尽。请查看已保存的阅读进度和用量。',
  TRIAL_HALTED: '试验已停止。请查看 halt.json。',
}

function stop(code) {
  throw Object.assign(new Error(code), { code })
}

function reservationMicrodollars(inputBound, outputLimit) {
  return inputBound * 5 + outputLimit * 10
}

// This trial pins Standard short-context pricing for gpt-6.1-sol on 2026-11-22.
// Reserve the most expensive cache-write rate for every input token, including failed calls.
export function reserveStandardTextRequest(request, body, ledger, dispatched) {
  const cap = body.max_completion_tokens ?? body.max_tokens
  if (body.model !== 'gpt-6.1-sol' || !Number.isSafeInteger(cap) || cap < 1 || cap > 6000
    || (body.n ?? 1) !== 1 || body.tools?.length || body.functions?.length || body.web_search_options || body.audio || body.prediction
    || body.modalities?.some(mode => mode !== 'text') || !Array.isArray(body.messages) || !body.messages.length
    || !body.messages.every(message => ['system', 'developer', 'user'].includes(message.role)
      && (typeof message.content === 'string' || Array.isArray(message.content)
        && message.content.every(part => part.type === 'text' && typeof part.text === 'string')))) {
    return stop('UNPRICED_TRIAL_REQUEST')
  }
  const payload = JSON.stringify({ ...body, service_tier: 'default' })
  // UTF-8 bytes bound plain text tokenization. Leave room for the service's message framing.
  const inputBound = Buffer.byteLength(payload, 'utf8') + 1024 + 64 * body.messages.length
  if (inputBound > 80_000) return stop('UNPRICED_TRIAL_REQUEST')
  const microdollars = reservationMicrodollars(inputBound, cap)
  let previous = []
  try {
    previous = readFileSync(ledger, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))
  } catch (error) {
    if (error.code !== 'ENOENT') return stop('INVALID_TRIAL_LEDGER')
  }
  if (previous.length !== dispatched) return stop('INVALID_TRIAL_LEDGER')
  const reserved = previous.reduce((sum, item) => {
    if (!item || !Number.isSafeInteger(item.inputBound) || item.inputBound < 1 || item.inputBound > 80_000
      || !Number.isSafeInteger(item.outputLimit) || item.outputLimit < 1 || item.outputLimit > 6000
      || item.microdollars !== reservationMicrodollars(item.inputBound, item.outputLimit)) return stop('INVALID_TRIAL_LEDGER')
    return sum + item.microdollars
  }, 0)
  if (reserved + microdollars > 2_000_000) return stop('TRIAL_COST_LIMIT')
  if (previous.length >= 24) return stop('TRIAL_CALL_LIMIT')
  // The runner holds the output lock across all four arms. A lost response keeps its reservation.
  appendFileSync(ledger, JSON.stringify({ inputBound, outputLimit: cap, microdollars }) + '\n', { flush: true })
  const headers = new Headers(request.headers)
  headers.delete('content-length')
  return new Request(request, { headers, body: payload, redirect: 'error' })
}
