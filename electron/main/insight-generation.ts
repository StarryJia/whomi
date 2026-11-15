import type { AiModel, AiUsage } from '../../src/shared/ai-contract'
import type {
  InsightCitation, InsightInline, InsightJudgment, InsightParagraph, InsightReport, InsightSnapshot, InsightSourceMessage, InsightSourceRef,
} from '../../src/shared/conversation-insights'
import { BoundaryError } from '../../src/shared/desktop-validation'
import { dimensionKeys } from '../../src/shared/memory'
import { buildInsightPrompt, INSIGHT_PROMPT_VERSION, type InsightPrompts } from '../data/ai/insight-prompts'
import type { RuntimeInput, RuntimeResult, RuntimeRunner } from './ai-service'
import {
  createInsightCheckpoint, insightBudgetError, remainingInsightBudget, startingInsightCursor,
  type InsightAttempt, type InsightCandidate, type InsightCheck, type InsightCheckpoint, type InsightEvidenceNote,
  type InsightFinding, type InsightNavigation, type InsightNavigationRequest, type InsightNote, type InsightRunLimits, type InsightStage,
} from './insight-checkpoint'
import {
  computeInsightInputBudget, countInsightInput, insightCapacityError, packInsightSources, resolveInsightCapacity,
  restoreInsightSources, shrinkInsightSources, type InsightInputCount, type InsightSourcePart,
} from './insight-packing'

const maxShrinkDepth = 8
const maxOutputRepairs = 1
const maximumNotesPerBatch = 48

export type InsightGenerationDeps = {
  run: RuntimeRunner['run']
  read: (ids: readonly string[]) => Promise<InsightSourceMessage[]>
  saveCheckpoint: (state: InsightCheckpoint) => Promise<void>
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
  thinkingLevel?: RuntimeInput['thinkingLevel']
}

type ReadResult = { observations: InsightNote[]; openThreads: InsightNote[]; candidates: InsightCandidate[]; resolvedThreadSourceIds: string[] }
type VisibleNavigation = InsightNote & { navigationId: number; childCount: number }
type NavigationPage = { id: number; nodes: VisibleNavigation[]; nextOffset: number | null }
type CheckResult =
  | { action: 'read'; messageIds: string[]; purpose: string; evidenceNotes: InsightEvidenceNote[] }
  | { action: 'navigate'; navigation: InsightNavigationRequest; evidenceNotes: InsightEvidenceNote[] }
  | { action: 'finish'; finding: InsightFinding }

