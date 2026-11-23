import { readTurns } from './pi-insight-model.mjs'
export const syntheticInsightConversation = '合成会话 · 建议和倾听'
export const syntheticInsightReportTitle = '合成报告 · 建议与倾听'
export const syntheticInsightMessages = [
  { id: '1', member: 1, at: Date.UTC(2026, 9, 9, 15, 58), text: '我先给你三个办法。' },
  { id: '2', member: 2, at: Date.UTC(2026, 9, 10, 15, 54), text: '我想先说完。' },
  { id: '3', member: 2, at: Date.UTC(2026, 9, 10, 15, 56), text: '这次能不能给我个主意？' },
  { id: '4', member: 1, at: Date.UTC(2026, 9, 10, 16, 5), text: '合成日期范围外的回复。' },
]

export const syntheticInsightScope = { kind: 'dates', startDate: '2026-10-09', endDate: '2026-10-10', timezone: 'Asia/Shanghai' }

export function seedSyntheticInsight(writer) {
  writer.exec(`
    INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'合成会话 · 建议和倾听','direct',0);
    INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(1,1,'example','synthetic-insights');
    INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name)
      VALUES(1,1,1,'self','合成本人'),(2,1,1,'peer','合成对方');
    INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(1,1,'confirmed','user');
  `)
  const insert = writer.prepare(`
    INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal,sent_at_ms,time_precision)
      VALUES(?,1,?,'member',?, 'text', ?, ?, ?, 'minute')
  `)
  for (const message of syntheticInsightMessages) {
    insert.run(Number(message.id), message.member, message.member === 1 ? '合成本人' : '合成对方', message.text, Number(message.id) - 1, message.at)
  }
  writer.exec(`
    INSERT INTO message_keys VALUES(1,'synthetic-insights','first',1);
    INSERT INTO message_replies(message_id,conversation_id,target_message_id,original_id,id_namespace,state)
      VALUES(3,1,1,'first','synthetic-insights','resolved');
  `)
  return true
}

export function mockReadAction(input) {
  const turns = readTurns(input)
  const first = turns.find(turn => turn.result.messages?.length)?.result
  if (!first) return { action: 'open', read: {}, messages: [] }
  const messages = first.messages
  if (!turns.some(turn => turn.args?.messageId === '3')) return { action: 'check-source', read: { messageId: '3' }, messages }
  return { action: 'report', messages }
}

export function simpleInsightReply(prompt) {
  if (prompt.stage === 'reading') return { observations: [], openThreads: [], candidates: [] }
  if (prompt.stage === 'writing') return {
    aboutYou: [], relationship: [{ content: [{ text: '你们商量了见面的时间。' }] }],
    citations: [], limitations: ['仅依据本次聊天。'],
  }
  throw new Error('Unexpected synthetic insight stage')
}

export function suggestionReport() {
  return {
    aboutYou: [{ content: [{ text: '你一开始就给了三个办法', citationId: 'suggestion-shift' }] }],
    relationship: [{ content: [{ text: 'ta 也会主动问你有没有主意。', citationId: 'asked-later' }] }],
    citations: [
      { id: 'suggestion-shift', fragments: [{ messageIds: ['1'] }, { messageIds: ['3'] }] },
      { id: 'asked-later', fragments: [{ messageIds: ['3'] }] },
    ],
    limitations: ['你可以先问 ta 想听建议，还是想接着说。'],
    judgments: [{
      dimension: 'TF', direction: null, text: '不同阶段对建议的需要不同。',
      supportingIds: ['1'], counterexampleIds: ['3'], alternativeExplanations: ['有时 ta 只想先说完。'], limitations: ['仅限该次聊天。'],
    }],
  }
}
