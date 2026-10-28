import type { ClarificationModel, ClarificationQuestion } from '../components/clarification/types'
import { overviewScenarios } from './overview-fixtures'

const question: ClarificationQuestion = {
  id: 'example-clarification-defense',
  title: '朋友准备答辩时，你当时更想怎么帮他？',
  context: '那几天，他试讲时卡在两张图上，想推迟聚餐。你们聊了准备进度，他说想找个人听一遍，你答应第二天晚上试讲。',
  options: [
    { id: 'listen', title: '更想先听他说完', description: '当时他需要有人听着' },
    { id: 'help', title: '主要想帮他赶完眼前的事', description: '我更担心他来不及' },
    { id: 'ask', title: '当时只是顺手问了问', description: '没有特别想表达什么' },
  ],
  source: {
    id: 'example-clarification-source', conversationId: 'example-defense-plan',
    messageId: 'plan-1', endMessageId: 'plan-10', title: '答辩前的准备与试讲安排',
    context: '从朋友想推迟聚餐，到确认需要听众、纠正旧版图并约好试讲的整段交流。',
  },
}

const models: readonly ClarificationModel[] = [
  { id: 'example-model-a', label: '示例模型 A', available: true },
  { id: 'example-model-b', label: '示例模型 B', available: true },
]

interface ClarificationScenario {
  id: string
  label: string
  description: string
  question?: ClarificationQuestion
  models: readonly ClarificationModel[]
  noAdapter?: boolean
}

export const clarificationConversations = overviewScenarios[0].conversations
export const clarificationScenarios: readonly ClarificationScenario[] = [
  { id: 'normal', label: '选卡与自己回答', description: '选卡立即模拟提交；自己回答需选择示例模型。可撤回后重新作答。', question, models },
  { id: 'empty', label: '暂无问题', description: '没有问题时保留空状态。', models },
  { id: 'no-model', label: '无可用模型', description: '卡牌仍可模拟提交；自己回答可写草稿，但无法发送。', question, models: [] },
  { id: 'source-unavailable', label: '原文不可用', description: '原文入口不可用，不跳转到其他会话。', question: { ...question, source: { ...question.source!, unavailable: true } }, models },
  { id: 'long-text', label: '长问题与长选项', description: '检查长文本换行、卡牌高度与窄屏输入。', models, question: {
    ...question,
    title: '朋友准备答辩、想推迟聚餐，又说自己需要一个听众时，你当时更在意的是帮他把眼前的任务做完，还是先听清楚他真正希望你怎样参与？',
    context: `${question.context}\n你也提到自己容易急着出主意，刚才找了半天才发现手里是旧版图。朋友又确认了一次：先听，没听懂再问，不用一起改图。这里想了解的是当时的想法，不把一次回应当作你在所有关系中的习惯。`,
    options: [
      { id: 'listen', title: '我更想听清楚他需要什么，再决定自己能怎样帮忙', description: '之前容易急着出主意，这一次想先听完，不把我认为有用的办法直接塞给他。' },
      { id: 'help', title: '我主要担心时间来不及，想帮他把答辩前最急的事情做好', description: '听试讲是当时能做的一件具体事情；这并不一定代表我在其他场景里也会这样回应。' },
      { id: 'ask', title: '我当时没有特别想过这些，只是听他说遇到困难，就顺着话问了几句', description: '后来约时间也是觉得自己刚好有空，不想把这些细节解释成一个稳定的性格特点。' },
    ],
  } },
  { id: 'no-adapter', label: '未接入提交接口', description: '可编辑草稿，不能提交或伪造成功。', question, models, noAdapter: true },
]
