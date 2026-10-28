import { expect, test } from 'vitest'
import { normalizeModel } from '../../src/shared/conversation-model'
import { message } from './helpers'
test('preserves message text, zero and negative timestamps', () => {
  expect(normalizeModel(message({ text: ' 好\n', sentAtMs: 0 })).text).toBe(' 好\n')
  expect(normalizeModel(message({ sentAtMs: 0 })).sentAtMs).toBe(0)
  expect(normalizeModel(message({ sentAtMs: -1 })).sentAtMs).toBe(-1)
})
test('accepts member, reply and attachment descriptions without changing content', () => {
  const input=message({senderKind:'member',senderKey:'alice',kind:'unknown',text:' 原文\n',reply:{originalId:'9007199254740993',idNamespace:'n',text:' 引文 ',senderName:'Alice',sentAtMs:0},attachments:[{kind:'file',locator:'missing.txt',name:'附件',state:'missing'}]})
  expect(normalizeModel(input)).toEqual(input)
})
test.each([null, {}, message({ ordinal: -1 }), message({ sentAtMs: 1.5 }), message({ sentAtMs: Number.MAX_SAFE_INTEGER + 1 }), message({ senderKind: 'robot' }), message({ attachments: [{kind:'file', locator:null, name:null, state:'ready'}] }), message({ reply: { originalId: null } }), message({ extra: [] }), message({ modelVersion: 2 })])('rejects malformed runtime message %#', value => {
  expect(() => normalizeModel(value)).toThrow()
})
