import { predictionText } from '../memory-article'
import { ChevronRight } from 'lucide-react'
import { aggregateRelationships, dimensionKeys, type MemoryDimensions } from '../../shared/memory'
import type { OverviewData, PreferenceId } from './types'

export type RelationshipObservation = { taskId: string; title: string; dimensions: MemoryDimensions }
const names = {
  EI: ['精力来源', '互动', '独处'],
  SN: ['理解信息', '具体经验', '关联与可能'],
  TF: ['做决定', '逻辑', '感受'],
  JP: ['安排方式', '提前安排', '保留弹性'],
}
const preferenceIds: Record<keyof MemoryDimensions, PreferenceId> = { EI: 'energy', SN: 'information', TF: 'decisions', JP: 'approach' }

export function relationshipPreferences(observations: RelationshipObservation[]) {
  const result: NonNullable<OverviewData['preferences']> = {}
  const aggregate = aggregateRelationships(observations)
  for (const key of dimensionKeys) {
    const direction = aggregate[key]
    if (direction === null) {
      const observed = observations.find(item => item.dimensions[key])
      result[preferenceIds[key]] = { status: 'unknown', ...(observed && { reason: '再有一段关系提供这一维的观察，即可汇总。' }) }
      continue
    }
    const contexts = [...key].flatMap((letter, index) => {
      const titles = observations.filter(item => item.dimensions[key] === letter).map(item => item.title)
      return titles.length ? [`${titles.join('、')}偏向${names[key][index + 1]}。`] : []
    })
    result[preferenceIds[key]] = direction === 'tie'
      ? { status: 'split', contexts }
      : { status: 'known', leaning: direction === key[0] ? 'left' : 'right', context: contexts.join('') }
  }
  return result
}

export function RelationshipObservations({ observations, onRead }: {
  observations: RelationshipObservation[]; onRead: (id: string) => void
}) {
  if (!observations.length) return null
  return <section className="relationship-observations" aria-labelledby="relationship-heading">
    <h2 id="relationship-heading">各段关系中的表现</h2>
    {Object.values(aggregateRelationships(observations)).every(value => value === null) && <p>各维度暂难汇总，至少需要两段关系提供同一维度的观察。</p>}
    <h3>相关记忆</h3>
    {observations.map(item => <button className="overview-memory-link" type="button" key={item.taskId} aria-label={item.title} onClick={() => onRead(item.taskId)}>
      <span><strong>{item.title}</strong><small>{predictionText(item.dimensions)}</small></span>
      <ChevronRight aria-hidden="true" />
    </button>)}
  </section>
}
