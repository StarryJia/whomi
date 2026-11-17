import { expect, it } from 'vitest'
import { collect, parseSynthetic } from './parser-helpers'
import { normalizeModel } from '../../src/shared/conversation-model'

it('keeps SIWX kinds, whitespace, unresolved quote and one exact self hint', async () => {
  const events = await collect('echotrace')
  const messages = events.flatMap(e => e.type === 'message' ? [e.value] : [])
  const members = events.flatMap(e => e.type === 'member' ? [e.value] : [])
  expect(messages.map(x => x.kind)).toEqual(['text', 'image', 'reply', 'unknown'])
  expect(messages[2].reply?.originalId).toBeNull()
  expect(messages[2].reply?.text).toBe('原引用\n')
  expect(messages[0].text).toBe(' 好\n')
  expect(members.filter(x => x.selfHint).length).toBe(1)
  expect(messages[0].originalId).toBe('9007199254740993123')
  expect(messages[1].attachments[0].state).toBe('missing')
  expect(messages[3].senderKind).toBe('unknown')
  expect(messages[3].sentAtMs).toBeNull()
  expect(events.some(e => e.type === 'issue' && e.value.code === 'owner-conflict')).toBe(true)
  expect(messages[0].sentAtMs).toBe(1700000000000)
  expect(messages[1].sentAtMs).toBe(1700000000123)
})

it('recognizes SIWX application subtypes, contact cards and calls while retaining unrecognized records', async () => {
  const examples = [
    { localType: 1, typeName: '文本消息' },
    { localType: 49, typeName: '链接/文件', rawContent: 'example-peer:\n<msg><appmsg appid=""><title>活动</title><type>5</type></appmsg></msg>' },
    { localType: 49, typeName: '链接/文件', rawContent: '<msg><appmsg><type><![CDATA[6]]></type></appmsg></msg>' },
    { localType: 49, typeName: '链接/文件', rawContent: '<msg><appmsg><type>19</type></appmsg></msg>' },
    { localType: 49, typeName: '链接/文件', rawContent: '<msg><appmsg><type>62</type></appmsg></msg>' },
    { localType: '266287972401', typeName: '拍一拍' },
    { localType: 42, typeName: '名片消息' },
    { typeName: '名片消息' },
    { localType: '50' },
    { typeName: '通话消息' },
    { localType: 49, typeName: '链接/文件', rawContent: '<msg><appmsg><type>57</type><refermsg><svrid>101</svrid></refermsg></appmsg></msg>',
      quote: { content: '合成正文 1', displayname: '示例发送者', ts: 1700000000 } },
    { localType: 49, typeName: '链接/文件', rawContent: '<msg><appmsg><type>987</type></appmsg></msg>' },
    { localType: 49, typeName: '链接/文件', rawContent: '<msg><appmsg><nested><type>5</type></nested></appmsg></msg>' },
    { localType: 49, typeName: '链接/文件', rawContent: '<msg><appmsg><type>5</type></appmsg>' },
    { localType: 49, typeName: '链接/文件', rawContent: '<msg><appmsg><type>5</type><type>5</type></appmsg></msg>' },
    { localType: 266287972401, typeName: '链接/文件', rawContent: '<msg><appmsg><type>5</type></appmsg></msg>' },
    { localType: 49, typeName: '链接/文件' },
    { localType: 62 },
    { localType: 49, rawContent: '<msg><appmsg><type>4</type></appmsg></msg>' },
    { localType: 49, rawContent: '<msg><appmsg><type>8</type></appmsg></msg>' },
    { localType: 49, rawContent: '<msg><appmsg type="19"/></msg>' },
    { localType: 49, typeName: '文件消息', rawContent: '示例文件' },
    { localType: 49, rawContent: '<appmsg><type>5</type>' + '<a>'.repeat(129) + '</a>'.repeat(129) + '</appmsg>' },
    { localType: 49, rawContent: '<msg><appmsg>', quote: { bad: true } },
  ]
  const messages = examples.map((entry, index) => ({
    ...entry, serverId: String(101 + index), senderUsername: 'example-peer', senderDisplayName: '示例发送者',
    createTime: 1700000000 + index, content: `合成正文 ${index + 1}`,
  }))
  const events = await parseSynthetic('echotrace', JSON.stringify({
    exportInfo: { exporter: 'SIWX', wxid: 'example-owner' },
    session: { wxid: 'example-peer', type: '私聊', messageCount: messages.length },
    messages,
  }))
  const parsed = events.flatMap(event => event.type === 'message' ? [event.value] : [])
  expect(parsed.map(message => message.kind)).toEqual([
    'text', 'link', 'file', 'forward', 'poke', 'poke', 'contact', 'contact', 'call', 'call', 'reply',
    'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown',
    'link', 'sticker', 'forward', 'file', 'unknown', 'unknown',
  ])
  expect(parsed.map(message => message.text)).toEqual(messages.map(message => message.content))
  expect(parsed.every(message => message.senderKey === 'example-peer' && message.senderName === '示例发送者')).toBe(true)
  expect(parsed[17].sentAtMs).toBe(1700000017000)
  expect(parsed[10].reply).toMatchObject({ originalId: '101', idNamespace: 'wechat:server-message', text: '合成正文 1' })
  expect(events.flatMap(event => event.type === 'issue' ? [event.value] : [])).toEqual(
    [11, 12, 13, 14, 15, 16, 17, 22, 23].map(ordinal => expect.objectContaining({ code: 'unknown-type', severity: 'warning', ordinal })),
  )
})

it('rejects empty or half-specified stable message/reply keys', async () => {
  const events = await collect('echotrace')
  const message = events.find(e => e.type === 'message')!
  if (message.type !== 'message') throw new Error('missing message')
  expect(() => normalizeModel({ ...message.value, originalId: '', idNamespace: 'wechat' })).toThrow()
  expect(() => normalizeModel({ ...message.value, originalId: 'one', idNamespace: null })).toThrow()
  expect(() => normalizeModel({ ...message.value, reply: { originalId: '', idNamespace: '', text: 'quote', senderName: null, sentAtMs: null } })).toThrow()
})
