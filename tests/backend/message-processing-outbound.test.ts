import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { createServer } from 'node:http'
import { dirname } from 'node:path'
import { PiRuntime } from '../../electron/agent/runtime'
import { openStore } from '../../electron/data/db/open'
import { createAiRepository } from '../../electron/data/ai/repository'
import { createSettingsRepository } from '../../electron/data/settings/repository'
import { createAiService } from '../../electron/main/ai-service'
import { temporaryStore } from './helpers'
import { memoryModelReply } from '../desktop/fixtures/memory-model.mjs'

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
  let answer: string | ((request: ModelRequest) => string)
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
      { memberId: '5', kind: 'text', text: '小林约U5明天见' },
      { memberId: '5', kind: 'text', text: '4111111111111111 123' },
      { memberId: '2', kind: 'link', text: '<?xml version="1.0"?><msg><appmsg><title>示例标题</title><url>https://example.invalid</url></appmsg></msg>' },
      { memberId: '1', kind: 'text', text: '378282246310005 4111 1111 1111 1111' },
    ]
    const insert = store.writer.prepare("INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal) VALUES(?,1,?,'member',?,?,?,?)")
    messages.forEach((message, index) => insert.run(index + 1, message.memberId, members.find(member => member.id === message.memberId)!.displayName, message.kind, message.text, index))
    return messages
  }

  function expectProcessedSources(messages: unknown[]) {
    expect(messages).toMatchObject([
      { id: '1', memberId: '3', sourceIds: ['1'], senderName: 'U3', text: '[授权令牌]' },
      { id: '2', memberId: '4', sourceIds: ['2'], senderName: 'U4', text: '[接口密钥]' },
      { id: '3', memberId: '5', sourceIds: ['3'], senderName: 'U5', text: 'U5约U6明天见' },
      { id: '4', memberId: '5', sourceIds: ['4'], senderName: 'U5', text: '[银行卡号] 123' },
      { id: '5', memberId: '2', sourceIds: ['5'], senderName: 'U2', text: '示例标题\nhttps://example.invalid' },
      { id: '6', memberId: '1', sourceIds: ['6'], senderName: 'U1', text: '[银行卡号] [银行卡号]' },
    ])
  }

  test('a resumed conversation sends processed history while retaining the original answer locally', async () => {
    answer = '示例甲 example@example.com 13800138000；U5约U6明天见'
    const first = await send('联系示例甲 example@example.com')
    expect(repository.getThread(threadId).turns[0].text).toBe(answer)
    await service.close()
    service = startService()
    await send('继续')
    expect(repository.turnContext(repository.getThread(threadId).turns[1].id).checkpoint).toBeTruthy()
    expect(requests).toHaveLength(2)
    expect(requests[1].messages.filter(message => message.role === 'assistant')).toEqual([
      { role: 'assistant', content: 'U2 [邮箱] [手机号]；U5约U6明天见' },
    ])
    expect(JSON.stringify(requests)).not.toMatch(/示例甲|example@example\.com|13800138000/)
    expect(repository.getThread(threadId).turns[0]).toMatchObject({ id: first.id, text: answer, prompt: '联系示例甲 example@example.com' })
  }, 20000)

  test('current questions and current and historical references use all corrected transforms on the wire', async () => {
    const originals = seedSources()
    await send('Bearer testtoken1234567890；sk-abcdefghijklmnopqrstuv；小林约U5明天见；4111111111111111 123', ['1', '2', '3', '4', '5', '6'])
    expect(userPayload(requests[0]).question).toBe('[授权令牌]；[接口密钥]；U5约U6明天见；[银行卡号] 123')
    expectProcessedSources(userPayload(requests[0]).references)
    await send('继续检查引用')
    expectProcessedSources(userPayload(requests[1], 0).references)
    expect(store.reader.prepare('SELECT text FROM messages ORDER BY id').all()).toEqual(originals.map(({ text }) => ({ text })))
    expect(JSON.stringify(requests)).not.toMatch(/testtoken1234567890|abcdefghijklmnopqrstuv|4111111111111111|378282246310005|<appmsg>/)
  }, 20000)

  test('memory source and final requests use processed materials without rewriting the original messages', async () => {
    const originals = seedSources()
    answer = request => memoryModelReply(request.messages, { title: '合成事件', text: 'U5约U6明天见；示例甲 example@example.com 13800138000' })
    const prepared = await service.prepareAnalysis({ conversationId: '1', modelId: 'model' })
    const task = await service.confirmAnalysis({ token: prepared.token, requestId: 'memory-processing' })
    await service.idle()
    expect(repository.getAnalysis(task.id)).toMatchObject({ state: 'completed', analyzedMessages: 6 })
    expect(requests).toHaveLength(2)
    expectProcessedSources(userPayload(requests[0]).messages)
    expect(userPayload(requests[1]).events[0].text).toBe('U5约U6明天见；U2 [邮箱] [手机号]')
    expect(JSON.stringify(requests)).not.toMatch(/testtoken1234567890|abcdefghijklmnopqrstuv|4111111111111111|378282246310005|<appmsg>|示例甲|example@example\.com|13800138000/)
    expect(store.reader.prepare('SELECT text FROM messages ORDER BY id').all()).toEqual(originals.map(({ text }) => ({ text })))
  }, 20000)
})
