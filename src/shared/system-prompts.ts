import { BoundaryError } from './desktop-validation'

export const promptIds = ['dialogue', 'insightReading', 'insightChecking', 'insightWriting'] as const
export type PromptId = typeof promptIds[number]
export type PromptValues = Record<PromptId, string>
export const maxPromptLength = 20000
export const promptCatalog: readonly { id: PromptId; name: string; purpose: string; feature: string }[] = [
  { id: 'dialogue', name: 'AI 对话', purpose: '引导回答的语气、交流方式和理解经历的角度。', feature: 'AI 对话' },
  { id: 'insightReading', name: '洞察阅读', purpose: '保留具体行为、日期、来源和未结束事项。', feature: '对话洞察' },
  { id: 'insightChecking', name: '洞察核查', purpose: '核对支持、反例、替代解释和适用边界。', feature: '对话洞察' },
  { id: 'insightWriting', name: '洞察成稿', purpose: '将有原文依据的分析写入关于你和你们的相处。', feature: '对话洞察' },
]
export function validatePrompt(id: unknown, value: unknown): asserts id is PromptId {
  if (!promptIds.includes(id as PromptId)) throw new BoundaryError('INVALID_ARGUMENT', '请重新选择提示词。')
  if (typeof value !== 'string' || !value.trim()) throw new BoundaryError('INVALID_ARGUMENT', '请输入提示词。')
  if (value.length > maxPromptLength) throw new BoundaryError('INVALID_ARGUMENT', '提示词不能超过 20000 字符，请缩短后保存。')
}
export const defaultPrompts: Readonly<PromptValues> = Object.freeze({
  insightReading: '顺序阅读当前会话，保留日期、原文编号、人物归属、显式回复、未结束事项和待解指代。不把批次或自然日当成事件边界；回查后沿原顺读位置继续。',
  insightChecking: '围绕已读观察回查原文及连续回应，跟进未结束事项和待解指代。无新依据时结束回查；无法判断时保留未知。',
  insightWriting: [
    '只撰写「关于你」和「你们的相处」，叙述中称对方为 ta，不生成报告标题。',
    '从具体经历写起。交代当时能选什么、你怎样选、你给出的理由，以及对方随后怎样回应。把改变解释的原话放在相应句子旁。记录停在提议时就写到提议为止。',
    '联系四维时，选这件事能回答的问题：你怎样参与交流或理清想法？怎样取用细节或探索可能？几个理由有冲突时，你更看重哪一个？哪些安排主动定下，哪些留待条件明朗再定？只在本人的言行让一种解释更有根据时写出倾向，并说明适用情境；允许未知，指出缺少哪种选择或理由。',
    '语气只作辅助，有可比经历时再比较。个人观察与四维解释共用同一经历时，只讲一次经过，每处引文说明一个具体推论。',
    '关系段保留双方连续回应，可写合作、成长或与材料有关的可尝试行动。不强行制造冲突，不建立 ta 的完整人格画像，不保证关系改善。',
  ].join('\n'),
  dialogue: '用自然、清楚的中文交流，贴着用户当前的问题与具体经历回答。少用术语，避免重复说明。',
})
