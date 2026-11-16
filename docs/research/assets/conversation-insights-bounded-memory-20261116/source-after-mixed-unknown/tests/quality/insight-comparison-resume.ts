import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { InsightCheckpoint, InsightRunLimits } from '../../electron/main/insight-checkpoint'
import type { InsightCursor } from '../../electron/main/insight-packing'

export type ComparisonCharge = { httpRequests: number; inputCharged: number; outputCharged: number; elapsedMs: number }
export type ComparisonPhaseResult = ComparisonCharge & { state: string; error?: string; calls: number }
export const archivedReadingHaltName = 'halt-before-resume.json'
export const readingPhases = ['reading', 'reading-resume', 'reading-resume-2'] as const

export function readingChainPhases(output: string, caseName: string, resumeOrdinal = 0) {
  const phases = readingPhases.filter(phase => existsSync(join(output, caseName + '-' + phase)))
  if (!phases.length || phases.some((phase, index) => phase !== readingPhases[index])
    || resumeOrdinal && (resumeOrdinal > 2 || phases.length !== resumeOrdinal)) return invalidResume()
  return phases
}

export function sumComparisonCharges(first: ComparisonCharge, second: ComparisonCharge): ComparisonCharge {
  return {
    httpRequests: first.httpRequests + second.httpRequests,
    inputCharged: first.inputCharged + second.inputCharged,
    outputCharged: first.outputCharged + second.outputCharged,
    elapsedMs: first.elapsedMs + second.elapsedMs,
  }
}

function invalidResume(): never {
  const code = 'INVALID_COMPARISON_READING_RESUME'
  throw Object.assign(new Error(code), { code })
}

function equal(first: unknown, second: unknown) {
  return JSON.stringify(first) === JSON.stringify(second)
}

function validCursor(cursor: InsightCursor, sourceCount: number) {
  return Number.isSafeInteger(cursor.messageIndex) && cursor.messageIndex >= 0 && cursor.messageIndex <= sourceCount
    && Number.isSafeInteger(cursor.textOffset) && cursor.textOffset >= 0 && (cursor.messageIndex < sourceCount || cursor.textOffset === 0)
}

function validCompressionNavigation(checkpoint: InsightCheckpoint, sourceIds: string[]) {
  const navigation = checkpoint.navigation
  if (!navigation || navigation.factsVersion !== 1 || typeof navigation.reconciled !== 'boolean'
    || !Array.isArray(navigation.nodes) || !navigation.nodes.length || !Array.isArray(navigation.roots) || !navigation.roots.length
    || !Array.isArray(navigation.nextRoots) || !Number.isSafeInteger(navigation.cursor)
    || navigation.cursor < 0 || navigation.cursor >= navigation.roots.length || ![0, 1].includes(navigation.repairs)
    || !Array.isArray(checkpoint.observations) || !Array.isArray(checkpoint.openThreads)) return false
  const originals = [
    ...checkpoint.observations.map(note => ({ ...note, kind: 'fact' })),
    ...checkpoint.openThreads.map(note => ({ ...note, kind: 'unknown' })),
  ]
  const allowed = new Set(sourceIds)
  const validSources = (ids: string[]) => Array.isArray(ids) && ids.length > 0
    && new Set(ids).size === ids.length && ids.every(id => allowed.has(id))
  const validIds = (ids: number[], before: number) => Array.isArray(ids) && new Set(ids).size === ids.length
    && ids.every(id => Number.isSafeInteger(id) && id >= 0 && id < before)
  const sorted = (ids: string[]) => [...new Set(ids)].sort()
  const leaves: number[][] = []
  for (const [id, node] of navigation.nodes.entries()) {
    if (!node || typeof node.text !== 'string' || !node.text.trim() || !validSources(node.sourceIds)
      || !validIds(node.children, id) || !Array.isArray(node.facts) || !node.facts.length
      || node.facts.some(fact => !fact || !['fact', 'unknown'].includes(fact.kind)
        || typeof fact.text !== 'string' || !fact.text.trim() || !validSources(fact.sourceIds))
      || !equal(sorted(node.sourceIds), sorted(node.facts.flatMap(fact => fact.sourceIds)))) return false
    if (id < originals.length) {
      const original = originals[id]
      if (node.children.length || node.facts.length !== 1 || node.facts[0].kind !== original.kind
        || node.facts[0].text !== original.text || !equal(node.facts[0].sourceIds, original.sourceIds) || node.text !== original.text) return false
      leaves.push([id])
    } else {
      if (!node.children.length || !equal(sorted(node.sourceIds), sorted(node.children.flatMap(child => navigation.nodes[child].sourceIds)))) return false
      const descendants = node.children.flatMap(child => leaves[child])
      if (new Set(descendants).size !== descendants.length) return false
      leaves.push(descendants)
    }
  }
  if (!originals.length || !validIds(navigation.roots, navigation.nodes.length) || !validIds(navigation.nextRoots, navigation.nodes.length)) return false
  const covered = navigation.roots.flatMap(id => leaves[id]).sort((a, b) => a - b)
  if (!equal(covered, originals.map((_note, index) => index))) return false
  // 已压缩前缀与待续节点必须覆盖同一批原始叶笔记。
  const completed = navigation.roots.slice(0, navigation.cursor).flatMap(id => leaves[id]).sort((a, b) => a - b)
  return equal(navigation.nextRoots.flatMap(id => leaves[id]).sort((a, b) => a - b), completed)
}

