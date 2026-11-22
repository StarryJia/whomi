import type { AiModel, AiUsage } from '../../src/shared/ai-contract'
import type {
  InsightCitation, InsightInline, InsightJudgment, InsightParagraph, InsightReport, InsightSnapshot, InsightSourceMessage, InsightSourceRef,
} from '../../src/shared/conversation-insights'
import { BoundaryError } from '../../src/shared/desktop-validation'
import { dimensionKeys } from '../../src/shared/conversation-insights'
import { buildInsightPrompt, INSIGHT_PROMPT_VERSION, type InsightPrompts } from '../data/ai/insight-prompts'
import type { RuntimeInput, RuntimeResult, RuntimeRunner } from './ai-service'
import {
  createInsightCheckpoint, InsightBudgetError, remainingInsightBudget, startingInsightCursor,
  type InsightAttempt, type InsightCandidate, type InsightCheck, type InsightCheckpoint, type InsightEvidenceNote,
  type InsightFinding, type InsightMemoryFact, type InsightNavigation, type InsightNavigationRequest, type InsightNote, type InsightRunLimits, type InsightStage,
} from './insight-checkpoint'
import {
  computeInsightInputBudget, countInsightInput, insightCapacityError, packInsightSources, resolveInsightCapacity,
  restoreInsightSources, shrinkInsightSources, type InsightInputCount, type InsightSourcePart,
} from './insight-packing'

const maxShrinkDepth = 8
const maxOutputRepairs = 1
const maximumNotesPerBatch = 48
const maximumEvidenceNotes = 24
const elapsedPersistenceIntervalMs = 5000

export type InsightGenerationDeps = {
  run: RuntimeRunner['run']
  read: (ids: readonly string[]) => Promise<InsightSourceMessage[]>
  saveCheckpoint: (state: InsightCheckpoint, sampledAtMs: number) => Promise<void>
  saveElapsed?: (elapsedMs: number, sampledAtMs: number) => Promise<void>
  signal: AbortSignal
  onText: (text: string) => void
  countInput?: (input: RuntimeInput, model: AiModel) => Promise<InsightInputCount>
  now?: () => number
}

type InsightGenerationInput = {
  snapshot: InsightSnapshot
  conversationId: string
  model: AiModel
  prompts: InsightPrompts
  limits: InsightRunLimits
  checkpoint: InsightCheckpoint | null
  elapsedMs?: number
  thinkingLevel?: RuntimeInput['thinkingLevel']
}

type ReadCandidate = InsightCandidate & { evidenceNotes: InsightEvidenceNote[] }
type CandidateUpdate = { id: string; evidenceNotes: InsightEvidenceNote[] } & (
  | { action: 'revise'; candidate: InsightCandidate }
  | { action: 'resolve'; finding: InsightFinding }
)
type VisibleCandidate = InsightCandidate & Pick<InsightCheck, 'id' | 'state'> & {
  finding: Pick<InsightFinding, 'revisedObservation' | 'supportingIds' | 'counterexampleIds'> | null
  evidenceNotes: (InsightEvidenceNote & Pick<InsightSourceMessage, 'sentAtMs' | 'senderName' | 'isSelf' | 'replyToMessageId'>)[]
}
type ReadResult = {
  observations: InsightNote[]; openThreads: InsightNote[]; candidates: ReadCandidate[];
  resolvedThreadSourceIds: string[]; candidateUpdates: CandidateUpdate[];
}
type VisibleNavigation = InsightNote & { navigationId: number; childCount: number }
type NavigationPage = { id: number; nodes: VisibleNavigation[]; nextOffset: number | null }
type CheckResult =
  | { action: 'read'; messageIds: string[]; purpose: string; evidenceNotes: InsightEvidenceNote[] }
  | { action: 'navigate'; navigation: InsightNavigationRequest; evidenceNotes: InsightEvidenceNote[] }
  | { action: 'finish'; finding: InsightFinding }

function navigationItems(navigation: InsightNavigation, ids: readonly number[]): VisibleNavigation[] {
  return ids.map(navigationId => {
    const { children, facts: _facts, ...note } = navigation.nodes[navigationId]
    return { ...note, sourceIds: children.length ? note.sourceIds.slice(0, 12) : note.sourceIds,
      navigationId, childCount: children.length }
  })
}

function navigationFacts(navigation: InsightNavigation, ids: readonly number[]): InsightMemoryFact[] {
  return ids.flatMap(id => navigation.nodes[id].facts ?? [{ ...navigation.nodes[id], kind: 'fact' as const }])
}

function compressionNodes(navigation: InsightNavigation, ids: readonly number[]) {
  return ids.map(navigationId => ({ navigationId, childCount: navigation.nodes[navigationId].children.length,
    entries: navigationFacts(navigation, [navigationId]).map((fact, index) => ({
      entryId: `${navigationId}:${index}`, kind: fact.kind, text: fact.text, sourceIds: fact.sourceIds,
    })),
  }))
}

function factTextLength(facts: readonly { text: string }[]): number {
  return facts.reduce((total, fact) => total + [...fact.text].length, 0)
}

function compressionLimits(nodes: ReturnType<typeof compressionNodes>) {
  const entries = nodes.flatMap(node => node.entries)
  return { targetFactTextLength: Math.max(160, Math.floor(factTextLength(entries) * 0.6)), maxFactCount: entries.length * 2 }
}

function compressionPayload(nodes: ReturnType<typeof compressionNodes>, repair: boolean) {
  return {
    stage: 'reading', operation: 'compress-navigation', ...compressionLimits(nodes),
    nodes: nodes.map(node => ({ navigationId: node.navigationId, childCount: node.childCount,
      entries: node.entries.map(({ entryId, kind, text }) => ({ entryId, kind, text })),
    })), ...(repair ? { repair: true } : {}),
  }
}

function factNotes(facts: readonly InsightMemoryFact[]) {
  const notes = (kind: InsightMemoryFact['kind']) => facts.filter(fact => fact.kind === kind)
    .map(({ text, sourceIds }) => ({ text, sourceIds }))
  return { observations: notes('fact'), openThreads: notes('unknown') }
}

const factBytes = (facts: readonly InsightMemoryFact[]) => Buffer.byteLength(JSON.stringify(factNotes(facts)), 'utf8')

