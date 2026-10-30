import { expect, test } from 'vitest'
import { defaultProcessing } from '../../src/shared/settings-contract'
import { createMessageProcessor } from '../../electron/main/message-processing'

test('processing merges consecutive known-time messages and preserves every source id without mutating originals', () => {
  const messages = [{ id: '1', memberId: '7', senderName: '小林', text: '不是', kind: 'text', sentAtMs: 1000 }, { id: '2', memberId: '7', senderName: '小林', text: '不在乎', kind: 'text', sentAtMs: 2000 }, { id: '3', memberId: '8', senderName: '小叶', text: '🙂', kind: 'sticker', sentAtMs: 3000 }]
  const original = structuredClone(messages)
  const result = createMessageProcessor(defaultProcessing, [{ id: '7', displayName: '小林' }, { id: '8', displayName: '小叶' }]).messages(messages)
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
