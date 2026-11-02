import { dimensionKeys, type MemoryDimensions } from '../shared/memory'

export const personalityDimensions = {
  EI: { id: 'energy', name: '精力来源', left: '外向 E', right: '内向 I',
    leftContext: '更习惯从互动中恢复精力', rightContext: '更习惯从独处中恢复精力' },
  SN: { id: 'information', name: '理解信息', left: '实感 S', right: '直觉 N',
    leftContext: '更依赖具体经验', rightContext: '更留意事物间的关联与可能' },
  TF: { id: 'decisions', name: '做决定', left: '思考 T', right: '情感 F',
    leftContext: '更侧重逻辑', rightContext: '更看重感受' },
  JP: { id: 'approach', name: '安排方式', left: '判断 J', right: '感知 P',
    leftContext: '更习惯提前安排', rightContext: '更习惯保留弹性' },
} as const

export function predictionText(dimensions: MemoryDimensions) {
  return dimensionKeys.map(axis => dimensions[axis] ?? '?').join('')
}
