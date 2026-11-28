import { open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BoundaryError, localId } from '../../src/shared/desktop-validation'
import type { InsightEvidenceCardRecord } from '../data/ai/insight-evidence-card'
import type { InsightSegmentPlan } from './insight-segmentation'
import type { InsightTimeCoverage } from './insight-time-coverage'
import { localLogDirectory } from './app-error-logs'

type Metrics = Omit<InsightTimeCoverage, 'correctionPrompt'>
export type InsightTrace = {
  taskId: string
  pipeline: 'segmented-insight-v1' | 'pi-insight-v1'
  timezone: string
  totalMessages: number
  segments: readonly InsightSegmentPlan[]
  evidenceCards: readonly InsightEvidenceCardRecord[]
  timeCoverage: { initial: Metrics | null; correctionTriggered: boolean; final: Metrics | null }
}

export const insightTraceDirectory = (directory: string) => join(directory, 'ai-runtime', 'insight-traces')
export const pendingTracePrefix = '.deleting-insight-trace-'
export const temporaryTracePrefix = '.writing-insight-trace-'
export function insightTracePaths(directory: string, id: string) {
  if (!localId(id)) throw new BoundaryError('INVALID_ID')
  const root = insightTraceDirectory(directory)
  return { original: join(root, `task-${id}.json`), pending: join(root, `${pendingTracePrefix}${id}.json`),
    temporary: join(root, `${temporaryTracePrefix}${id}.json`) }
}

function metrics(value: Metrics | null): Metrics | null {
  if (!value) return null
  const { buckets, segmentCitationCounts, totalCitations, uncoveredEarlierSegments, needsCorrection } = value
  return { buckets, segmentCitationCounts, totalCitations, uncoveredEarlierSegments, needsCorrection }
}

export function createInsightTraceWriter(directory: string, onError?: (error: unknown) => void | Promise<unknown>) {
  return async (trace: InsightTrace): Promise<void> => {
    try {
      const { original, temporary } = insightTracePaths(directory, trace.taskId)
      await localLogDirectory(join(directory, 'ai-runtime'), true)
      await localLogDirectory(dirname(original), true)
      const file = await open(temporary, 'wx', 0o600)
      try {
        try {
          const coverage = trace.timeCoverage
          const contents = { schemaVersion: 1, taskId: trace.taskId, pipeline: trace.pipeline, timezone: trace.timezone,
            totalMessages: trace.totalMessages, updatedAtMs: Date.now(), segments: trace.segments, evidenceCards: trace.evidenceCards,
            timeCoverage: { initial: metrics(coverage.initial), correctionTriggered: coverage.correctionTriggered, final: metrics(coverage.final) } }
          await file.writeFile(JSON.stringify(contents, null, 2) + '\n')
        } finally { await file.close() }
        await rename(temporary, original)
      } catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
    } catch {
      // 分享的错误日志只接收错误码，聊天内容和本地路径仅留在私有目录。
      try { await onError?.(new BoundaryError('INSIGHT_TRACE_WRITE_FAILED', '请检查数据目录的可用空间与写入权限。')) } catch {}
    }
  }
}

export type InsightTraceWriter = ReturnType<typeof createInsightTraceWriter>