function navigationItems(navigation: InsightNavigation, ids: readonly number[]): VisibleNavigation[] {
  return ids.map(navigationId => {
    const { children, ...note } = navigation.nodes[navigationId]
    return { ...note, navigationId, childCount: children.length }
  })
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

function parseReading(response: RuntimeResult, allowedIds: ReadonlySet<string>): ReadResult {
  const body = outputObject(response)
  const parseNote = (value: unknown) => {
    const note = object(value)
    return { text: string(note.text, 1200), sourceIds: sourceIds(note.sourceIds, allowedIds, true) }
  }
  return {
    observations: array(body.observations, maximumNotesPerBatch, parseNote),
    openThreads: array(body.openThreads, maximumNotesPerBatch, parseNote),
    candidates: array(body.candidates, maximumNotesPerBatch, value => {
      const candidate = object(value)
      return { observation: string(candidate.observation, 1200), supportingIds: sourceIds(candidate.supportingIds, allowedIds, true) }
    }),
    resolvedThreadSourceIds: body.resolvedThreadSourceIds === undefined ? [] : sourceIds(body.resolvedThreadSourceIds, allowedIds),
  }
}

function parseChecking(
  response: RuntimeResult, checkId: string, covered: ReadonlySet<string>, evidence: ReadonlySet<string>, hasMoreEvidence: boolean,
  currentEvidence: readonly InsightSourcePart[], visibleNavigation: readonly VisibleNavigation[], navigationPage: NavigationPage | null,
): CheckResult {
  const body = outputObject(response)
  if (body.checkId !== checkId) return invalidOutput()
  if (body.action === 'read' || body.action === 'navigate') {
    const evidenceNotes = array(body.evidenceNotes ?? [], 24, value => {
      const note = object(value)
      const sourceId = string(note.sourceId, 256)
      const quote = string(note.quote, 240)
      if (!currentEvidence.some(part => part.id === sourceId && part.text.includes(quote))) return invalidEvidence()
      return { sourceId, quote, text: string(note.text, 480) }
    })
    if (currentEvidence.some(part => part.fragment && !evidenceNotes.some(note => note.sourceId === part.id))) return invalidOutput()
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
  const supportingIds = sourceIds(body.supportingIds, evidence)
  const counterexampleIds = sourceIds(body.counterexampleIds, evidence)
  if (supportingIds.some(id => counterexampleIds.includes(id))) return invalidEvidence()
  return {
    action: 'finish',
    finding: {
      revisedObservation: string(body.revisedObservation, 3000), supportingIds, counterexampleIds,
      alternativeExplanations: explanations(body.alternativeExplanations ?? []), limitations: explanations(body.limitations),
    },
  }
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

function queueCandidates(state: InsightCheckpoint, candidates: InsightCandidate[], messages: ReadonlyMap<string, InsightSourceMessage>, covered: ReadonlySet<string>) {
  for (const candidate of candidates) {
    if (state.checks.length >= state.limits.maxChecks) break
    const normalized = candidate.observation.trim().replace(/\s+/g, '').toLowerCase()
    if (state.checks.some(check => check.observation.trim().replace(/\s+/g, '').toLowerCase() === normalized
      || (check.supportingIds.length === candidate.supportingIds.length && check.supportingIds.every(id => candidate.supportingIds.includes(id))))) continue
    const pendingIds = unique(candidate.supportingIds.flatMap(id => {
      const reply = messages.get(id)?.replyToMessageId
      return reply && covered.has(reply) ? [reply, id] : [id]
    }))
    state.checks.push({
      ...candidate, id: String(state.checks.length + 1), state: 'pending', rounds: 0, seenEvidenceIds: [],
      evidenceNotes: [], navigationRequests: [], pendingNavigation: null,
      pendingIds, pendingCursor: startingInsightCursor, pendingThrough: null, shrinkDepth: 0, repairs: 0,
      purpose: null, finding: null,
    })
  }
}

function mayRepair(error: unknown, used: number): boolean {
  return used < maxOutputRepairs && ['INVALID_INSIGHT_OUTPUT', 'MODEL_OUTPUT_LIMIT'].includes(String(codeOf(error)))
}

export async function generateInsight(input: InsightGenerationInput, deps: InsightGenerationDeps): Promise<InsightReport> {
  const { snapshot, model } = input
  const clock = deps.now ?? Date.now
  let lastAccountedAt = clock()
  const state = input.checkpoint ? structuredClone(input.checkpoint)
    : createInsightCheckpoint(snapshot.taskId, model, { ...input.prompts }, { ...input.limits })
  if (state.version !== 1 || state.taskId !== snapshot.taskId || state.modelId !== model.id || state.modelVersion !== model.version
    || state.prompts.version !== INSIGHT_PROMPT_VERSION || state.attempts.length !== state.callsReserved) return invalidCheckpoint()
  const refs = new Map(snapshot.sources.map(ref => [ref.messageId, ref]))
  if (refs.size !== snapshot.sources.length || !refs.size) return invalidEvidence()
  const covered = new Set(state.coveredMessageIds)
  const capacity = resolveInsightCapacity(model)
  const ordinaryOutput = Math.min(capacity.maxOutputTokens, Math.max(1, Math.floor(state.limits.maxOutputTokens / 4)))
  const prompts = {
    reading: buildInsightPrompt(state.prompts, 'reading'),
    checking: buildInsightPrompt(state.prompts, 'checking'),
    writing: buildInsightPrompt(state.prompts, 'writing'),
    compressNavigation: buildInsightPrompt(state.prompts, 'reading', 'compress-navigation'),
  }

  function updateElapsed() {
    const now = clock()
    state.elapsedMs += Math.max(0, now - lastAccountedAt)
    lastAccountedAt = now
  }

  async function save() {
    updateElapsed()
    await deps.saveCheckpoint(state)
  }

  async function checkActive() {
    updateElapsed()
    if (deps.signal.aborted || state.elapsedMs >= state.limits.maxElapsedMs) {
      await save()
      deps.signal.throwIfAborted()
      throw insightBudgetError()
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
    await checkActive()
    if (ids.some(id => !refs.has(id))) return invalidEvidence()
    const results = await deps.read(ids)
    await checkActive()
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
    if (remaining.calls <= (writing ? 0 : 1)) throw insightBudgetError()
    const reservedOutput = writing ? Math.min(capacity.maxOutputTokens, remaining.outputTokens)
      : Math.min(ordinaryOutput, remaining.outputTokens - ordinaryOutput)
    const remainingInput = writing ? remaining.inputTokens : remaining.inputTokens - await minimumWritingInput()
    if (reservedOutput < 1 || remainingInput < 1) throw insightBudgetError()
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
    if (inputCount.tokens > available.availableTokens) throw insightBudgetError()
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
      if (timeout.aborted) throw insightBudgetError()
    } catch (error) {
      attempt.status = 'failed'
      attempt.usage ??= (error as { usage?: AiUsage })?.usage
      await save()
      deps.signal.throwIfAborted()
      if (timeout.aborted) throw insightBudgetError()
      throw error
    }
    attempt.status = 'returned'
    await save()
    await checkActive()
    const remaining = remainingInsightBudget(state)
    if (remaining.inputTokens < 0 || remaining.outputTokens < 0) throw insightBudgetError()
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
    observations: [] as InsightNote[], openThreads: [] as InsightNote[], knownCandidates: [] as InsightCandidate[],
    relatedSourceIds: [] as string[], ...(repair ? { repair: true } : {}),
  })

  while (state.cursor.messageIndex < messages.length) {
    await checkActive()
    const budget = await requestCapacity('reading')
    const measure = async (payload: unknown) => (await count(runtimeInput('reading', payload, budget.reservedOutput))).tokens
    if (!state.pendingRead) {
      const packed = await packInsightSources({
        messages, cursor: state.cursor, availableTokens: budget.availableTokens,
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
    for (const note of state.openThreads.slice(-12)) {
      payload.openThreads.push(note)
      if (await measure(payload) > backgroundLimit) payload.openThreads.pop()
    }
    for (const note of state.observations.slice(-12)) {
      payload.observations.push(note)
      if (await measure(payload) > backgroundLimit) payload.observations.pop()
    }
    for (const { observation, supportingIds } of state.checks.slice(-12)) {
      payload.knownCandidates.push({ observation, supportingIds })
      if (await measure(payload) > backgroundLimit) payload.knownCandidates.pop()
    }
    let reading: ReadResult
    try {
      const allowedIds = new Set([...batchIds, ...payload.relatedMessages.map(message => message.id)])
      reading = parseReading(await call('reading', payload), allowedIds)
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
    state.openThreads = appendNotes(
      state.openThreads.filter(note => !note.sourceIds.some(id => resolved.has(id))), reading.openThreads,
    ).slice(-maximumNotesPerBatch)
    queueCandidates(state, reading.candidates, byId, covered)
    state.cursor = layout.to
    state.readLayouts.push({ from: layout.from, to: layout.to, depth: layout.depth })
    state.pendingRead = null
    await save()
  }

  if (!state.navigation) {
    state.navigation = {
      nodes: state.observations.map(note => ({ ...note, children: [] })),
      roots: state.observations.map((_note, index) => index), cursor: 0, nextRoots: [], repairs: 0,
    }
    await save()
  }
  const navigation = state.navigation
  const navigationSize = (roots: number[]) => Buffer.byteLength(JSON.stringify(navigationItems(navigation, roots)), 'utf8')
  const navigationBudget = Math.floor(computeInsightInputBudget({
    contextWindow: capacity.contextWindow, maxInputTokens: capacity.maxInputTokens,
    reservedOutput: ordinaryOutput, occupiedInput: 0, margin: capacity.margin,
  }) / 3)
  while (navigationSize(navigation.roots) > navigationBudget) {
    if (navigation.cursor === navigation.roots.length) {
      if (navigationSize(navigation.nextRoots) >= navigationSize(navigation.roots)) throw insightCapacityError()
      navigation.roots = navigation.nextRoots
      navigation.nextRoots = []
      navigation.cursor = 0
      await save()
      continue
    }
    const budget = await requestCapacity('reading')
    const children: number[] = []
    const payload = {
      stage: 'reading', operation: 'compress-navigation', nodes: [] as VisibleNavigation[],
      ...(navigation.repairs ? { repair: true } : {}),
    }
    for (const child of navigation.roots.slice(navigation.cursor)) {
      payload.nodes.push(...navigationItems(navigation, [child]))
      if ((await count(runtimeInput('reading', payload, budget.reservedOutput))).tokens > budget.availableTokens) {
        payload.nodes.pop()
        break
      }
      children.push(child)
    }
    if (!children.length) throw insightCapacityError()
    const isTrailingShortNote = children.length === 1 && navigation.roots.length > 1
      && navigation.cursor === navigation.roots.length - 1 && navigationSize(children) < navigationBudget
    if (isTrailingShortNote) {
      navigation.nextRoots.push(children[0])
    } else {
      try {
        const body = outputObject(await call('reading', payload))
        const allowed = new Set(payload.nodes.flatMap(note => note.sourceIds))
        const summary = { text: string(body.text, 720), sourceIds: sourceIds(body.sourceIds, allowed), children }
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
  const observations = navigationItems(navigation, navigation.roots)

  if (state.stage === 'reading') {
    state.stage = 'checking'
    await save()
  }
  for (const check of state.checks) {
    let evidence: InsightSourceMessage[] = []
    while (check.state === 'pending') {
      if (check.rounds >= state.limits.maxRoundsPerCheck) throw insightBudgetError()
      const budget = await requestCapacity('checking')
      const noted = new Set(check.evidenceNotes.map(note => note.sourceId))
      const earlierEvidence = check.seenEvidenceIds.filter(id => !noted.has(id)).map(id => byId.get(id)!)
      const evidenceNotes = check.evidenceNotes.map(note => {
        const { sentAtMs, senderName, isSelf, replyToMessageId } = byId.get(note.sourceId)!
        return { ...note, sentAtMs, senderName, isSelf, replyToMessageId }
      })
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
      const supported = new Set([...check.seenEvidenceIds, ...batch.completedMessageIds])
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
          [...payload.observations, ...payload.navigationPage?.nodes ?? []], payload.navigationPage,
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
      check.seenEvidenceIds = [...supported]
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
        const newIds = action.messageIds.filter(id => !supported.has(id) && !queued.includes(id))
        if (newIds.length) {
          const read = await readFrozen(newIds)
          check.pendingIds.push(...newIds)
          evidence.push(...read)
        }
        check.purpose = action.purpose
        if (!newIds.length && !stillUnread) check.state = 'inconclusive'
      }
      if (action.action !== 'finish') {
        for (const note of action.evidenceNotes) {
          if (!check.evidenceNotes.some(prior => prior.sourceId === note.sourceId && prior.quote === note.quote && prior.text === note.text)) {
            check.evidenceNotes.push(note)
          }
        }
      }
      await save()
    }
  }

  state.stage = 'writing'
  await save()
  for (;;) {
    const budget = await requestCapacity('writing')
    const payload = {
      stage: 'writing', timezone: snapshot.timezone, observations, openThreads: [] as InsightNote[],
      checks: state.checks.map(({ id, state: status, finding, observation }) => ({ id, state: status, finding, observation })),
      ...(state.writingRepairs ? { repair: true } : {}),
    }
    const measure = async () => (await count(runtimeInput('writing', payload, budget.reservedOutput))).tokens
    const checkedEvidence = new Set(state.checks.flatMap(check => check.finding
      ? [...check.finding.supportingIds, ...check.finding.counterexampleIds] : []))
    for (const note of state.openThreads.slice(-maximumNotesPerBatch)) {
      payload.openThreads.push(note)
      if (await measure() > budget.availableTokens) payload.openThreads.pop()
    }
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
