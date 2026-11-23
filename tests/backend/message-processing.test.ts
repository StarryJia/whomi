import { expect, test } from 'vitest'
import { defaultProcessing } from '../../src/shared/settings-contract'
import { createMessageProcessor } from '../../electron/main/message-processing'

test('processing merges consecutive known-time messages and preserves every source id without mutating originals', () => {
  const messages = [{ id: '1', memberId: '7', senderName: '小林', text: '不是', sourceIds: ['1'], kind: 'text', sentAtMs: 1000 }, { id: '2', memberId: '7', senderName: '小林', text: '不在乎', kind: 'text', sentAtMs: 2000 }, { id: '3', memberId: '8', senderName: '小叶', text: '🙂', kind: 'sticker', sentAtMs: 3000 }]
  const original = structuredClone(messages)
  const result = createMessageProcessor({ ...defaultProcessing, merge: true }, [{ id: '7', displayName: '小林' }, { id: '8', displayName: '小叶' }]).messages(messages)
  expect(result).toHaveLength(2)
  expect(result[0]).toMatchObject({ senderName: 'U7', text: '不是\n不在乎', sourceIds: ['1', '2'] })
  expect(result[1].text).toBe('🙂')
  expect(messages).toEqual(original)
})

test('同名消息缺少成员编号时保持独立', () => {
  const processor = createMessageProcessor({ ...defaultProcessing, merge: true, anonymize: false }, [])
  const first = { id: '1', senderName: '示例成员', text: '第一条', kind: 'text', sentAtMs: 1000 }
  const second = { ...first, id: '2', text: '第二条', sentAtMs: 2000 }
  expect(processor.messages([first, second]).map(item => item.sourceIds)).toEqual([['1'], ['2']])
})

test('a segment uses the first message time and ends on a different speaker or an unknown time', () => {
  const processor = createMessageProcessor({ ...defaultProcessing, merge: true, mergeSeconds: 180 }, [])
  const message = (id: string, sentAtMs: number | null, memberId = '7') =>
    ({ id, memberId, senderName: '示例', kind: 'text', text: id, sentAtMs })
  const result = processor.messages([
    message('1', 0), message('2', 120_000), message('3', 180_000), message('4', 180_001),
    message('5', 181_000, '8'), message('6', 182_000), message('7', null), message('8', 183_000),
  ])
  expect(result.map(({ sourceIds, sentAtMs }) => [sourceIds, sentAtMs])).toEqual([
    [['1', '2', '3'], 0], [['4'], 180_001], [['5'], 181_000], [['6'], 182_000], [['7'], null], [['8'], 183_000],
  ])
})

test('selected redactions protect question, history and profile text while preserving source identifiers', () => {
  const processor = createMessageProcessor(defaultProcessing, [])
  const text = '邮箱 person@example.com 手机 13800138000 密钥 sk-abcdefghijklmnopqrstuv Bearer testtoken1234567890'
  expect(processor.text(text)).not.toMatch(/person@|13800138000|abcdefghijkl|testtoken/)
  expect(processor.data({ evidenceMessageIds: ['13800138000'], text })).toMatchObject({ evidenceMessageIds: ['13800138000'] })
  expect(processor.text('https://example.com 192.0.2.1')).toBe('https://example.com 192.0.2.1')
})

test('cleaning only recognizes card structure; denoise preserves speech and unknown timestamps never merge', () => {
  const processor = createMessageProcessor({ ...defaultProcessing, denoise: true }, [])
  const messages = [
    { id: '1', senderName: '甲', text: '<msg><appmsg><title>文章标题</title><url>https://example.com</url></appmsg></msg>', kind: 'link' },
    { id: '2', senderName: '甲', text: '不', kind: 'text' }, { id: '3', senderName: '甲', text: '嗯', kind: 'text' },
    { id: '4', senderName: '甲', text: '[动画表情]', kind: 'sticker' }, { id: '5', senderName: '甲', text: ' ', kind: 'system' },
  ]
  const result = processor.messages(messages)
  expect(result).toHaveLength(4)
  expect(result[0].text).toBe('文章标题\nhttps://example.com')
  expect(result.slice(1).map(item => item.text)).toEqual(['不', '嗯', '[动画表情]'])
})

test('disabling transforms preserves content and invalid card numbers are not treated as financial identifiers', () => {
  const processor = createMessageProcessor({ ...defaultProcessing, merge: false, clean: false, denoise: false, anonymize: false, redact: false }, [])
  expect(processor.text('小林 person@example.com')).toBe('小林 person@example.com')
  expect(createMessageProcessor(defaultProcessing, []).text('1234567890123456')).toBe('1234567890123456')
})

test('redaction also protects sender names when nickname anonymization is off', () => {
  const result = createMessageProcessor({ ...defaultProcessing, anonymize: false }, []).messages([{ id: '1', senderName: 'private@example.com', text: 'hello', kind: 'text' }])
  expect(result[0].senderName).toBe('[邮箱]')
})

