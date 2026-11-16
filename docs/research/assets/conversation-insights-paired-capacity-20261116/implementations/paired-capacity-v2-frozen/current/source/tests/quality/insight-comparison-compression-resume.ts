import { isDeepStrictEqual as equal } from 'node:util'
import { parseInsightCompressedFacts } from '../../electron/main/insight-generation'
import { validateReadingChain, type ReadingChainPhase } from './insight-comparison-resume'

type Replay = { request: { stage: string; model: unknown; prompt: string; inputEstimate: number; outputLimit: number }; response: string }

function invalidResume(): never {
  const code = 'INVALID_COMPARISON_READING_RESUME'
  throw Object.assign(new Error(code), { code })
}

export function prepareCompressionCoverageResume(
  phases: ReadingChainPhase[], expected: Parameters<typeof validateReadingChain>[1], replay: Replay,
) {
  const charged = validateReadingChain(phases, expected)
  const phase = phases.at(-1)!
  const checkpoint = phase.checkpoint
  const navigation = checkpoint.navigation
  if (!expected.resuming || phase.result.error !== 'INVALID_EVIDENCE' || navigation?.factsVersion !== 2 || navigation.repairs !== 0
    || checkpoint.limits.maxCalls - checkpoint.callsReserved <= 1 || checkpoint.elapsedMs >= checkpoint.limits.maxElapsedMs
    || charged.inputCharged >= checkpoint.limits.maxInputTokens
    || charged.outputCharged + replay.request.outputLimit > checkpoint.limits.maxOutputTokens) return invalidResume()
  const attempt = checkpoint.attempts.at(-1)!
  const returned = phase.ledger.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .find(entry => entry.kind === 'returned' && entry.call === phase.result.calls)
  if (replay.request.stage !== 'compress-navigation' || replay.request.model !== expected.expectedInput.model
    || replay.request.inputEstimate !== attempt.input.tokens || replay.request.outputLimit !== attempt.reservedOutput
    || !returned || returned.stopReason === 'length') return invalidResume()
  let payload, body
  try {
    payload = JSON.parse(replay.request.prompt)
    body = JSON.parse(replay.response.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1'))
  } catch { return invalidResume() }
  if (!payload || !Array.isArray(payload.nodes) || !payload.nodes.length) return invalidResume()
  const ids = navigation.roots.slice(navigation.cursor, navigation.cursor + payload.nodes.length)
  if (ids.length !== payload.nodes.length) return invalidResume()
  const nodes = ids.map(navigationId => ({ navigationId, childCount: navigation.nodes[navigationId].children.length,
    entries: navigation.nodes[navigationId].facts!.map((fact, index) => ({ ...fact, entryId: `${navigationId}:${index}` })),
  }))
  const entries = nodes.flatMap(node => node.entries)
  const targetFactTextLength = Math.max(160, Math.floor(entries.reduce((sum, fact) => sum + [...fact.text].length, 0) * 0.6))
  if (!equal(payload, { stage: 'reading', operation: 'compress-navigation', targetFactTextLength, maxFactCount: entries.length * 2,
    nodes: nodes.map(node => ({ navigationId: node.navigationId, childCount: node.childCount,
      entries: node.entries.map(({ entryId, kind, text }) => ({ entryId, kind, text })),
    })),
  })) return invalidResume()
  const validText = (text: unknown, maximum: number) => typeof text === 'string' && !!text.trim() && text.length <= maximum
  if (!body || Array.isArray(body) || !validText(body.text, 720) || !Array.isArray(body.facts)
    || body.facts.length > entries.length * 2 || body.facts.some((fact: Record<string, unknown>) => !fact
      || !['fact', 'unknown'].includes(String(fact.kind)) || !validText(fact.text, 1200)
      || !Array.isArray(fact.entryIds) || !fact.entryIds.length || fact.entryIds.length > 200
      || fact.entryIds.some(id => !validText(id, 256)))) return invalidResume()
  // 完整解析器先拒绝外来来源及无依据解除未知，格式错误才有资格匹配旧覆盖故障。
  try { parseInsightCompressedFacts(body.facts, nodes); return invalidResume() }
  catch (error) { if ((error as { code?: string }).code !== 'INVALID_INSIGHT_OUTPUT') return invalidResume() }
  const outputFacts = body.facts as { kind: 'fact' | 'unknown'; text: string; entryIds: string[] }[]
  const covered = new Set(outputFacts.flatMap(fact => fact.entryIds))
  const retained = new Set(outputFacts.filter(fact => fact.kind === 'fact').flatMap(fact => fact.entryIds))
  if (!entries.some(entry => !covered.has(entry.entryId) || entry.kind === 'fact' && !retained.has(entry.entryId))) return invalidResume()
  const entryMap = new Map(entries.map(entry => [entry.entryId, entry]))
  const restoredFacts = outputFacts.map(fact => ({ kind: fact.kind, text: fact.text,
    sourceIds: [...new Set(fact.entryIds.flatMap(id => entryMap.get(id)!.sourceIds))],
  }))
  const bytes = (facts: typeof restoredFacts) => Buffer.byteLength(JSON.stringify({
    observations: facts.filter(fact => fact.kind === 'fact').map(({ text, sourceIds }) => ({ text, sourceIds })),
    openThreads: facts.filter(fact => fact.kind === 'unknown').map(({ text, sourceIds }) => ({ text, sourceIds })),
  }), 'utf8')
  if (bytes(restoredFacts) * 5 > bytes(entries) * 4) return invalidResume()
  const restored = structuredClone(checkpoint)
  restored.navigation!.repairs = 1
  return restored
}
