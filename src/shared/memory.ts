import type { AiReport, AnalysisTask } from './ai-contract'

export type MemoryDimensions = { EI: 'E' | 'I' | null; SN: 'S' | 'N' | null; TF: 'T' | 'F' | null; JP: 'J' | 'P' | null }
export type EventVotes = Record<keyof MemoryDimensions, [number, number]>
type Manuscript = { dimensions: MemoryDimensions; events: { title: string; text: string }[]; relationship: string }
export type ScoredMemory = Manuscript & { format: 'memory-v3'; eventVotes: EventVotes }
export type MemoryReport = (Manuscript & { format: 'memory-v2' }) | ScoredMemory
export type SavedReport = AiReport | MemoryReport
export const dimensionKeys = ['EI', 'SN', 'TF', 'JP'] as const

export function isMemoryReport(report: SavedReport | undefined): report is MemoryReport {
  return !!report && 'format' in report && (report.format === 'memory-v2' || report.format === 'memory-v3')
}

function direction<A extends string, B extends string>(counts: [number, number], a: A, b: B): A | B | null {
  const [left, right] = counts, total = left + right
  if (total < 3) return null
  return left * 3 >= total * 2 ? a : right * 3 >= total * 2 ? b : null
}
export function scoreDimensions(votes: EventVotes): MemoryDimensions {
  return { EI: direction(votes.EI,'E','I'), SN: direction(votes.SN,'S','N'), TF: direction(votes.TF,'T','F'), JP: direction(votes.JP,'J','P') }
}

export function aggregateRelationships(relations: readonly { dimensions: MemoryDimensions }[]) {
  const count = (pair: keyof MemoryDimensions) => {
    const letters = relations.map(relation => relation.dimensions[pair]).filter(letter => letter !== null)
    if (letters.length < 2) return null
    const left = letters.filter(letter => letter === pair[0]).length, right = letters.length - left
    return left === right ? 'tie' : left > right ? pair[0] : pair[1]
  }
  return { EI: count('EI'), SN: count('SN'), TF: count('TF'), JP: count('JP') }
}

export function currentMemoryContributions(tasks: readonly AnalysisTask[]) {
  const latest = new Map<string, { conversationId: string; taskId: string; dimensions: MemoryDimensions }>()
  for (const task of tasks) {
    if (!task.valid || task.state !== 'completed' || !isMemoryReport(task.report) || task.report.format !== 'memory-v3') continue
    const previous = latest.get(task.conversationId)
    if (!previous || BigInt(task.id) > BigInt(previous.taskId)) {
      latest.set(task.conversationId, { conversationId: task.conversationId, taskId: task.id, dimensions: scoreDimensions(task.report.eventVotes) })
    }
  }
  return [...latest.values()]
}
