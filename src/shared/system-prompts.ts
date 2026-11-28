import { BoundaryError } from './desktop-validation'

export const promptIds = ['dialogue', 'insight'] as const
export type PromptId = typeof promptIds[number]
export type PromptValues = Record<PromptId, string>
export const maxPromptLength = 20000
export const promptCatalog: readonly { id: PromptId; name: string; purpose: string; feature: string }[] = [
  { id: 'dialogue', name: 'AI 对话', purpose: '引导回答的语气、交流方式和理解经历的角度。', feature: 'AI 对话' },
  { id: 'insight', name: '洞察偏好', purpose: '自定义洞察报告的篇幅、语气或关注重点。', feature: '对话洞察' },
]
export function validatePrompt(id: unknown, value: unknown): asserts id is PromptId {
  if (!promptIds.includes(id as PromptId)) throw new BoundaryError('INVALID_ARGUMENT', '请重新选择提示词。')
  if (typeof value !== 'string' || (id === 'dialogue' && !value.trim())) throw new BoundaryError('INVALID_ARGUMENT', '请输入提示词。')
  if (value.length > maxPromptLength) throw new BoundaryError('INVALID_ARGUMENT', '提示词不能超过 20000 字符，请缩短后保存。')
}
export const defaultPrompts: Readonly<PromptValues> = Object.freeze({
  dialogue: '用自然、清楚的中文交流，贴着用户当前的问题与具体经历回答。少用术语，避免重复说明。',
  insight: '篇幅精炼、语气平实克制，围绕具体事件与前后变化展开，避免泛泛概括。',
})
