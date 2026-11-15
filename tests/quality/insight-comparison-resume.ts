import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InsightCheckpoint, InsightRunLimits } from '../../electron/main/insight-checkpoint'
import type { InsightCursor } from '../../electron/main/insight-packing'

export type ComparisonCharge = { httpRequests: number; inputCharged: number; outputCharged: number; elapsedMs: number }
export type ComparisonPhaseResult = ComparisonCharge & { state: string; error?: string; calls: number }
export const archivedReadingHaltName = 'halt-before-resume.json'

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
    if (caseName === resumeCase || !existsSync(join(output, caseName + '-reading', archivedReadingHaltName))) continue
    const recovered = join(output, caseName + '-reading-resume', 'result.json')
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
}) {
  const { caseName, originalResult, archivedHalt, checkpoint, expectedLimits, sourceIds, ledger } = input
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
    || callsReserved !== originalResult.calls || callsReserved !== attempts.length || attempts.at(-1)?.status !== 'returned'
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
  if (reserved.length !== callsReserved || !dispatched.has(callsReserved) || dispatched.size !== originalResult.httpRequests
    || ![originalResult.elapsedMs, originalResult.inputCharged, originalResult.outputCharged]
      .every(value => Number.isSafeInteger(value) && value >= 0)) return invalidResume()
}
