import { expect, test } from 'vitest'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PiRuntime } from '../../electron/agent/runtime'
import { createAiRepository } from '../../electron/data/ai/repository'
import { openStore } from '../../electron/data/db/open'
import { createAiService } from '../../electron/main/ai-service'
import { meetingChat, meetingModel } from '../desktop/fixtures/pi-insight-model.mjs'
import { temporaryStore } from './helpers'

test.each([8, 4600])('从服务入口发送 %i 条合成原文，按时段提取并用真实 Pi 阅读工具回查', async count => {
  const temp = temporaryStore(), directory = dirname(temp.path)
  const store = openStore(temp.path)
  const ai = createAiRepository(store, async operation => operation())
  const events: { action: string; error?: string }[] = []
  const provider = await meetingModel({ count, profileDirectory: directory, observe: event => events.push(event),
    overloadOnPage: count > 8 ? 1 : 0 })
  const errors: unknown[] = []
  const service = createAiService({ storage: (method, args) => Reflect.apply(Reflect.get(ai, method), ai, args),
    secrets: { encrypt: String, decrypt: String }, runtime: new PiRuntime(directory), dataDirectory: directory,
    writeInsightTrace: count === 8, logError: entry => errors.push(entry.error) })
  try {
    const db = store.writer
    db.exec(`INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'聚会','direct',0);
      INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(1,1,'example','聚会');
      INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES
        (1,1,1,'self','合成本人'),(2,1,1,'peer','合成对方');
      INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(1,1,'confirmed','user')`)
    const insert = db.prepare(`INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,sent_at_ms,ordinal)
      VALUES(?,1,?,'member',?,'text',?,?,?)`)
    db.transaction(() => {
      for (const [i, row] of meetingChat(count).messages.entries()) {
        insert.run(i + 1, row.sender === 'self' ? 1 : 2, row.accountName, row.content, row.timestamp * 1000, i)
        if (row.replyToMessageId) {
          db.prepare("INSERT INTO message_keys VALUES(1,'聚会',?,?)").run(row.replyToMessageId, Number(row.replyToMessageId))
          db.prepare(`INSERT INTO message_replies(message_id,conversation_id,target_message_id,original_id,id_namespace,state)
            VALUES(?,1,?,?,'聚会','resolved')`).run(i + 1, Number(row.replyToMessageId), row.replyToMessageId)
        }
      }
      db.prepare("INSERT INTO message_keys VALUES(1,'聚会',?,?)").run(String(count + 1), count + 1)
      db.prepare(`INSERT INTO message_replies(message_id,conversation_id,target_message_id,original_id,id_namespace,state)
        VALUES(1,1,?,?,'聚会','resolved')`).run(count + 1, String(count + 1))
    })()
    await ai.saveModel({ id: 'm', label: '测试模型', model: 'fixture', baseUrl: provider.baseUrl, enabled: true, contextWindow: null, maxTokens: null })
    const { token } = await service.prepareAnalysis({ modelId: 'm', conversationId: '1',
      scope: { kind: 'dates', timezone: 'Asia/Shanghai', startDate: '2026-10-07', endDate: '2026-10-07' } })
    const { id } = await service.confirmAnalysis({ token, requestId: 'meeting' })
    await service.idle()
    expect(events.filter(e => e.action === 'mock-error')).toEqual([])
    expect(errors).toEqual([])
    expect(ai.getAnalysis(id)).toMatchObject({ state: 'completed', analyzedMessages: count })
    expect(provider.state.confirmed.size).toBe(count)
    expect(provider.state.reread).toBe(true)
    const cards = ai.listInsightEvidenceCards(id)
    const path = join(directory, 'ai-runtime', 'insight-traces', 'task-' + id + '.json')
    if (count === 8) {
      expect(cards).toHaveLength(0)
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
        pipeline: 'pi-insight-v1', totalMessages: 8, timeCoverage: { correctionTriggered: false, final: { totalCitations: 4 } },
      })
    } else {
      expect(cards.length).toBeGreaterThan(1)
      expect(cards.map(card => card.data)).toEqual(provider.state.cards)
      expect(events.filter(e => e.action === 'service-overloaded')).toHaveLength(1)
      expect(events.filter(e => e.action === 'compaction')).toHaveLength(0)
      expect(existsSync(path)).toBe(false)
    }
  } finally {
    await service.close()
    await provider.close()
    store.close()
    temp.cleanup()
  }
}, 60000)
