import { expect, test } from 'vitest'
import { defaultProcessing } from '../../src/shared/settings-contract'
import { createMessageProcessor } from '../../electron/main/message-processing'

test('processing merges consecutive known-time messages and preserves every source id without mutating originals', () => {
  const messages = [{ id: '1', memberId: '7', senderName: '小林', text: '不是', kind: 'text', sentAtMs: 1000 }, { id: '2', memberId: '7', senderName: '小林', text: '不在乎', kind: 'text', sentAtMs: 2000 }, { id: '3', memberId: '8', senderName: '小叶', text: '🙂', kind: 'sticker', sentAtMs: 3000 }]
  const original = structuredClone(messages)
  const result = createMessageProcessor({ ...defaultProcessing, merge: true }, [{ id: '7', displayName: '小林' }, { id: '8', displayName: '小叶' }]).messages(messages)
  expect(result).toHaveLength(2)
  expect(result[0]).toMatchObject({ senderName: 'U7', text: '不是\n不在乎', sourceIds: ['1', '2'] })
  expect(result[1].text).toBe('🙂')
  expect(messages).toEqual(original)
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

test.each([
  ['Bearer', 'Bearer testtoken1234567890', '[授权令牌]'],
  ['sk', 'sk-abcdefghijklmnopqrstuv', '[接口密钥]'],
  ['接口密钥', '接口密钥 sk-abcdefghijklmnopqrstuv', 'U7 [接口密钥]'],
  ['邮箱', '邮箱 person@example.com', 'U7 [邮箱]'],
])('nickname %s cannot alter sensitive values or generated redaction labels', (displayName, input, expected) => {
  const processor = createMessageProcessor(defaultProcessing, [{ id: '7', displayName }])
  expect(processor.text(input)).toBe(expected)
})

test('anonymization and redaction switches remain independent for a credential-like nickname', () => {
  const members = [{ id: '7', displayName: 'Bearer' }]
  const input = 'Bearer testtoken1234567890'
  expect(createMessageProcessor({ ...defaultProcessing, redact: false }, members).text(input)).toBe('U7 testtoken1234567890')
  expect(createMessageProcessor({ ...defaultProcessing, anonymize: false }, members).text(input)).toBe('[授权令牌]')
  expect(createMessageProcessor({ ...defaultProcessing, rules: [] }, members).text(input)).toBe('U7 testtoken1234567890')
})

test('a selected URL rule covers the whole address even when it contains a credential', () => {
  const input = 'https://example.invalid/sk-abcdefghijklmnopqrstuv/private-path'
  expect(createMessageProcessor({ ...defaultProcessing, rules: ['key', 'url'] }, []).text(input)).toBe('[网址]')
  expect(createMessageProcessor({ ...defaultProcessing, rules: ['key'] }, []).text(input)).toBe('https://example.invalid/[接口密钥]/private-path')
})

test('anonymization never matches generated aliases and retains source identity', () => {
  const processor = createMessageProcessor(defaultProcessing, [{ id: '1', displayName: '小林' }, { id: '2', displayName: 'U1' }])
  const original = { id: '9', memberId: '1', senderName: '小林', text: '小林约U1明天见', kind: 'text' }
  expect(processor.messages([original])).toEqual([
    { ...original, senderName: 'U1', text: 'U1约U2明天见', sourceIds: ['9'] },
  ])
  expect(original.text).toBe('小林约U1明天见')
})

test('processing model reports again preserves existing aliases and redaction labels', () => {
  const processor = createMessageProcessor(defaultProcessing, [
    { id: '1', displayName: '小林' }, { id: '2', displayName: 'U1' }, { id: '3', displayName: '邮箱' },
  ])
  expect(processor.data({ summary: 'U1约U2明天见，联系[邮箱]' })).toEqual({ summary: 'U1约U2明天见，联系[邮箱]' })
  expect(processor.text('小林约U1明天见')).toBe('U1约U2明天见')
})

test('model output preserves every member alias even when display names are shared', () => {
  const processor = createMessageProcessor(defaultProcessing, [
    { id: '1', displayName: '小林' }, { id: '2', displayName: '小林' }, { id: '3', displayName: 'U1' },
  ])
  expect(processor.messages([{ id: '9', memberId: '1', senderName: '小林', kind: 'text', text: '明天见' }])[0].senderName).toBe('U1')
  expect(processor.modelText('U1约U3明天见，联系 person@example.com')).toBe('U1约U3明天见，联系 [邮箱]')
})

test('nickname matching prefers the longest literal name and preserves single-character prose', () => {
  const processor = createMessageProcessor(defaultProcessing, [
    { id: '1', displayName: '小林' }, { id: '2', displayName: '小林同学' },
    { id: '3', displayName: 'A+B' }, { id: '4', displayName: '我' },
  ])
  expect(processor.text('我请小林同学、小林和A+B一起')).toBe('我请U2、U1和U3一起')
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

test('financial redaction preserves rule selection and still anonymizes text outside the card', () => {
  const input = '4111111111111111 123'
  const members = [{ id: '7', displayName: '123' }]
  expect(createMessageProcessor({ ...defaultProcessing, rules: ['credit-card'] }, members).text(input)).toBe('[信用卡号] U7')
  expect(createMessageProcessor({ ...defaultProcessing, rules: [] }, []).text(input)).toBe(input)
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