export function parseInsightCompressedFacts(value: unknown, nodes: ReturnType<typeof compressionNodes>): InsightMemoryFact[] {
  const entries = new Map(nodes.flatMap(node => node.entries).map(entry => [entry.entryId, entry]))
  const covered = new Set<string>()
  const retainedUnknowns = new Set<string>()
  const unknownOnlyFacts: string[][] = []
  const facts = array<InsightMemoryFact>(value, entries.size * 2, item => {
    const fact = object(item)
    if (fact.kind !== 'fact' && fact.kind !== 'unknown') return invalidOutput()
    const ids = sourceIds(fact.entryIds, new Set(entries.keys()), true)
    const inputs = ids.map(id => entries.get(id)!)
    if (fact.kind === 'fact' && !inputs.some(entry => entry.kind === 'fact')) unknownOnlyFacts.push(ids)
    for (const id of ids) {
      covered.add(id)
      if (fact.kind === 'unknown') retainedUnknowns.add(id)
    }
    return { kind: fact.kind, text: string(fact.text, 1200), sourceIds: unique(inputs.flatMap(entry => entry.sourceIds)) }
  })
  if (unknownOnlyFacts.some(ids => ids.some(id => !retainedUnknowns.has(id)))) return invalidEvidence()
  if ([...entries.keys()].some(id => !covered.has(id))) return invalidOutput()
  return facts
}

const codeOf = (error: unknown) => (error as { code?: unknown })?.code
const unique = (ids: readonly string[]) => [...new Set(ids)]

function invalidOutput(): never {
  throw new BoundaryError('INVALID_INSIGHT_OUTPUT', '洞察结果格式错误，请继续生成。')
}

function invalidEvidence(): never {
  throw new BoundaryError('INVALID_EVIDENCE', '洞察引用的原文无法验证，请重新生成。')
}

function invalidCheckpoint(): never {
  throw new BoundaryError('INVALID_INSIGHT_CHECKPOINT', '洞察进度无法恢复，请重新生成。')
}

function outputLimit(): BoundaryError {
  return new BoundaryError('MODEL_OUTPUT_LIMIT', '洞察结果超出输出上限，请使用输出容量更大的模型重新生成。')
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidOutput()
  return value as Record<string, unknown>
}

function outputObject(response: RuntimeResult) {
  if (response.stopReason === 'length') throw outputLimit()
  const text = response.text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1')
  let value: unknown
  try { value = JSON.parse(text) } catch { return invalidOutput() }
  return object(value)
}

function array<T>(value: unknown, maximum: number, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > maximum) return invalidOutput()
  return value.map(parse)
}

function string(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) return invalidOutput()
  return value
}

function sourceIds(value: unknown, allowed: ReadonlySet<string>, required = false): string[] {
  const ids = unique(array(value, 200, item => string(item, 256)))
  if (required && !ids.length) return invalidOutput()
  if (ids.some(id => !allowed.has(id))) return invalidEvidence()
  return ids
}

function explanations(value: unknown): string[] {
  return array(value, 24, item => string(item, 3000))
}

function parseEvidenceNotes(
  value: unknown, evidence: readonly InsightSourcePart[], verified: readonly InsightEvidenceNote[] = [],
): InsightEvidenceNote[] {
  return array(value, maximumEvidenceNotes, item => {
    const note = object(item)
    const sourceId = string(note.sourceId, 256)
    const quote = string(note.quote, 240)
    if (!evidence.some(part => part.id === sourceId && part.text.includes(quote))
      && !verified.some(prior => prior.sourceId === sourceId && prior.quote.includes(quote))) return invalidEvidence()
    return { sourceId, quote, text: string(note.text, 480) }
  })
}

function parseFinding(body: Record<string, unknown>, evidence: ReadonlySet<string>): InsightFinding {
  const supportingIds = sourceIds(body.supportingIds, evidence)
  const counterexampleIds = sourceIds(body.counterexampleIds, evidence)
  return {
    revisedObservation: string(body.revisedObservation, 3000), supportingIds, counterexampleIds,
    alternativeExplanations: explanations(body.alternativeExplanations ?? []), limitations: explanations(body.limitations),
  }
}

function overlappingFindingSources(finding: InsightFinding): boolean {
  return finding.supportingIds.some(id => finding.counterexampleIds.includes(id))
}

function parseReading(
  response: RuntimeResult, originalEvidence: readonly InsightSourcePart[], knownCandidates: readonly VisibleCandidate[],
  openThreads: readonly InsightNote[],
): ReadResult {
  const body = outputObject(response)
  const rawIds = new Set(originalEvidence.map(part => part.id))
  // 关闭已显示的旧事项不要求重复提供原文，也不授予新增事实的引用资格。
  const resolvableThreadIds = new Set([...rawIds, ...openThreads.flatMap(note => note.sourceIds)])
  const candidateIds = new Set(knownCandidates.map(candidate => candidate.id))
  const visibleNotes = knownCandidates.flatMap(candidate => candidate.evidenceNotes)
  const updateEvidence = new Set([...rawIds, ...visibleNotes.map(note => note.sourceId)])
  const parseNote = (value: unknown) => {
    const note = object(value)
    return { text: string(note.text, 1200), sourceIds: sourceIds(note.sourceIds, rawIds, true) }
  }
  let repeatsVisibleThread = false
  const parseNewThread = (value: unknown) => {
    const note = object(value)
    const ids = sourceIds(note.sourceIds, resolvableThreadIds, true)
    if (ids.some(id => !rawIds.has(id))) repeatsVisibleThread = true
    return { text: string(note.text, 1200), sourceIds: ids }
  }
  const candidateUpdates = array(body.candidateUpdates ?? [], maximumNotesPerBatch, (value): CandidateUpdate => {
    const update = object(value)
    const id = string(update.id, 128)
    if (!candidateIds.has(id)) return invalidEvidence()
    candidateIds.delete(id)
    const notes = parseEvidenceNotes(update.evidenceNotes ?? [], originalEvidence, visibleNotes)
    if (update.action === 'resolve') {
      return { id, action: 'resolve', finding: parseFinding(object(update.finding), updateEvidence), evidenceNotes: notes }
    }
    if (update.action !== 'revise') return invalidOutput()
    const candidate = {
      observation: string(update.observation, 1200), supportingIds: sourceIds(update.supportingIds, updateEvidence, true),
      reason: string(update.reason, 1200),
    }
    return { id, action: 'revise', candidate, evidenceNotes: notes }
  })
  const reading: ReadResult = {
    observations: array(body.observations, maximumNotesPerBatch, parseNote),
    openThreads: array(body.openThreads, maximumNotesPerBatch, parseNewThread),
    candidates: array(body.candidates, maximumNotesPerBatch, value => {
      const candidate = object(value)
      return {
        observation: string(candidate.observation, 1200), supportingIds: sourceIds(candidate.supportingIds, rawIds, true),
        ...(candidate.reason === undefined ? {} : { reason: string(candidate.reason, 1200) }),
        evidenceNotes: parseEvidenceNotes(candidate.evidenceNotes ?? [], originalEvidence),
      }
    }),
    resolvedThreadSourceIds: body.resolvedThreadSourceIds === undefined ? [] : sourceIds(body.resolvedThreadSourceIds, resolvableThreadIds),
    candidateUpdates,
  }
  // 先拒绝整份响应里的非法来源，再处理可修复的协议错误。
  if (repeatsVisibleThread || candidateUpdates.some(update => update.action === 'resolve' && overlappingFindingSources(update.finding))) {
    return invalidOutput()
  }
  return reading
}