export function assertReadingRecoverySettled(output: string, caseNames: string[], resumeCase?: string) {
  for (const caseName of caseNames) {
    if (caseName === resumeCase || !readingPhases.some(phase => existsSync(join(output, caseName + '-' + phase, archivedReadingHaltName)))) continue
    const phase = readingChainPhases(output, caseName).at(-1)!
    const recovered = join(output, caseName + '-' + phase, 'result.json')
    if (!existsSync(recovered) || JSON.parse(readFileSync(recovered, 'utf8')).state !== 'completed') {
      throw Object.assign(new Error('TRIAL_HALTED'), { code: 'TRIAL_HALTED' })
    }
  }
}

export function validateReadingResume(input: {
  caseName: string
  originalResult: ComparisonPhaseResult
  archivedHalt: ComparisonPhaseResult & { caseName: string; variant: string }
  checkpoint: InsightCheckpoint
  expectedLimits: InsightRunLimits
  sourceIds: string[]
  ledger: string
  priorCheckpoint?: InsightCheckpoint
}) {
  const { caseName, originalResult, archivedHalt, checkpoint, expectedLimits, sourceIds, ledger, priorCheckpoint } = input
  const priorCalls = priorCheckpoint?.callsReserved ?? 0
  const { caseName: haltedCase, variant: haltedPhase, ...halted } = archivedHalt
  if (haltedCase !== caseName || haltedPhase !== 'reading' || originalResult.state !== 'failed' || originalResult.error !== 'INVALID_EVIDENCE'
    || !equal(halted, originalResult)) return invalidResume()

  const { cursor, pendingRead, callsReserved, attempts, checks } = checkpoint
  const compressing = checkpoint.navigation !== null
  const resumablePosition = compressing
    ? pendingRead === null && cursor.messageIndex === sourceIds.length && cursor.textOffset === 0
      && validCompressionNavigation(checkpoint, sourceIds)
    : pendingRead && equal(pendingRead.from, cursor) && validCursor(pendingRead.to, sourceIds.length)
      && (pendingRead.to.messageIndex > cursor.messageIndex
        || pendingRead.to.messageIndex === cursor.messageIndex && pendingRead.to.textOffset > cursor.textOffset)
  if (checkpoint.stage !== 'reading' || checkpoint.report !== null || checkpoint.writingRepairs !== 0
    || !equal(checkpoint.limits, expectedLimits) || !validCursor(cursor, sourceIds.length) || !resumablePosition
    || !equal(checkpoint.coveredMessageIds, sourceIds.slice(0, cursor.messageIndex))
    || checks.some(check => check.rounds > 0)
    || callsReserved !== priorCalls + originalResult.calls || callsReserved !== attempts.length || attempts.at(-1)?.status !== 'returned'
    || priorCheckpoint && !equal(attempts.slice(0, priorCalls), priorCheckpoint.attempts)
    || attempts.some(attempt => attempt.stage !== 'reading' || !['returned', 'failed'].includes(attempt.status))) return invalidResume()

  const reserved: number[] = []
  const dispatched = new Set<number>()
  let lastReservedStage: string | undefined
  let compressionStarted = false
  for (const line of ledger.split('\n').filter(Boolean)) {
    const { kind, stage, call } = JSON.parse(line)
    if (kind === 'reserved') {
      if (stage === 'compress-navigation' && compressing) compressionStarted = true
      else if (stage !== 'reading' || compressionStarted) return invalidResume()
      if (call !== reserved.length + 1) return invalidResume()
      reserved.push(call)
      lastReservedStage = stage
    }
    if (kind === 'dispatched') {
      if (!reserved.includes(call) || dispatched.has(call)) return invalidResume()
      dispatched.add(call)
    }
  }
  if (lastReservedStage !== (compressing ? 'compress-navigation' : 'reading')
    || reserved.length !== originalResult.calls || !dispatched.has(originalResult.calls) || dispatched.size !== originalResult.httpRequests
    || ![originalResult.elapsedMs, originalResult.inputCharged, originalResult.outputCharged]
      .every(value => Number.isSafeInteger(value) && value >= 0)) return invalidResume()
}

export type ReadingChainPhase = {
  phase: string; result: ComparisonPhaseResult; checkpoint: InsightCheckpoint; input: Record<string, unknown>
  snapshot: { taskId: string; createdAtMs: number }; ledger: string
  archivedHalt?: ComparisonPhaseResult & { caseName: string; variant: string }
}

