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
  if (checkpoint.stage !== 'reading' || checkpoint.report !== null || checkpoint.navigation !== null || checkpoint.writingRepairs !== 0
    || !equal(checkpoint.limits, expectedLimits) || !pendingRead
    || !validCursor(cursor, sourceIds.length) || !equal(pendingRead.from, cursor) || !validCursor(pendingRead.to, sourceIds.length)
    || pendingRead.to.messageIndex < cursor.messageIndex
    || pendingRead.to.messageIndex === cursor.messageIndex && pendingRead.to.textOffset <= cursor.textOffset
    || !equal(checkpoint.coveredMessageIds, sourceIds.slice(0, cursor.messageIndex))
    || checks.some(check => check.rounds > 0)
    || callsReserved !== priorCalls + originalResult.calls || callsReserved !== attempts.length || attempts.at(-1)?.status !== 'returned'
    || priorCheckpoint && !equal(attempts.slice(0, priorCalls), priorCheckpoint.attempts)
    || attempts.some(attempt => attempt.stage !== 'reading' || !['returned', 'failed'].includes(attempt.status))) return invalidResume()

  const reserved: number[] = []
  const dispatched = new Set<number>()
  for (const line of ledger.split('\n').filter(Boolean)) {
    const { kind, stage, call } = JSON.parse(line)
    if (kind === 'reserved') {
      if (stage !== 'reading' || call !== reserved.length + 1) return invalidResume()
      reserved.push(call)
    }
    if (kind === 'dispatched') {
      if (!reserved.includes(call) || dispatched.has(call)) return invalidResume()
      dispatched.add(call)
    }
  }
  if (reserved.length !== originalResult.calls || !dispatched.has(originalResult.calls) || dispatched.size !== originalResult.httpRequests
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