function parseChecking(
  response: RuntimeResult, checkId: string, covered: ReadonlySet<string>, evidence: ReadonlySet<string>, hasMoreEvidence: boolean,
  currentEvidence: readonly InsightSourcePart[], visibleNavigation: readonly VisibleNavigation[], navigationPage: NavigationPage | null,
  verifiedNotes: readonly InsightEvidenceNote[],
): CheckResult {
  const body = outputObject(response)
  if (body.checkId !== checkId) return invalidOutput()
  if (body.action === 'read' || body.action === 'navigate') {
    const evidenceNotes = parseEvidenceNotes(body.evidenceNotes ?? [], currentEvidence, verifiedNotes)
    if (currentEvidence.some(part => part.fragment
      && !evidenceNotes.some(note => note.sourceId === part.id && part.text.includes(note.quote)))) return invalidOutput()
    if (body.action === 'read') {
      return { action: 'read', messageIds: sourceIds(body.messageIds, covered, !hasMoreEvidence), purpose: string(body.purpose, 1200), evidenceNotes }
    }
    const { navigationId, offset } = body
    if (typeof navigationId !== 'number' || typeof offset !== 'number') return invalidOutput()
    const selected = visibleNavigation.find(node => node.navigationId === navigationId)
    if (offset === 0 && selected?.childCount === 0) {
      return {
        action: 'read', messageIds: sourceIds(selected.sourceIds, covered, true),
        purpose: '读取所选观察的关联原文', evidenceNotes,
      }
    }
    const start = offset === 0 && selected !== undefined && selected.childCount > 0
    const next = navigationPage?.id === navigationId && navigationPage.nextOffset === offset
    if (!start && !next) return invalidEvidence()
    return { action: 'navigate', navigation: { id: navigationId, offset }, evidenceNotes }
  }
  if (body.action !== 'finish') return invalidOutput()
  if (hasMoreEvidence) return invalidOutput()
  const finding = parseFinding(body, evidence)
  if (overlappingFindingSources(finding)) return invalidOutput()
  return { action: 'finish', finding }
}

function parseReport(
  response: RuntimeResult, conversationId: string, refs: ReadonlyMap<string, InsightSourceRef>,
  writtenEvidence: ReadonlySet<string>, selfIds: ReadonlySet<string>, checks: readonly InsightCheck[],
): InsightReport {
  const body = outputObject(response)
  if (body.format !== undefined && body.format !== INSIGHT_PROMPT_VERSION) return invalidOutput()
  const citations = array(body.citations, 200, (value): InsightCitation => {
    const citation = object(value)
    const fragments = array(citation.fragments, 50, fragment => ({
      sources: sourceIds(object(fragment).messageIds, writtenEvidence, true).map(id => refs.get(id)!),
    }))
    if (!fragments.length) return invalidOutput()
    return { id: string(citation.id, 128), conversationId, fragments }
  })
  const citationIds = new Set(citations.map(citation => citation.id))
  const usedCitations = new Set<string>()
  if (citationIds.size !== citations.length) return invalidOutput()
  const parseSection = (value: unknown): InsightParagraph[] => array(value, 100, item => {
    const content = array(object(item).content, 100, (inline): InsightInline => {
      const part = object(inline)
      const text = string(part.text, 12000)
      if (part.citationId === undefined) return { text }
      const citationId = string(part.citationId, 128)
      if (!citationIds.has(citationId)) return invalidEvidence()
      usedCitations.add(citationId)
      return { text, citationId }
    })
    if (!content.length) return invalidOutput()
    return { content }
  })
  const aboutYou = parseSection(body.aboutYou)
  const relationship = parseSection(body.relationship)
  if (usedCitations.size !== citationIds.size) return invalidOutput()
  const findings = checks.flatMap(check => check.finding ? [check.finding] : [])
  const supports = new Set(findings.flatMap(finding => finding.supportingIds))
  const counterexamples = new Set(findings.flatMap(finding => finding.counterexampleIds))
  const judgments = array(body.judgments ?? [], 100, (value): InsightJudgment => {
    const judgment = object(value)
    const dimension = dimensionKeys.find(key => key === judgment.dimension)
    const direction = judgment.direction
    if (!dimension || (direction !== null && (typeof direction !== 'string' || ![...dimension].includes(direction)))) return invalidOutput()
    const supportingIds = sourceIds(judgment.supportingIds, supports, true)
    const counterexampleIds = sourceIds(judgment.counterexampleIds, counterexamples)
    if (!supportingIds.some(id => selfIds.has(id)) || supportingIds.some(id => counterexampleIds.includes(id))) return invalidEvidence()
    return {
      dimension, direction, text: string(judgment.text, 3000),
      supportingSources: supportingIds.map(id => refs.get(id)!),
      counterexampleSources: counterexampleIds.map(id => refs.get(id)!),
      alternativeExplanations: explanations(judgment.alternativeExplanations), limitations: explanations(judgment.limitations),
    } as InsightJudgment
  })
  const limitations = explanations(body.limitations)
  if (checks.some(check => check.state === 'inconclusive')) limitations.push('部分观察缺少新增依据，仍无法确认。')
  return { format: INSIGHT_PROMPT_VERSION, aboutYou, relationship, citations, limitations, judgments }
}

function appendNotes(existing: InsightNote[], added: InsightNote[]): InsightNote[] {
  const key = ({ text, sourceIds }: InsightNote) => JSON.stringify([text, [...sourceIds].sort()])
  const notes = new Map(existing.map(note => [key(note), note]))
  for (const note of added) notes.set(key(note), note)
  return [...notes.values()]
}

