import { createHash } from 'node:crypto'
import { insightVerificationCases } from './insight-verification-material.mjs'

const sharedPlanning = insightVerificationCases['shared-planning']
const conditionalMessages = [
  [1, false, '如果小林也确认周日方便，你可以把餐厅从周六改到周日；没等到他的回复就先保留周六。', 8],
  [2, true, '知道，先留着周六。', 8, '1'],
  [3, false, '蛋糕不用等，周日送来就行。', 8],
  [4, true, '楼下花店把门口的架子搬到窗边了，刚好能照到下午的太阳。', 8],
  [19, false, '我刚把厚外套拿出来了，天气转凉以后早上出门正好穿。', 9],
  [20, true, '小林只说周日可能有空，还没答复；我把餐厅改周日了，蛋糕也约了周日。', 10],
  [21, false, '蛋糕这样没问题。餐厅这边，你怎么直接改了？', 10, '20'],
  [22, true, '我记得你说过可以改到周日，以为这次可以一起办掉。', 10, '21'],
].map(([id, isSelf, text, day, replyToMessageId = null]) => ({
  id: String(id), revision: createHash('sha256').update(JSON.stringify([id, isSelf, text, day, replyToMessageId])).digest('hex'),
  senderName: isSelf ? '合成本人' : '合成对方', isSelf, text,
  sentAtMs: Date.UTC(2026, 9, day, 8) + id * 60_000, replyToMessageId,
}))

export const insightComparisonCases = {
  'shared-planning': sharedPlanning,
  'conditional-permission': {
    scope: sharedPlanning.scope,
    excluded: sharedPlanning.excluded,
    messages: [...conditionalMessages.slice(0, 4), ...sharedPlanning.messages.slice(4, 18), ...conditionalMessages.slice(4)],
  },
}

export const comparisonPhases = ['reading', 'adaptive', 'direct', 'full']
export const comparisonPackingLimit = 7_000
export const comparisonOutputLimit = 3_000
export const trialRequestLimit = 24
