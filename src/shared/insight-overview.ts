import type { AnalysisTask } from './ai-contract'
import { dimensionKeys, type InsightDimensions, type InsightSourceRef } from './conversation-insights'

export type OverviewContribution = {
  conversationId: string
  taskId: string
  sourceTaskIds: string[]
  dimensions: InsightDimensions
  evidence: Record<keyof InsightDimensions, (InsightSourceRef & { conversationId: string })[]>
}

export function aggregateRelationships(relations: readonly { dimensions: InsightDimensions }[]) {
  const count = (pair: keyof InsightDimensions) => {
    const letters = relations.map(relation => relation.dimensions[pair]).filter(letter => letter !== null)
    if (letters.length < 2) return null
    const left = letters.filter(letter => letter === pair[0]).length, right = letters.length - left
    return left === right ? 'tie' : left > right ? pair[0] : pair[1]
  }
  return { EI: count('EI'), SN: count('SN'), TF: count('TF'), JP: count('JP') }
}

export function currentOverviewContributions(tasks: readonly AnalysisTask[]): OverviewContribution[] {
  const unique = new Map<string, AnalysisTask>()
  for (const task of tasks) {
    const previous = unique.get(task.id)
    if (!previous || task.eventSequence >= previous.eventSequence) unique.set(task.id, task)
  }
  const valid = [...unique.values()].filter(task => task.valid && task.state === 'completed' && task.report)
  const relations = new Map<string, OverviewContribution & {
    directions: Record<keyof InsightDimensions, Set<string | null>>
  }>()
  function relation(conversationId: string, taskId: string) {
    let entry = relations.get(conversationId)
    if (!entry) {
      entry = { conversationId, taskId, sourceTaskIds: [], dimensions: { EI: null, SN: null, TF: null, JP: null },
        evidence: { EI: [], SN: [], TF: [], JP: [] },
        directions: { EI: new Set(), SN: new Set(), TF: new Set(), JP: new Set() } }
      relations.set(conversationId, entry)
    }
    if (!entry.sourceTaskIds.includes(taskId)) entry.sourceTaskIds.push(taskId)
    return entry
  }
  for (const task of valid) {
    for (const judgment of task.report?.judgments ?? []) {
      if (!judgment.supportingSources.length) continue
      const entry = relation(task.conversationId, task.id), axis = judgment.dimension
      entry.directions[axis].add(judgment.direction)
      for (const source of [...judgment.supportingSources, ...judgment.counterexampleSources]) {
        if (!entry.evidence[axis].some(existing => existing.messageId === source.messageId && existing.revision === source.revision)) {
          entry.evidence[axis].push({ ...source, conversationId: task.conversationId })
        }
      }
    }
  }
  return [...relations.values()].map(({ directions, ...entry }) => {
    for (const axis of dimensionKeys) {
      // 互相矛盾或明确不确定的判断不能被重复分析的次数覆盖。
      const direction = directions[axis].size === 1 ? [...directions[axis]][0] : null
      Object.assign(entry.dimensions, { [axis]: direction ?? null })
    }
    entry.sourceTaskIds.sort((left, right) => BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0)
    entry.taskId = entry.sourceTaskIds[0]
    return entry
  }).sort((left, right) => BigInt(left.conversationId) < BigInt(right.conversationId) ? -1 : 1)
}