function firstCheckSources(ids: readonly string[], messages: ReadonlyMap<string, InsightSourceMessage>, covered: ReadonlySet<string>) {
  return unique(ids.flatMap(id => {
    const reply = messages.get(id)?.replyToMessageId
    return reply && covered.has(reply) ? [reply, id] : [id]
  }))
}

function queueCandidates(state: InsightCheckpoint, candidates: ReadCandidate[], messages: ReadonlyMap<string, InsightSourceMessage>, covered: ReadonlySet<string>) {
  for (const candidate of candidates) {
    if (state.checks.length >= state.limits.maxChecks) break
    const normalized = candidate.observation.trim().replace(/\s+/g, '').toLowerCase()
    if (state.checks.some(check => check.observation.trim().replace(/\s+/g, '').toLowerCase() === normalized)) continue
    state.checks.push({
      ...candidate, id: String(state.checks.length + 1), state: 'pending', rounds: 0, seenEvidenceIds: [],
      navigationRequests: [], pendingNavigation: null,
      pendingIds: firstCheckSources(candidate.supportingIds, messages, covered),
      pendingCursor: startingInsightCursor, pendingThrough: null, shrinkDepth: 0, repairs: 0,
      purpose: candidate.reason ?? null, finding: null,
    })
  }
}

function appendEvidenceNotes(check: InsightCheck, notes: readonly InsightEvidenceNote[]) {
  for (const note of notes) {
    if (!check.evidenceNotes.some(prior => prior.sourceId === note.sourceId && prior.quote === note.quote && prior.text === note.text)) {
      check.evidenceNotes.push(note)
    }
  }
}

function applyCandidateUpdates(state: InsightCheckpoint, updates: CandidateUpdate[], messages: ReadonlyMap<string, InsightSourceMessage>, covered: ReadonlySet<string>) {
  for (const update of updates) {
    const check = state.checks.find(item => item.id === update.id)!
    appendEvidenceNotes(check, update.evidenceNotes)
    check.evidenceNotes = check.evidenceNotes.slice(-maximumEvidenceNotes)
    if (update.action === 'resolve') {
      check.state = 'finished'
      check.finding = update.finding
      delete check.reason
      check.purpose = null
      continue
    }
    Object.assign(check, update.candidate, {
      state: 'pending', finding: null, purpose: update.candidate.reason,
      seenEvidenceIds: [], pendingIds: firstCheckSources(update.candidate.supportingIds, messages, covered),
      navigationRequests: [], pendingNavigation: null, pendingCursor: startingInsightCursor, pendingThrough: null,
      shrinkDepth: 0, repairs: 0,
    })
  }
}

function evidenceFromSource(note: InsightEvidenceNote, { sentAtMs, senderName, isSelf, replyToMessageId }: InsightSourceMessage) {
  return { ...note, sentAtMs, senderName, isSelf, replyToMessageId }
}

function candidateSources(check: InsightCheck) {
  return [...check.supportingIds, ...check.finding?.supportingIds ?? [], ...check.finding?.counterexampleIds ?? [],
    ...check.evidenceNotes.map(note => note.sourceId)]
}

function visibleCandidate(check: InsightCheck): VisibleCandidate {
  const { id, state, reason, finding } = check
  return {
    id, state, observation: check.observation.slice(0, 240), supportingIds: check.supportingIds.slice(0, 12),
    ...(reason === undefined ? {} : { reason: reason.slice(0, 180) }),
    finding: finding && {
      revisedObservation: finding.revisedObservation.slice(0, 240), supportingIds: finding.supportingIds.slice(0, 12),
      counterexampleIds: finding.counterexampleIds.slice(0, 12),
    },
    evidenceNotes: [],
  }
}

function mayRepair(error: unknown, used: number): boolean {
  return used < maxOutputRepairs && ['INVALID_INSIGHT_OUTPUT', 'MODEL_OUTPUT_LIMIT'].includes(String(codeOf(error)))
}

type SampleElapsed = () => { elapsedMs: number; sampledAtMs: number }

export async function generateInsight(input: InsightGenerationInput, deps: InsightGenerationDeps): Promise<InsightReport> {
  const clock = deps.now ?? Date.now
  const startedAtMs = clock()
  let sampledAtMs = startedAtMs
  // 状态提交和计时采样都可能晚于最后一个完整断点。
  const previousElapsedMs = Math.max(input.checkpoint?.elapsedMs ?? 0, input.elapsedMs ?? 0)
  const sampleElapsed: SampleElapsed = () => {
    sampledAtMs = Math.max(sampledAtMs, clock())
    return { elapsedMs: previousElapsedMs + sampledAtMs - startedAtMs, sampledAtMs }
  }
  const { saveElapsed } = deps
  if (!saveElapsed) return generateInsightReport(input, deps, sampleElapsed)

  let write: Promise<void> | undefined
  async function persist(operation: () => Promise<void>) {
    const pending = Promise.resolve(write).then(operation)
    write = pending
    try { await pending } finally { if (write === pending) write = undefined }
  }

  const timer = setInterval(() => {
    if (deps.signal.aborted || write) return
    const sample = sampleElapsed()
    void persist(async () => {
      try { await saveElapsed(sample.elapsedMs, sample.sampledAtMs) }
      catch { /* 下一次采样或完整断点会继续持久化用时。 */ }
    })
  }, elapsedPersistenceIntervalMs)
  timer.unref()
  try {
    return await generateInsightReport(input, {
      ...deps,
      saveCheckpoint: (state, time) => persist(() => deps.saveCheckpoint(state, time)),
    }, sampleElapsed)
  } finally {
    clearInterval(timer)
    await write
  }
}