test('email redaction preserves invalid addresses and recognizes adjacent valid ones', () => {
  const processor = createMessageProcessor({ ...defaultProcessing, rules: ['email'] }, [])
  expect(processor.text('broken@localhost a@one.example+b@two.example')).toBe('broken@localhost [邮箱][邮箱]')
})

test.each([
  ['Bearer', 'Bearer testtoken1234567890', '[授权令牌]'],
  ['sk', 'sk-abcdefghijklmnopqrstuv', '[接口密钥]'],
  ['接口密钥', '接口密钥 sk-abcdefghijklmnopqrstuv', '接口密钥 [接口密钥]'],
  ['邮箱', '邮箱 person@example.com', '邮箱 [邮箱]'],
])('nickname %s cannot alter sensitive values or generated redaction labels', (displayName, input, expected) => {
  const processor = createMessageProcessor(defaultProcessing, [{ id: '7', displayName }])
  expect(processor.text(input)).toBe(expected)
})

test('anonymization and redaction switches remain independent for a credential-like nickname', () => {
  const members = [{ id: '7', displayName: 'Bearer' }]
  const input = 'Bearer testtoken1234567890'
  expect(createMessageProcessor({ ...defaultProcessing, redact: false }, members).text(input)).toBe(input)
  expect(createMessageProcessor({ ...defaultProcessing, anonymize: false }, members).text(input)).toBe('[授权令牌]')
  expect(createMessageProcessor({ ...defaultProcessing, rules: [] }, members).text(input)).toBe(input)
})

test('a selected URL rule covers the whole address even when it contains a credential', () => {
  const input = 'https://example.invalid/sk-abcdefghijklmnopqrstuv/private-path'
  expect(createMessageProcessor({ ...defaultProcessing, rules: ['key', 'url'] }, []).text(input)).toBe('[网址]')
  expect(createMessageProcessor({ ...defaultProcessing, rules: ['key'] }, []).text(input)).toBe('https://example.invalid/[接口密钥]/private-path')
})

test('the password rule only masks an explicitly assigned value in the same original message', () => {
  const processor = createMessageProcessor({ ...defaultProcessing, merge: true, rules: ['password'] }, [])
  const chat = { id: '1', memberId: '7', senderName: '小陈', kind: 'text', sentAtMs: 0, text: '密码：Cedar!42，明早见' }
  const messages = [
    chat, { ...chat, id: '2', text: 'password="Blue Bird 42!"' },
    { ...chat, id: '3', text: '密码：' }, { ...chat, id: '4', text: 'Cedar!42' },
    { ...chat, id: '5', text: '我忘了密码，订单号：Cedar42，验证码：123456' },
  ]
  expect(processor.messages(messages)[0].text).toBe([
    '密码：[密码]，明早见', 'password="[密码]"', '密码：', 'Cedar!42', '我忘了密码，订单号：Cedar42，验证码：123456',
  ].join('\n'))
  expect(chat.text).toBe('密码：Cedar!42，明早见')
  expect(createMessageProcessor({ ...defaultProcessing, rules: [] }, []).text(chat.text)).toBe(chat.text)
  expect(createMessageProcessor({ ...defaultProcessing, redact: false }, []).text(chat.text)).toBe(chat.text)
})

test('only the sender is anonymized even when their nickname occurs in the message', () => {
  const processor = createMessageProcessor(defaultProcessing, [{ id: '7', displayName: '小陈' }])
  const original = { id: '9', memberId: '7', senderName: '小陈', text: '小陈说明天一起见陈洁', kind: 'text' }
  expect(processor.messages([original])).toEqual([
    { ...original, senderName: 'U7', text: '小陈说明天一起见陈洁', sourceIds: ['9'] },
  ])
  expect(original.senderName).toBe('小陈')
})

test.each([
  ['密码：“Blue Bird 42!”，明早见', '密码：“[密码]”，明早见'],
  ['密码是： Cedar!42，明早见', '密码是： [密码]，明早见'],
  ['密码　：　Cedar!42，明早见', '密码　：　[密码]，明早见'],
  ['{"password"\r\n:\n  "Blue Bird 42!", "note":"hello"}', '{"password"\r\n:\n  "[密码]", "note":"hello"}'],
  ['password: `Blue Bird 42!`', 'password: `[密码]`'],
  ['密码：\n明早见', '密码：\n明早见'],
  ["password=Pine's47", 'password=[密码]'],
  ['password=Blue"Bird42', 'password=[密码]'],
  ['密码是否过期？密码是什么？', '密码是否过期？密码是什么？'],
  ['密码是什么?password="Blue Bird 42!"', '密码是什么?password="[密码]"'],
  ['密码：Bearer demo-token-value', '密码：[授权令牌]'],
  ['密码：4111 1111 1111 1111', '密码：[银行卡号]'],
  ['密码：4111111111111111', '密码：[银行卡号]'],
  ['password="Bearer demo-token extra word"', 'password="[密码]"'],
])('explicit passwords preserve question text and cover overlapping credential rules: %s', (input, expected) => {
  const processor = createMessageProcessor(defaultProcessing, [])
  expect(processor.text(input)).toBe(expected)
  expect(processor.data({ quote: expected })).toEqual({ quote: expected })
})

