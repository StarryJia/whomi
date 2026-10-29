import { expect, it } from 'vitest'
import { collect } from './parser-helpers'
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

it('rejects empty or half-specified stable message/reply keys', async () => {
  const events = await collect('echotrace')
  const message = events.find(e => e.type === 'message')!
  if (message.type !== 'message') throw new Error('missing message')
  expect(() => normalizeModel({ ...message.value, originalId: '', idNamespace: 'wechat' })).toThrow()
  expect(() => normalizeModel({ ...message.value, originalId: 'one', idNamespace: null })).toThrow()
  expect(() => normalizeModel({ ...message.value, reply: { originalId: '', idNamespace: '', text: 'quote', senderName: null, sentAtMs: null } })).toThrow()
})