export function validateReadingChain(phases: ReadingChainPhase[], expected: {
  caseName: string; expectedInput: Record<string, unknown>; expectedSnapshot: { taskId: string; createdAtMs: number }
  modelVersion: number; prompts: InsightCheckpoint['prompts']; expectedLimits: InsightRunLimits; sourceIds: string[]; resuming: boolean
}): ComparisonCharge {
  if (!phases.length || phases.length > (expected.resuming ? 2 : 3)) return invalidResume()
  let charges: ComparisonCharge = { httpRequests: 0, inputCharged: 0, outputCharged: 0, elapsedMs: 0 }
  let previous: ReadingChainPhase | undefined
  for (const [index, phase] of phases.entries()) {
    const { checkpoint, result, input, snapshot } = phase
    const priorCalls = previous?.checkpoint.callsReserved ?? 0
    const priorElapsed = previous?.checkpoint.elapsedMs ?? 0
    if (phase.phase !== readingPhases[index] || !equal(snapshot, expected.expectedSnapshot)
      || Object.entries(expected.expectedInput).some(([key, value]) => !equal(input[key], value))
      || checkpoint.version !== 1 || checkpoint.taskId !== snapshot.taskId || checkpoint.modelId !== 'comparison-model'
      || checkpoint.modelVersion !== expected.modelVersion || !equal(checkpoint.prompts, expected.prompts)
      || !equal(checkpoint.limits, expected.expectedLimits)
      || checkpoint.callsReserved !== priorCalls + result.calls || checkpoint.attempts.length !== checkpoint.callsReserved
      || ![result.calls, result.httpRequests, result.inputCharged, result.outputCharged, result.elapsedMs, checkpoint.elapsedMs]
        .every(value => Number.isSafeInteger(value) && value >= 0)
      || checkpoint.elapsedMs <= priorElapsed || checkpoint.elapsedMs > priorElapsed + result.elapsedMs
      || previous && (!equal(checkpoint.attempts.slice(0, priorCalls), previous.checkpoint.attempts)
        || !equal(input.recovery, { sourcePhase: expected.caseName + '-' + previous.phase,
          checkpointHash: createHash('sha256').update(JSON.stringify(previous.checkpoint)).digest('hex') }))) {
      return invalidResume()
    }
    const failed = expected.resuming || index < phases.length - 1
    if (failed) {
      if (!phase.archivedHalt) return invalidResume()
      validateReadingResume({ caseName: expected.caseName, originalResult: result, archivedHalt: phase.archivedHalt,
        checkpoint, expectedLimits: expected.expectedLimits, sourceIds: expected.sourceIds, ledger: phase.ledger,
        priorCheckpoint: previous?.checkpoint })
    } else if (result.state !== 'completed' || checkpoint.stage !== 'checking' || checkpoint.pendingRead || !checkpoint.navigation
      || !equal(checkpoint.coveredMessageIds, expected.sourceIds) || checkpoint.report !== null
      || checkpoint.attempts.some(attempt => attempt.stage !== 'reading' || !['returned', 'failed'].includes(attempt.status))) return invalidResume()

    const localAttempts = checkpoint.attempts.slice(priorCalls)
    const reserved = new Set<number>(), dispatched = new Set<number>(), settled = new Set<number>()
    let chargedInput = 0, chargedOutput = 0
    for (const line of phase.ledger.split('\n').filter(Boolean)) {
      const entry = JSON.parse(line)
      const attempt = localAttempts[entry.call - 1]
      if (entry.kind === 'reserved') {
        if (!attempt || entry.call !== reserved.size + 1 || !['reading', 'compress-navigation'].includes(entry.stage)
          || entry.inputEstimate !== attempt.input.tokens || entry.outputLimit !== attempt.reservedOutput) return invalidResume()
        reserved.add(entry.call)
      } else if (entry.kind === 'dispatched') {
        if (!reserved.has(entry.call) || dispatched.has(entry.call)) return invalidResume()
        dispatched.add(entry.call)
      } else if (entry.kind === 'settled') {
        if (!reserved.has(entry.call) || settled.has(entry.call) || !equal(entry.usage, attempt.usage)) return invalidResume()
        settled.add(entry.call)
        const usage = attempt.usage
        chargedInput += usage?.totalInputTokens ?? (usage?.inputTokens === undefined ? attempt.input.tokens
          : usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0))
        chargedOutput += usage?.outputTokens ?? attempt.reservedOutput
        if (!equal(entry.charged, { input: chargedInput, output: chargedOutput })) return invalidResume()
      }
    }
    if (reserved.size !== result.calls || dispatched.size !== result.httpRequests || settled.size !== result.calls
      || chargedInput !== result.inputCharged || chargedOutput !== result.outputCharged) return invalidResume()
    charges = sumComparisonCharges(charges, result)
    previous = phase
  }
  return charges
}