async function generateInsightReport(input: InsightGenerationInput, deps: InsightGenerationDeps, sampleElapsed: SampleElapsed): Promise<InsightReport> {
  const { snapshot, model } = input
  let lastAccountedAt: number
  const state = input.checkpoint ? structuredClone(input.checkpoint)
    : createInsightCheckpoint(snapshot.taskId, model, { ...input.prompts }, { ...input.limits })
  if (state.version !== 1 || state.taskId !== snapshot.taskId || state.modelId !== model.id || state.modelVersion !== model.version
    || state.prompts.version !== INSIGHT_PROMPT_VERSION || state.attempts.length !== state.callsReserved) return invalidCheckpoint()
  const refs = new Map(snapshot.sources.map(ref => [ref.messageId, ref]))
  if (refs.size !== snapshot.sources.length || !refs.size) return invalidEvidence()
  const covered = new Set(state.coveredMessageIds)
  const capacity = resolveInsightCapacity(model)
  const ordinaryOutput = Math.min(capacity.maxOutputTokens, Math.max(1, Math.floor(state.limits.maxOutputTokens / 4)))
  const budgetError = (name: keyof InsightRunLimits) => new InsightBudgetError({ name, limit: state.limits[name] })
  const prompts = {
    reading: buildInsightPrompt(state.prompts, 'reading'),
    checking: buildInsightPrompt(state.prompts, 'checking'),
    writing: buildInsightPrompt(state.prompts, 'writing'),
    compressNavigation: buildInsightPrompt(state.prompts, 'reading', 'compress-navigation'),
  }

  function updateElapsed() {
    const sample = sampleElapsed()
    state.elapsedMs = sample.elapsedMs
    lastAccountedAt = sample.sampledAtMs
  }

  async function save() {
    updateElapsed()
    await deps.saveCheckpoint(state, lastAccountedAt)
  }

  async function checkActive() {
    updateElapsed()
    if (deps.signal.aborted || state.elapsedMs >= state.limits.maxElapsedMs) {
      await save()
      deps.signal.throwIfAborted()
      throw budgetError('maxElapsedMs')
    }
  }

  const crashed = state.attempts.at(-1)
  if (crashed?.status === 'pending') {
    // Preserve the request reservation without treating time outside the process as active work.
    crashed.status = 'unknown'
    await save()
  } else if (!input.checkpoint) {
    await save()
  }

  async function readFrozen(ids: readonly string[]): Promise<InsightSourceMessage[]> {
    const checkReading = state.report ? () => deps.signal.throwIfAborted() : checkActive
    await checkReading()
    if (ids.some(id => !refs.has(id))) return invalidEvidence()
    const results = await deps.read(ids)
    await checkReading()
    const requested = new Set(ids)
    const byId = new Map<string, InsightSourceMessage>()
    for (const message of results) {
      if (!requested.has(message.id) || byId.has(message.id) || message.revision !== refs.get(message.id)?.revision) return invalidEvidence()
      byId.set(message.id, message.replyToMessageId && !refs.has(message.replyToMessageId)
        ? { ...message, replyToMessageId: null } : message)
    }
    if (byId.size !== requested.size) return invalidEvidence()
    return ids.map(id => byId.get(id)!)
  }

  function runtimeInput(stage: InsightStage, payload: unknown, reservedOutput: number): RuntimeInput {
    const compressing = stage === 'reading' && (payload as { operation?: unknown }).operation === 'compress-navigation'
    return {
      key: ['insight', snapshot.taskId, state.callsReserved + 1].join(':'),
      model: { ...model, maxTokens: reservedOutput },
      outputTokenLimit: reservedOutput,
      thinkingLevel: input.thinkingLevel,
      systemPrompt: compressing ? prompts.compressNavigation : prompts[stage],
      prompt: JSON.stringify(payload),
      history: [],
    }
  }

  async function count(request: RuntimeInput): Promise<InsightInputCount> {
    await checkActive()
    const counted = await deps.countInput?.(request, request.model)
    if (counted && Number.isSafeInteger(counted.tokens) && counted.tokens > 0) return counted
    return countInsightInput(request, request.model)
  }

  const minimumWritingInput = async () => (await count(runtimeInput('writing', { stage: 'writing' }, ordinaryOutput))).tokens + capacity.margin

  async function requestCapacity(stage: InsightStage) {
    await checkActive()
    const remaining = remainingInsightBudget(state)
    const writing = stage === 'writing'
    if (remaining.calls <= (writing ? 0 : 1)) throw budgetError('maxCalls')
    const reservedOutput = writing ? Math.min(capacity.maxOutputTokens, remaining.outputTokens)
      : Math.min(ordinaryOutput, remaining.outputTokens - ordinaryOutput)
    const remainingInput = writing ? remaining.inputTokens : remaining.inputTokens - await minimumWritingInput()
    if (reservedOutput < 1) throw budgetError('maxOutputTokens')
    if (remainingInput < 1) throw budgetError('maxInputTokens')
    const contextInput = computeInsightInputBudget({
      contextWindow: capacity.contextWindow, maxInputTokens: capacity.maxInputTokens, reservedOutput, occupiedInput: 0, margin: capacity.margin,
    })
    if (contextInput < 1) throw insightCapacityError()
    return { availableTokens: Math.min(contextInput, remainingInput), reservedOutput, contextInput }
  }

  async function call(stage: InsightStage, payload: unknown, check?: InsightCheck): Promise<RuntimeResult> {
    const available = await requestCapacity(stage)
    const request = runtimeInput(stage, payload, available.reservedOutput)
    const inputCount = await count(request)
    if (inputCount.tokens > available.contextInput) throw insightCapacityError()
    if (inputCount.tokens > available.availableTokens) throw budgetError('maxInputTokens')
    await checkActive()
    if (check) check.rounds++
    const attempt: InsightAttempt = {
      stage, ...(check ? { checkId: check.id } : {}), input: inputCount, reservedOutput: available.reservedOutput,
      startedAtMs: lastAccountedAt, status: 'pending',
    }
    state.callsReserved++
    state.attempts.push(attempt)
    await save()
    const limitMs = Math.min(2 ** 31 - 1, Math.max(1, Math.ceil(state.limits.maxElapsedMs - state.elapsedMs)))
    const timeout = AbortSignal.timeout(limitMs)
    const signal = AbortSignal.any([deps.signal, timeout])
    let result: RuntimeResult
    try {
      await checkActive()
      result = await deps.run(request, { signal, onText: stage === 'writing' ? deps.onText : () => {} })
      attempt.usage = result.usage
      deps.signal.throwIfAborted()
      if (timeout.aborted) throw budgetError('maxElapsedMs')
    } catch (error) {
      attempt.status = 'failed'
      attempt.usage ??= (error as { usage?: AiUsage })?.usage
      await save()
      deps.signal.throwIfAborted()
      if (timeout.aborted) throw budgetError('maxElapsedMs')
      throw error
    }
    attempt.status = 'returned'
    await save()
    await checkActive()
    const remaining = remainingInsightBudget(state)
    if (remaining.inputTokens < 0) throw budgetError('maxInputTokens')
    if (remaining.outputTokens < 0) throw budgetError('maxOutputTokens')
    return result
  }

  const messages = await readFrozen(snapshot.sources.map(ref => ref.messageId))
  const byId = new Map(messages.map(message => [message.id, message]))
  const ordinal = new Map(messages.map((message, position) => [message.id, position]))
  const selfIds = new Set(messages.filter(message => message.isSelf).map(message => message.id))
  if (state.cursor.messageIndex < 0 || state.cursor.messageIndex > messages.length
    || state.cursor.textOffset < 0 || (state.cursor.textOffset > 0 && state.cursor.textOffset >= (messages[state.cursor.messageIndex]?.text.length ?? 0))
    || covered.size !== state.cursor.messageIndex || messages.slice(0, state.cursor.messageIndex).some(message => !covered.has(message.id))) {
    return invalidCheckpoint()
  }
  if (state.report) return state.report

  const readingPayload = (parts: InsightSourcePart[], repair = false) => ({
    stage: 'reading', timezone: snapshot.timezone, messages: parts, relatedMessages: [] as InsightSourceMessage[],
    observations: [] as InsightNote[], openThreads: [] as InsightNote[], knownCandidates: [] as VisibleCandidate[],
    relatedSourceIds: [] as string[], ...(repair ? { repair: true } : {}),
  })

  while (state.cursor.messageIndex < messages.length) {
    await checkActive()
    const budget = await requestCapacity('reading')
    const measure = async (payload: unknown) => (await count(runtimeInput('reading', payload, budget.reservedOutput))).tokens
    const spare = Math.max(0, budget.availableTokens - await measure(readingPayload([])))
    const candidateReserve = state.checks.length === 0 ? 0 : Math.floor(spare / 4)
    const memoryReserve = state.openThreads.length + state.observations.length === 0 ? 0 : Math.floor(spare / 5)
    if (!state.pendingRead) {
      const packed = await packInsightSources({
        messages, cursor: state.cursor, availableTokens: budget.availableTokens - candidateReserve - memoryReserve,
        count: text => measure(readingPayload(JSON.parse(text))),
      })
      state.pendingRead = { from: state.cursor, to: packed.nextCursor, depth: 0, repairs: 0 }
      await save()
    }
    const layout = state.pendingRead
    const batch = restoreInsightSources(messages, layout.from, layout.to)
    const payload = readingPayload(batch.messages, layout.repairs > 0)
    const baseCost = await measure(payload)
    const backgroundLimit = Math.min(budget.availableTokens, baseCost + Math.floor(budget.availableTokens / 4))
    const batchIds = new Set(payload.messages.map(message => message.id))
    const anchors = new Set([...batchIds, ...payload.messages.flatMap(({ replyToMessageId }) => replyToMessageId ? [replyToMessageId] : [])])
    const linked = (ids: readonly string[]) => ids.some(id => anchors.has(id))
    const candidates = [...state.checks].reverse().map(check => ({ check, linked: linked(candidateSources(check)) }))
      .sort((left, right) => Number(right.linked) - Number(left.linked)).slice(0, 12)
    const candidateLimit = Math.min(budget.availableTokens, baseCost + candidateReserve)
    for (const { check } of candidates) {
      const candidate = visibleCandidate(check)
      payload.knownCandidates.push(candidate)
      if (await measure(payload) > candidateLimit) {
        payload.knownCandidates.pop()
        continue
      }
      const notes = [...check.evidenceNotes].reverse().sort((left, right) => Number(anchors.has(right.sourceId)) - Number(anchors.has(left.sourceId)))
      for (const note of notes.slice(0, 4)) {
        candidate.evidenceNotes.push(evidenceFromSource(note, byId.get(note.sourceId)!))
        if (await measure(payload) > candidateLimit) candidate.evidenceNotes.pop()
      }
    }
    const rotate = <T>(items: T[]) => {
      const offset = items.length ? state.readLayouts.length % items.length : 0
      return [...items.slice(offset), ...items.slice(0, offset)]
    }
    const oldThreads = [...state.openThreads].sort((left, right) => Number(linked(right.sourceIds)) - Number(linked(left.sourceIds)))
    for (const note of oldThreads) {
      payload.openThreads.push(note)
      if (await measure(payload) > backgroundLimit) payload.openThreads.pop()
    }
    const oldFacts = rotate(state.observations).sort((left, right) => Number(linked(right.sourceIds)) - Number(linked(left.sourceIds)))
    for (const note of oldFacts) {
      payload.observations.push(note)
      if (await measure(payload) > backgroundLimit) payload.observations.pop()
    }
    const relevant = unique([
      ...payload.messages.flatMap(message => message.replyToMessageId ? [message.replyToMessageId] : []),
      ...state.openThreads.flatMap(note => note.sourceIds),
    ]).filter(id => covered.has(id) && !batchIds.has(id)).slice(0, maximumNotesPerBatch)
    for (const id of relevant) {
      payload.relatedMessages.push(byId.get(id)!)
      if (await measure(payload) > backgroundLimit) {
        payload.relatedMessages.pop()
        payload.relatedSourceIds.push(id)
        if (await measure(payload) > backgroundLimit) payload.relatedSourceIds.pop()
      }
    }
    payload.relatedMessages.sort((left, right) => ordinal.get(left.id)! - ordinal.get(right.id)!)
    let reading: ReadResult
    try {
      reading = parseReading(await call('reading', payload), [...payload.messages, ...payload.relatedMessages], payload.knownCandidates, payload.openThreads)
    } catch (error) {
      if (codeOf(error) === 'MODEL_CONTEXT_LIMIT' && layout.depth < maxShrinkDepth) {
        const to = shrinkInsightSources(messages, layout.from, layout.to)
        if (!to) throw insightCapacityError(true)
        state.pendingRead = { ...layout, to, depth: layout.depth + 1, repairs: 0 }
        await save()
        continue
      }
      if (mayRepair(error, layout.repairs) && remainingInsightBudget(state).calls > 1) {
        layout.repairs++
        await save()
        continue
      }
      if (codeOf(error) === 'MODEL_CONTEXT_LIMIT') throw insightCapacityError(true)
      throw error
    }
    for (const id of batch.completedMessageIds) {
      covered.add(id)
      state.coveredMessageIds.push(id)
    }
    state.observations = appendNotes(state.observations, reading.observations)
    const resolved = new Set(reading.resolvedThreadSourceIds)
    const visibleThreads = new Set(payload.openThreads)
    const rawIds = new Set([...payload.messages, ...payload.relatedMessages].map(message => message.id))
    const closableBySource = new Map<string, InsightNote[]>()
    for (const note of state.openThreads) {
      for (const id of new Set(note.sourceIds)) {
        if (resolved.has(id) && (rawIds.has(id) || visibleThreads.has(note))) {
          closableBySource.set(id, [...closableBySource.get(id) ?? [], note])
        }
      }
    }
    // 一个来源可能提及多个问题；编号不能唯一定位时留待事实协调。
    const closedThreads = new Set([...closableBySource.values()].filter(notes => notes.length === 1).flat())
    const unresolved = state.openThreads.filter(note => !closedThreads.has(note))
    state.openThreads = appendNotes(
      [...unresolved.filter(note => !visibleThreads.has(note)), ...unresolved.filter(note => visibleThreads.has(note))],
      reading.openThreads,
    )
    applyCandidateUpdates(state, reading.candidateUpdates, byId, covered)
    queueCandidates(state, reading.candidates, byId, covered)
    state.cursor = layout.to
    state.readLayouts.push({ from: layout.from, to: layout.to, depth: layout.depth })
    state.pendingRead = null
    await save()
  }

  if (state.navigation?.factsVersion !== 2) {
    // 旧导航可能已丢失来源；迁移从保存的逐批事实重建，沿用已用预算。
    const facts: InsightMemoryFact[] = [
      ...state.observations.map(note => ({ ...note, kind: 'fact' as const })),
      ...state.openThreads.map(note => ({ ...note, kind: 'unknown' as const })),
    ]
    const sourceOrder = new Map(snapshot.sources.map((source, index) => [source.messageId, index]))
    const firstSource = (fact: InsightMemoryFact) => Math.min(...fact.sourceIds.map(id => sourceOrder.get(id) ?? Infinity))
    // 让同源事实与未决事项有机会在同一有限窗口内协调。
    facts.sort((left, right) => firstSource(left) - firstSource(right)
      || (left.kind === right.kind ? 0 : left.kind === 'fact' ? -1 : 1))
    state.navigation = {
      nodes: facts.map(fact => ({ text: fact.text, sourceIds: fact.sourceIds, children: [], facts: [fact] })),
      roots: facts.map((_note, index) => index), cursor: 0, nextRoots: [], repairs: state.navigation?.repairs ?? 0, factsVersion: 2,
      reconciled: !state.openThreads.length || !state.observations.length,
    }
    for (const check of state.checks) {
      check.pendingNavigation = null
      check.navigationRequests = []
    }
    await save()
  }
  const navigation = state.navigation
  const writingFactsPayload = (facts: readonly InsightMemoryFact[], repair = false) => {
    return {
      stage: 'writing', timezone: snapshot.timezone, ...factNotes(facts),
      checks: state.checks.map(({ id, state: status, finding, observation }) => ({
        id, state: status, finding, ...(finding ? {} : { observation }),
      })), ...(repair ? { repair: true } : {}),
    }
  }
  const writingPayload = (roots: number[], repair = false) => writingFactsPayload(navigationFacts(navigation, roots), repair)
  const writingFactsSize = async (facts: readonly InsightMemoryFact[]) => {
    const budget = await requestCapacity('writing')
    return { tokens: (await count(runtimeInput('writing', writingFactsPayload(facts, state.writingRepairs > 0), budget.reservedOutput))).tokens,
      available: budget.availableTokens }
  }
  const writingSize = (roots: number[]) => writingFactsSize(navigationFacts(navigation, roots))
  const navigationSize = (roots: number[]) => Buffer.byteLength(JSON.stringify(navigationItems(navigation, roots)), 'utf8')
  const navigationBudget = Math.floor(computeInsightInputBudget({
    contextWindow: capacity.contextWindow, maxInputTokens: capacity.maxInputTokens,
    reservedOutput: ordinaryOutput, occupiedInput: 0, margin: capacity.margin,
  }) / 3)
  async function compactMemory() {
    while (true) {
      if (navigation.cursor === navigation.roots.length) {
        if (!navigation.roots.length) break
        const before = await writingSize(navigation.roots)
        const after = await writingSize(navigation.nextRoots)
        const reconciled = navigation.reconciled || navigation.nextRoots.length === 1
        if ((navigation.reconciled || !reconciled) && after.tokens >= before.tokens
          && navigationSize(navigation.nextRoots) >= navigationSize(navigation.roots)) throw insightCapacityError()
        navigation.roots = navigation.nextRoots
        navigation.nextRoots = []
        navigation.cursor = 0
        navigation.reconciled = reconciled
        await save()
      }
      const writing = await writingSize(navigation.roots)
      if (navigation.cursor === 0 && navigation.reconciled && writing.tokens <= writing.available
        && navigationSize(navigation.roots) <= navigationBudget) break
      const budget = await requestCapacity('reading')
      const children: number[] = []
      let payload = compressionPayload([], navigation.repairs > 0)
      for (const child of navigation.roots.slice(navigation.cursor)) {
        const candidate = compressionPayload(compressionNodes(navigation, [...children, child]), navigation.repairs > 0)
        if ((await count(runtimeInput('reading', candidate, budget.reservedOutput))).tokens > budget.availableTokens) break
        children.push(child)
        payload = candidate
      }
      if (!children.length) throw insightCapacityError()
      const isTrailingShortNote = children.length === 1 && navigation.roots.length > 1
        && navigation.cursor === navigation.roots.length - 1 && navigationSize(children) < navigationBudget
      if (isTrailingShortNote) {
        navigation.nextRoots.push(children[0])
      } else {
        try {
          const body = outputObject(await call('reading', payload))
          const facts = parseInsightCompressedFacts(body.facts, compressionNodes(navigation, children))
          if (factBytes(facts) >= factBytes(navigationFacts(navigation, children))) {
            const combined = [...navigationFacts(navigation, navigation.nextRoots), ...facts,
              ...navigationFacts(navigation, navigation.roots.slice(navigation.cursor + children.length))]
            const reconciled = navigation.reconciled || (navigation.cursor === 0 && children.length === navigation.roots.length)
            const writing = await writingFactsSize(combined)
            if (!reconciled || writing.tokens > writing.available) return invalidOutput()
          }
          const summary = { text: string(body.text, 720), sourceIds: unique(facts.flatMap(fact => fact.sourceIds)), children, facts }
          navigation.nextRoots.push(navigation.nodes.length)
          navigation.nodes.push(summary)
        } catch (error) {
          if (mayRepair(error, navigation.repairs) && remainingInsightBudget(state).calls > 1) {
            navigation.repairs++
            await save()
            continue
          }
          throw error
        }
      }
      navigation.cursor += children.length
      navigation.repairs = 0
      await save()
    }
  }
  await compactMemory()
  const observations = navigationItems(navigation, navigation.roots)

  if (state.stage === 'reading') {
    state.stage = 'checking'
    await save()
  }
  for (const check of state.checks) {
    let evidence: InsightSourceMessage[] = []
    while (check.state === 'pending') {
      if (check.rounds >= state.limits.maxRoundsPerCheck) throw budgetError('maxRoundsPerCheck')
      const budget = await requestCapacity('checking')
      const noted = new Set(check.evidenceNotes.map(note => note.sourceId))
      const earlierEvidence = check.seenEvidenceIds.filter(id => !noted.has(id)).map(id => byId.get(id)!)
      const evidenceNotes = check.evidenceNotes.map(note => evidenceFromSource(note, byId.get(note.sourceId)!))
      const checkPayload = (parts: InsightSourcePart[], hasMoreEvidence = false) => ({
        stage: 'checking', timezone: snapshot.timezone,
        check: { id: check.id, round: check.rounds + 1, observation: check.observation, purpose: check.purpose, supportingIds: check.supportingIds },
        evidence: parts, earlierEvidence, evidenceNotes, hasMoreEvidence,
        observations, navigationPage: null as NavigationPage | null, ...(check.repairs ? { repair: true } : {}),
      })
      const measure = async (payload: unknown) => (await count(runtimeInput('checking', payload, budget.reservedOutput))).tokens
      if (!evidence.length) evidence = await readFrozen(check.pendingIds)
      if (!check.pendingThrough && !check.pendingNavigation) {
        const packed = await packInsightSources({
          messages: evidence, cursor: check.pendingCursor, availableTokens: budget.availableTokens,
          count: text => measure(checkPayload(JSON.parse(text))),
        })
        check.pendingThrough = packed.nextCursor
        await save()
      }
      const batch = check.pendingThrough
        ? restoreInsightSources(evidence, check.pendingCursor, check.pendingThrough)
        : { messages: [], completedMessageIds: [], nextCursor: check.pendingCursor }
      const stillUnread = batch.nextCursor.messageIndex < check.pendingIds.length
      const payload = checkPayload(batch.messages, stillUnread)
      const seen = new Set([...check.seenEvidenceIds, ...batch.completedMessageIds])
      const supported = new Set([...seen, ...noted])
      if (check.pendingNavigation) {
        const { id, offset } = check.pendingNavigation
        const children = navigation.nodes[id].children
        const page: NavigationPage = { id, nodes: [], nextOffset: offset }
        payload.navigationPage = page
        for (const child of children.slice(offset)) {
          page.nodes.push(...navigationItems(navigation, [child]))
          page.nextOffset = offset + page.nodes.length < children.length ? offset + page.nodes.length : null
          if (await measure(payload) > budget.availableTokens) {
            page.nodes.pop()
            page.nextOffset = offset + page.nodes.length
            break
          }
        }
        if (!page.nodes.length) throw insightCapacityError()
      }
      let action: CheckResult
      try {
        action = parseChecking(
          await call('checking', payload, check), check.id, covered, supported, stillUnread, payload.evidence,
          [...payload.observations, ...payload.navigationPage?.nodes ?? []], payload.navigationPage, payload.evidenceNotes,
        )
      } catch (error) {
        if (codeOf(error) === 'MODEL_CONTEXT_LIMIT') {
          const smaller = check.pendingThrough && check.shrinkDepth < maxShrinkDepth
            && shrinkInsightSources(evidence, check.pendingCursor, check.pendingThrough)
          if (!smaller) throw insightCapacityError(true)
          check.pendingThrough = smaller
          check.shrinkDepth++
          await save()
          continue
        }
        if (mayRepair(error, check.repairs) && check.rounds < state.limits.maxRoundsPerCheck && remainingInsightBudget(state).calls > 1) {
          check.repairs++
          await save()
          continue
        }
        throw error
      }
      check.repairs = 0
      check.shrinkDepth = 0
      check.pendingThrough = null
      check.pendingNavigation = null
      check.seenEvidenceIds = [...seen]
      check.pendingCursor = batch.nextCursor
      if (action.action === 'finish') {
        check.state = 'finished'
        check.finding = action.finding
      } else if (action.action === 'navigate') {
        const duplicate = check.navigationRequests.some(request => request.id === action.navigation.id && request.offset === action.navigation.offset)
        if (duplicate && !stillUnread) check.state = 'inconclusive'
        if (!duplicate) {
          check.navigationRequests.push(action.navigation)
          check.pendingNavigation = action.navigation
        }
      } else {
        const queued = check.pendingIds.slice(check.pendingCursor.messageIndex)
        const fullSourceIds = new Set([...payload.evidence.filter(part => !part.fragment), ...payload.earlierEvidence].map(part => part.id))
        const newIds = action.messageIds.filter(id => !fullSourceIds.has(id) && !queued.includes(id))
        if (newIds.length) {
          check.pendingIds = [...queued, ...newIds]
          check.pendingCursor = { messageIndex: 0, textOffset: check.pendingCursor.textOffset }
          evidence = []
        }
        check.purpose = action.purpose
        if (!newIds.length && !stillUnread) check.state = 'inconclusive'
      }
      if (action.action !== 'finish') appendEvidenceNotes(check, action.evidenceNotes)
      await save()
    }
  }

  state.stage = 'writing'
  await save()
  for (;;) {
    await compactMemory()
    const payload = writingPayload(navigation.roots, state.writingRepairs > 0)
    const checkedEvidence = new Set(state.checks.flatMap(check => check.finding
      ? [...check.finding.supportingIds, ...check.finding.counterexampleIds] : []))
    const writtenNotes = [...payload.observations, ...payload.openThreads]
    const writtenEvidence = new Set([...checkedEvidence, ...writtenNotes.flatMap(note => note.sourceIds)])
    const response = await call('writing', payload)
    let report: InsightReport
    try {
      report = parseReport(response, input.conversationId, refs, writtenEvidence, selfIds, state.checks)
    } catch (error) {
      if (mayRepair(error, state.writingRepairs) && remainingInsightBudget(state).calls > 0) {
        state.writingRepairs++
        await save()
        continue
      }
      throw error
    }
    state.report = report
    await save()
    return report
  }
}
