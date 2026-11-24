import { expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { collect, parseSynthetic } from './parser-helpers'
import { normalizeModel } from '../../src/shared/conversation-model'

it.each(['echotrace', 'weflow'])('按微信结构标识处理撤回，不根据普通正文或引用内容猜测：%s', async id => {
  const sample = JSON.parse(await readFile('tests/fixtures/import/echotrace/recall.json', 'utf8'))
  if (id === 'weflow') { delete sample.exportInfo; sample.weflow = { version: '1' } }
  sample.messages.push({ ...sample.messages[3], serverId: '107', localType: 10002, content: '他提过撤回了一条消息，周六再聊。' })
  sample.messages.push({ ...sample.messages[1], serverId: '108', typeName: '引用消息' })
  const events = await parseSynthetic(id, JSON.stringify(sample))
  const messages = events.flatMap(event => event.type === 'message' ? [event.value] : [])
  expect(messages.map(m => m.kind)).toEqual(['text', 'system', 'system', 'text', 'text', 'reply', 'text', 'system'])
  expect(messages.slice(1, 3).map(m => [m.senderKind, m.senderKey, m.senderName, m.extra.selfHint])).toEqual([
    ['system', null, '', undefined], ['system', null, '', undefined],
  ])
  expect(messages[3]).toMatchObject({ senderKey: 'example-peer', text: messages[1].text })
  expect(messages[5].reply?.text).toBe(messages[1].text)
})

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
    { localType: 49, rawContent: '<msg><appmsg><type>76</type><url>https://example.invalid/music</url><songlyric/></appmsg></msg>' },
    { localType: 49, rawContent: '<msg><appmsg><type>36</type><url>https://example.invalid/app</url><weappinfo/></appmsg></msg>' },
    { localType: 49, rawContent: '<msg><appmsg><type>5</type></appmsg></msg>\n\0\0' },
    { localType: 49, rawContent: '<msg><appmsg><type>8</type></appmsg></msg>\n\0\0' },
    { localType: 49, rawContent: '<msg><appmsg><type>5\0</type></appmsg></msg>' },
    { localType: 49, rawContent: '<msg><appmsg><type>6</type></appmsg></msg>\n\0\0' },
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
    'link', 'link', 'link', 'sticker', 'unknown', 'unknown',
  ])
  expect(parsed.map(message => message.text)).toEqual(messages.map(message => message.content))
  expect(parsed.every(message => message.senderKey === 'example-peer' && message.senderName === '示例发送者')).toBe(true)
  expect(parsed[17].sentAtMs).toBe(1700000017000)
  expect(parsed[10].reply).toMatchObject({ originalId: '101', idNamespace: 'wechat:server-message', text: '合成正文 1' })
  expect(events.flatMap(event => event.type === 'issue' ? [event.value] : [])).toEqual(
    [11, 12, 13, 14, 15, 16, 17, 22, 23, 28, 29].map(ordinal => expect.objectContaining({ code: 'unknown-type', severity: 'warning', ordinal })),
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

it('logs one aggregate of unknown type causes without logging source strings', async () => {
  const unsupportedShare = { localType: 49, rawContent: '<msg><appmsg><type>987</type><title>synthetic title</title></appmsg></msg>' }
  const examples = [
    { localType: 1 },
    unsupportedShare,
    { localType: 49, rawContent: '<msg><appmsg/></msg>' },
    unsupportedShare,
    { localType: 49, rawContent: '<msg><appmsg>' },
    { localType: 266287972401, rawContent: '<msg><appmsg><type>5</type></appmsg></msg>' },
    { localType: 987 },
    { localType: 11000, typeName: '类型11000', rawContent: '', content: '[类型11000]' },
  ]
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await parseSynthetic('echotrace', JSON.stringify({
      exportInfo: { exporter: 'SIWX', wxid: 'synthetic owner' },
      session: { displayName: 'synthetic conversation', wxid: 'synthetic peer', type: '私聊', messageCount: examples.length },
      messages: examples.map((entry, index) => ({
        senderUsername: 'synthetic peer', senderDisplayName: 'synthetic name',
        createTime: 1700000000 + index, content: 'synthetic body', ...entry,
      })),
    }))
    expect(warn).toHaveBeenCalledOnce()
    const [line] = warn.mock.calls[0]
    expect(line).toMatch(/^\[导入诊断\] /)
    expect(JSON.parse(line.slice('[导入诊断] '.length))).toEqual({
      format: 'echotrace',
      unknownCount: 7,
      details: [
        { reason: '应用消息子类型尚未支持', type: 49, subtype: 987, count: 2, firstRecord: 2 },
        { reason: '缺少应用消息子类型', type: 49, count: 1, firstRecord: 3 },
        { reason: '应用消息格式无效', type: 49, count: 1, firstRecord: 5 },
        { reason: '应用消息子类型冲突', type: 49, subtype: 5, alternateSubtype: 62, count: 1, firstRecord: 6 },
        { reason: '消息类型尚未支持', type: 987, count: 1, firstRecord: 7 },
        { reason: '导出正文为类型占位', type: 11000, count: 1, firstRecord: 8 },
      ],
      otherCount: 0,
    })
  } finally { warn.mockRestore() }
})
