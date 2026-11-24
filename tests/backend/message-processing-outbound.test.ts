import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { createServer } from 'node:http'
import { dirname } from 'node:path'
import { PiRuntime } from '../../electron/agent/runtime'
import { openStore } from '../../electron/data/db/open'
import { createAiRepository } from '../../electron/data/ai/repository'
import { createSettingsRepository } from '../../electron/data/settings/repository'
import { createAiService } from '../../electron/main/ai-service'
import { temporaryStore } from './helpers'
import { completeModel, readTurns, sampleJudgments } from '../desktop/fixtures/pi-insight-model.mjs'
import type { InsightReadRequest } from '../../src/shared/insight-reader'

type ModelRequest = { messages: { role: string; content: string | { type: string; text?: string }[] }[] }

function userPayload(request: ModelRequest, index = -1) {
  const content = request.messages.filter(message => message.role === 'user').at(index)!.content
  return JSON.parse(typeof content === 'string' ? content : content.map(part => part.text ?? '').join(''))
}

describe('processed messages in actual model requests', () => {
  beforeAll(async () => { await import('@earendil-works/pi-coding-agent') }, 30000)
  let temp: ReturnType<typeof temporaryStore>
  let store: ReturnType<typeof openStore>
  let repository: ReturnType<typeof createAiRepository>
  let settings: ReturnType<typeof createSettingsRepository>
  let service: ReturnType<typeof createAiService>
  let server: ReturnType<typeof createServer>
  let requests: ModelRequest[]
  let answer: string | ((request: ModelRequest) => string | { read: InsightReadRequest; note?: string })
  let threadId: string
  const members = [{ id: '1', displayName: '本人' }, { id: '2', displayName: '示例甲' },
    { id: '3', displayName: 'Bearer' }, { id: '4', displayName: 'sk' }, { id: '5', displayName: '小林' }, { id: '6', displayName: 'U5' }]

  function startService() {
    return createAiService({
      storage: (method, args) => Reflect.apply(Reflect.get(repository, method), repository, args),
      processing: async () => ({ settings: settings.get().processing, members }),
      claimProcessing: settings.claimProcessing,
      runtime: new PiRuntime(dirname(temp.path)),
      secrets: { encrypt: value => value, decrypt: value => value },
    })
  }

  beforeEach(async () => {
    temp = temporaryStore()
    store = openStore(temp.path)
    const write = async <T,>(operation: () => T | Promise<T>) => operation()
    repository = createAiRepository(store, write)
    settings = createSettingsRepository(store, write)
    store.writer.exec(`INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'合成验收会话','direct',0);
      INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(1,1,'example','processing');
      INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES(1,1,1,'self','本人');
      INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(1,1,'confirmed','user')`)
    const insertMember = store.writer.prepare('INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES(?,1,1,?,?)')
    for (const member of members.slice(1)) insertMember.run(member.id, member.id, member.displayName)
    requests = []
    answer = '合成回答'
    server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        const payload = JSON.parse(body)
        requests.push(payload)
        const content = typeof answer === 'function' ? answer(payload) : answer
        if (typeof content === 'object') return completeModel(response, content)
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.end(`data: ${JSON.stringify({ id: 'example', choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`)
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    await repository.saveModel({ id: 'model', label: '合成模型', model: 'example-model', baseUrl: `http://127.0.0.1:${port}/v1`, contextWindow: 32000, maxTokens: 1000, enabled: true })
    await settings.initialize()
    service = startService()
    threadId = (await service.createThread('1')).id
  })

  afterEach(async () => {
    await service?.close()
    server?.closeAllConnections()
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    store?.close()
    temp?.cleanup()
  })

  async function send(prompt: string, referenceIds: string[] = []) {
    const turn = await service.sendTurn({ threadId, requestId: `request-${requests.length}`, prompt, referenceIds, modelId: 'model' })
    await service.idle()
    expect(repository.getThread(threadId).turns.at(-1)).toMatchObject({ id: turn.id, state: 'completed' })
    return turn
  }

  function seedSources() {
    const messages = [
      { memberId: '3', kind: 'text', text: 'Bearer testtoken1234567890' },
      { memberId: '4', kind: 'text', text: 'sk-abcdefghijklmnopqrstuv' },
      { memberId: '5', kind: 'text', text: '小林约U5明天见。密码：Cedar!42，明早见' },
      { memberId: '5', kind: 'text', text: '4111111111111111 123' },
      { memberId: '2', kind: 'link', text: '<?xml version="1.0"?><msg><appmsg><title>示例标题</title><url>https://example.invalid</url></appmsg></msg>' },
      { memberId: '1', kind: 'text', text: '378282246310005 4111 1111 1111 1111' },
    ]
    const insert = store.writer.prepare("INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal,sent_at_ms) VALUES(?,1,?,'member',?,?,?,?,?)")
    messages.forEach((message, index) => insert.run(index + 1, message.memberId, members.find(member => member.id === message.memberId)!.displayName, message.kind, message.text, index, index * 120_000))
    return messages
  }

  test('引用跳过另一位成员的发言时，首轮和续聊仍保留两段', async () => {
    const insert = store.writer.prepare("INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal,sent_at_ms) VALUES(?,1,?,'member',?,'text',?,?,?)")
    insert.run(1, 5, '小林', '周六见', 0, 0)
    insert.run(2, 2, '示例甲', '未选中的回答', 1, 30_000)
    insert.run(3, 5, '小林', '下午两点', 2, 60_000)
    await send('我当时说了什么？', ['1', '3'])
    await send('继续')
    for (const request of requests) {
      expect(userPayload(request, 0).references.map((ref: { sourceIds: string[] }) => ref.sourceIds)).toEqual([['1'], ['3']])
      expect(JSON.stringify(request)).not.toContain('未选中的回答')
    }
  }, 20000)

  function expectProcessedSources(messages: unknown[]) {
    expect(messages).toMatchObject([
      { id: '1', memberId: '3', sourceIds: ['1'], senderName: 'U3', text: '[授权令牌]' },
      { id: '2', memberId: '4', sourceIds: ['2'], senderName: 'U4', text: '[接口密钥]' },
      { id: '3', memberId: '5', sourceIds: ['3', '4'], senderName: 'U5', sentAtMs: 240_000, text: '小林约U5明天见。密码：[密码]，明早见\n[银行卡号] 123' },
      { id: '5', memberId: '2', sourceIds: ['5'], senderName: 'U2', text: '示例标题\nhttps://example.invalid' },
      { id: '6', memberId: '1', sourceIds: ['6'], senderName: 'U1', text: '[银行卡号] [银行卡号]' },
    ])
  }

  test('首轮和续聊都遮盖相邻号码及同条消息中明确标出的密码', async () => {
    const reference = '13800138001 4111 1111 1111 1111\n{"password":\n  "Blue Bird 42!"}'
    store.writer.prepare("INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal,sent_at_ms) VALUES(1,1,5,'member','小林','text',?,0,0)").run(reference)
    const turn = await send('密码：　Cedar!42，明早见', ['1'])
    await send('继续')

    for (const request of requests) {
      expect(userPayload(request, 0)).toMatchObject({
        question: '密码：　[密码]，明早见',
        references: [{ id: '1', text: '[手机号] [银行卡号]\n{"password":\n  "[密码]"}' }],
      })
    }
    expect(repository.turnContext(turn.id).references[0].text).toBe(reference)
  }, 20000)

  test('a resumed conversation sends processed history while retaining the original answer locally', async () => {
    answer = '示例甲 example@example.com 13800138000；password="Blue Bird 42!"'
    const first = await send('联系示例甲 example@example.com')
    expect(repository.getThread(threadId).turns[0].text).toBe(answer)
    await service.close()
    service = startService()
    await send('继续')
    expect(repository.turnContext(repository.getThread(threadId).turns[1].id).checkpoint).toBeTruthy()
    expect(requests).toHaveLength(2)
    expect(requests[1].messages.filter(message => message.role === 'assistant')).toEqual([
      { role: 'assistant', content: '示例甲 [邮箱] [手机号]；password="[密码]"' },
    ])
    expect(JSON.stringify(requests)).not.toMatch(/Blue Bird 42|example@example\.com|13800138000/)
    expect(repository.getThread(threadId).turns[0]).toMatchObject({ id: first.id, text: answer, prompt: '联系示例甲 example@example.com' })
  }, 20000)

  test('current questions and current and historical references use all corrected transforms on the wire', async () => {
    const originals = seedSources()
    const first = await send('密码：Bearer testtoken1234567890；sk-abcdefghijklmnopqrstuv；小林约U5明天见；密码是Cedar!42；4111111111111111 123', ['1', '2', '3', '4', '5', '6'])
    expect(userPayload(requests[0]).question).toBe('密码：[授权令牌]；[接口密钥]；小林约U5明天见；密码是[密码]；[银行卡号] 123')
    expectProcessedSources(userPayload(requests[0]).references)
    await send('继续检查引用')
    expectProcessedSources(userPayload(requests[1], 0).references)
    expect(repository.turnContext(first.id).references.map(({ id, text, sentAtMs }) => ({ id, text, sentAtMs })))
      .toEqual(originals.map(({ text }, index) => ({ id: String(index + 1), text, sentAtMs: index * 120_000 })))
    expect(JSON.stringify(requests)).not.toMatch(/Cedar!42|testtoken1234567890|abcdefghijklmnopqrstuv|4111111111111111|378282246310005|<appmsg>/)
  }, 20000)

  test('洞察读取发送脱敏内容，保存的原文保持完整', async () => {
    const originals = seedSources()
    answer = request => {
      const turns = readTurns(request)
      if (!turns.length) return { read: {} }
      if (turns.length === 1) return { read: { messageId: '3' }, note: '小林留下联系方式 example@example.com，password="Blue Bird 42!"' }
      return JSON.stringify({
        aboutYou: [{ content: [{ text: '你发了一条号码记录。', citationId: 'a' }] }],
        relationship: [{ content: [{ text: '对方在聊天里约了见面。', citationId: 'b' }] }],
        citations: [{ id: 'a', fragments: [{ messageIds: ['6'] }] }, { id: 'b', fragments: [{ messageIds: ['3'] }] }],
        judgments: sampleJudgments(), limitations: [],
      })
    }
    const prepared = await service.prepareAnalysis({ conversationId: '1', modelId: 'model' })
    const task = await service.confirmAnalysis({ token: prepared.token, requestId: 'insight-processing' })
    await service.idle()
    expect(repository.getAnalysis(task.id)).toMatchObject({ state: 'completed', analyzedMessages: 6 })
    expect(requests).toHaveLength(3)
    const [firstPage, revisit] = readTurns(requests[2])
    const sent = firstPage.result.messages
    expect(sent.map((message: { text: string }) => message.text)).toEqual([
      '[授权令牌]', '[接口密钥]', '小林约U5明天见。密码：[密码]，明早见', '[银行卡号] 123', '示例标题\nhttps://example.invalid', '[银行卡号] [银行卡号]',
    ])
    expect(revisit.result.messages).toEqual([sent[2]])
    expect(requests[2].messages.filter(message => message.role === 'assistant')).toContainEqual(
      expect.objectContaining({ content: '小林留下联系方式 [邮箱]，password="[密码]"' }),
    )
    expect(JSON.stringify(requests)).not.toMatch(/Blue Bird 42|Cedar!42|testtoken1234567890|abcdefghijklmnopqrstuv|4111111111111111|378282246310005|<appmsg>|example@example\.com|13800138000/)
    expect(store.reader.prepare('SELECT text FROM messages ORDER BY id').all()).toEqual(originals.map(({ text }) => ({ text })))
  }, 20000)
})
