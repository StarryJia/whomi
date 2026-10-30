import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'
import { openStore } from '../../electron/data/db/open'
import { purgeConversation } from '../../electron/data/db/purge'
import { createQueries } from '../../electron/data/db/queries'
import { temporaryStore } from './helpers'
import { parseSynthetic } from './parser-helpers'

test('deleting a conversation with resolved replies preserves other conversations and foreign keys', () => {
  const temp = temporaryStore()
  const store = openStore(temp.path)
  try {
    store.writer.exec(`
      INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'删除示例','direct',0),(2,'保留示例','direct',0);
      INSERT INTO messages(id,conversation_id,sender_kind,sender_name,kind,text,ordinal)
        VALUES(1,1,'unknown','示例甲','text','原消息',0),(2,1,'unknown','示例乙','reply','回复',1),(3,2,'unknown','示例丙','text','保留正文',0);
      INSERT INTO message_keys(conversation_id,id_namespace,original_id,message_id)
        VALUES(1,'example:message','m1',1),(1,'example:message','m2',2),(2,'example:message','m3',3);
      INSERT INTO message_replies(message_id,conversation_id,target_message_id,original_id,id_namespace,text,state)
        VALUES(2,1,1,'m1','example:message','原消息','resolved');
    `)
    purgeConversation(store, '1')
    expect(store.reader.prepare('SELECT id,text FROM messages').all()).toEqual([{ id: 3n, text: '保留正文' }])
    expect(store.reader.prepare('SELECT id FROM conversations').all()).toEqual([{ id: 2n }])
    expect(store.writer.pragma('foreign_key_check')).toEqual([])
  } finally { store.close(); temp.cleanup() }
})

test.each([
  ['unknown-time', { timestamp: null }, '时间缺失'],
  ['unknown-sender', { sender: null, accountName: null }, '发送者'],
  ['unknown-type', { type: 999 }, '消息类型'],
])('parser warning %s explains its actual cause and retains the record location', async (code, mutation, description) => {
  const input = JSON.parse(await readFile('tests/fixtures/import/chatlab/positive.json', 'utf8'))
  Object.assign(input.messages[0], mutation)
  const events = await parseSynthetic('chatlab', JSON.stringify(input))
  const warning = events.find(event => event.type === 'issue' && event.value.code === code)
  expect(warning?.type).toBe('issue')
  if (warning?.type === 'issue') {
    expect(warning.value.action).toContain(description)
    expect(warning.value.ordinal).toBe(0)
  }
})

test('a reply page includes the real sender and excerpt when its target is outside the page', async () => {
  const temp = temporaryStore(), store = openStore(temp.path)
  try {
    store.writer.exec(`
      INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'引用示例','direct',0);
      INSERT INTO messages(id,conversation_id,sender_kind,sender_name,kind,text,ordinal)
        VALUES(1,1,'unknown','示例甲','text','原消息：明晚一起练习。',0),(2,1,'unknown','示例乙','reply','好的',1);
      INSERT INTO message_keys(conversation_id,id_namespace,original_id,message_id) VALUES(1,'example','m1',1);
      INSERT INTO message_replies(message_id,conversation_id,target_message_id,original_id,id_namespace,state) VALUES(2,1,1,'m1','example','resolved');
    `)
    const queries = createQueries(store)
    const first = await queries.readMessages({ conversationId: '1', direction: 'after', limit: 1 })
    const next = await queries.readMessages({ conversationId: '1', direction: 'after', cursor: first.afterCursor! })
    expect(next.items).toHaveLength(1)
    expect(next.items[0].reply).toMatchObject({ text: '原消息：明晚一起练习。', senderName: '示例甲', targetMessageId: '1' })
  } finally { store.close(); temp.cleanup() }
})
