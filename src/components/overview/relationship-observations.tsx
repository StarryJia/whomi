import { ChevronRight } from 'lucide-react'
import { aggregateRelationships, dimensionKeys, type MemoryDimensions } from '../../shared/memory'
import { personalityDimensions, predictionText } from '../personality-dimensions'
import type { OverviewData } from './types'

export type RelationshipObservation = { taskId: string; title: string; isDirect: boolean; dimensions: MemoryDimensions }

function relationshipContext(relations: RelationshipObservation[]) {
  const contacts = relations.map(item => item.isDirect && /^我和([^\s·，。；：、（）「」]+)$/u.exec(item.title)?.[1])
  if (contacts.every(Boolean)) return `与${contacts.join('、')}相处时`
  const sources = relations.map(item => `「${item.title}」`).join('、')
  return `在${sources}${relations.length === 1 ? '这段' : '这些'}聊天中`
}

export function relationshipPreferences(observations: RelationshipObservation[]) {
  const result: NonNullable<OverviewData['preferences']> = {}
  const aggregate = aggregateRelationships(observations)
  for (const key of dimensionKeys) {
    const direction = aggregate[key]
    const dimension = personalityDimensions[key]
    if (direction === null) {
      const observed = observations.find(item => item.dimensions[key])
      result[dimension.id] = { status: 'unknown', ...(observed && { reason: '再有一段关系提供这一维的观察，即可汇总。' }) }
      continue
    }
    const contexts = [...key].flatMap((letter, index) => {
      const sources = observations.filter(item => item.dimensions[key] === letter)
      return sources.length ? [`${relationshipContext(sources)}，你${index === 0 ? dimension.leftContext : dimension.rightContext}。`] : []
    })
    result[dimension.id] = direction === 'tie'
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
    <h2 id="relationship-heading">你在不同关系中的表现</h2>
    {Object.values(aggregateRelationships(observations)).every(value => value === null) && <p>各维度暂难汇总，至少需要两段关系提供同一维度的观察。</p>}
    {observations.map(item => <button className="overview-memory-link" type="button" key={item.taskId} onClick={() => onRead(item.taskId)}>
      <strong>{relationshipContext([item])}</strong>
      <span className="overview-memory-type">你的倾向 <b>{predictionText(item.dimensions)}</b></span>
      <ChevronRight aria-hidden="true" />
    </button>)}
  </section>
}