test('processing model reports again preserves existing aliases and redaction labels', () => {
  const processor = createMessageProcessor(defaultProcessing, [
    { id: '1', displayName: '小林' }, { id: '2', displayName: 'U1' }, { id: '3', displayName: '邮箱' },
  ])
  expect(processor.data({ summary: 'U1约U2明天见，联系[邮箱]' })).toEqual({ summary: 'U1约U2明天见，联系[邮箱]' })
  expect(processor.text('小林约U1明天见')).toBe('小林约U1明天见')
})

test('model output preserves every member alias even when display names are shared', () => {
  const processor = createMessageProcessor(defaultProcessing, [
    { id: '1', displayName: '小林' }, { id: '2', displayName: '小林' }, { id: '3', displayName: 'U1' },
  ])
  expect(processor.messages([{ id: '9', memberId: '1', senderName: '小林', kind: 'text', text: '明天见' }])[0].senderName).toBe('U1')
  expect(processor.data({ senderName: 'U1', text: 'U1约U3明天见，联系 person@example.com' }))
    .toEqual({ senderName: 'U1', text: 'U1约U3明天见，联系 [邮箱]' })
})

test.each([
  ['4111111111111111 123', '[银行卡号] 123'],
  ['123 4111111111111111', '123 [银行卡号]'],
  ['378282246310005 4111 1111 1111 1111', '[银行卡号] [银行卡号]'],
  ['4111-1111-1111-1111', '[银行卡号]'],
  ['4000000000000000006', '[银行卡号]'],
  ['4111111111111111003', '[银行卡号]'],
  ['4111 1111 1111 1111 003', '[银行卡号]'],
  ['1234567890123456', '1234567890123456'],
  ['41111111111111111234', '41111111111111111234'],
])('financial redaction respects separate number groups: %s', (input, expected) => {
  expect(createMessageProcessor(defaultProcessing, []).text(input)).toBe(expected)
})

test('financial redaction preserves rule selection and text outside the card', () => {
  const input = '4111111111111111 123'
  const members = [{ id: '7', displayName: '123' }]
  expect(createMessageProcessor({ ...defaultProcessing, rules: ['credit-card'] }, members).text(input)).toBe('[信用卡号] 123')
  expect(createMessageProcessor({ ...defaultProcessing, rules: [] }, []).text(input)).toBe(input)
})

test.each(['13800138001', '+86 13800138002'])('an adjacent mobile number %s and grouped card respect each rule selection', mobile => {
  const input = `${mobile} 4111 1111 1111 1111`
  expect(createMessageProcessor(defaultProcessing, []).text(input)).toBe('[手机号] [银行卡号]')
  expect(createMessageProcessor({ ...defaultProcessing, rules: ['bank-card'] }, []).text(input)).toBe(`${mobile} [银行卡号]`)
  expect(createMessageProcessor({ ...defaultProcessing, rules: ['mobile'] }, []).text(input)).toBe('[手机号] 4111 1111 1111 1111')
  expect(createMessageProcessor({ ...defaultProcessing, rules: [] }, []).text(input)).toBe(input)
})

test('a grouped card is protected alongside and across other credential matches', () => {
  const processor = createMessageProcessor(defaultProcessing, [])
  expect(processor.text('Bearer 220 4111 1111 1111 1111')).toBe('[授权令牌] [银行卡号]')
  expect(processor.text('密码：220 4111 1111 1111 1111')).toBe('密码：[密码] [银行卡号]')
  expect(processor.text('400 13800138001 12')).toBe('[银行卡号]')
  const cardsOnly = createMessageProcessor({ ...defaultProcessing, rules: ['bank-card'] }, [])
  expect(cardsOnly.text('Bearer 220 4111 1111 1111 1111')).toBe('Bearer 220 [银行卡号]')
  expect(cardsOnly.text('+86 13800138002 105')).toBe('+[银行卡号]')
})

test.each(['<?xml version="1.0"?>', '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n'])('cleans a share card with declaration %s without changing the original', declaration => {
  const original = { id: '1', senderName: '甲', kind: 'link', text: `${declaration}<msg><appmsg><title><![CDATA[示例标题]]></title><url>https://example.invalid?a=1&amp;b=2</url></appmsg></msg>` }
  const processor = createMessageProcessor(defaultProcessing, [])
  expect(processor.messages([original])[0]).toMatchObject({ id: '1', sourceIds: ['1'], text: '示例标题\nhttps://example.invalid?a=1&b=2' })
  expect(original.text).toContain(declaration)
  expect(createMessageProcessor({ ...defaultProcessing, clean: false }, []).messages([original])[0].text).toBe(original.text)
})

test('an XML declaration alone does not turn unrelated structured text into a share card', () => {
  const text = '<?xml version="1.0"?><data><title>示例标题</title><url>https://example.invalid</url></data>'
  expect(createMessageProcessor(defaultProcessing, []).messages([{ id: '1', senderName: '甲', kind: 'text', text }])[0].text).toBe(text)
})
