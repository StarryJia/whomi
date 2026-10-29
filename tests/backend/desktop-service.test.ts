import { afterEach, expect, it } from 'vitest'
import { mkdtemp, copyFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { openStore, type Store } from '../../electron/data/db/open'
import { createDataService } from '../../electron/data/service'
import { createDataDispatcher } from '../../electron/data/dispatch'
import { validateResult } from '../../src/shared/desktop-validation'
import type { ImportSnapshot } from '../../src/shared/import-contract'
import type { MemberView, MessagePage } from '../../src/shared/desktop-api'

const resources: { store: Store; directory: string; service: ReturnType<typeof createDataService> }[] = []
afterEach(async () => { for (const { service, store, directory } of resources.splice(0)) { await service.idle(); store.close(); await rm(directory, { recursive: true, force: true }) } })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'whomi-desktop-service-')), store = openStore(join(directory, 'test.db'))
  const service = createDataService({ store, appDataDirectory: directory }); resources.push({ store, directory, service })
  await service.ready
  return { directory, store, service, dispatch: createDataDispatcher(store, service) }
}
it('forwards a controlled candidate preview without attachment locators and refuses stale staging', async () => {
  const { directory, service, dispatch } = await setup()
  const file = join(directory, 'sample.json'); await copyFile(resolve('tests/fixtures/import/chatlab/positive.json'), file)
  const id = await dispatch('prepareImport', [[{ rootPath: file }]]) as string
  const initial = await service.getImport(id)
  await dispatch('startImport', [{ kind: 'stage', jobId: id, entryIds: initial.discovery!.entries.map(entry => entry.entryId) }]); await service.idle()
  const staged = await service.getImport(id), candidate = staged.candidates[0]
  const page = await dispatch('previewImport', [id, candidate.candidateId, { limit: 1 }]) as { messages: unknown[]; nextOrdinal: number | null }
  expect(page.messages).toHaveLength(1); expect(page.nextOrdinal).not.toBeNull()
  expect(JSON.stringify(page)).not.toContain('locator'); expect(() => validateResult('previewImport', page)).not.toThrow()
  await expect(dispatch('previewImport', [id, 'foreign-candidate', {}])).rejects.toMatchObject({ code: 'INVALID_CANDIDATE' })
  await expect(dispatch('previewImport', [id, candidate.candidateId, { limit: 51 }])).rejects.toHaveProperty('code')
  await dispatch('cancelImport', [id])
  await expect(dispatch('previewImport', [id, candidate.candidateId, {}])).rejects.toMatchObject({ code: 'PREVIEW_UNAVAILABLE' })
})
it('rejects unknown IDs and malformed cursors and validates self membership inside its conversation', async () => {
  const { store, dispatch } = await setup()
  await expect(dispatch('readMessages', [{ conversationId: '999', direction: 'after' }])).rejects.toMatchObject({ code: 'INVALID_ID' })
  store.writer.exec("INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'示例 A','group',0),(2,'示例 B','group',0)")
  store.writer.exec("INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(1,2,'test','test');INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name,self_hint) VALUES(1,2,1,'member','示例成员',1)")
  await expect(dispatch('readMessages', [{ conversationId: '1', direction: 'after', cursor: 'a' }])).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
  await expect(dispatch('confirmSelf', ['1', '999'])).rejects.toHaveProperty('code')
  await expect(dispatch('confirmSelf', ['1', '1'])).rejects.toMatchObject({ code: 'INVALID_MEMBER' })
  await dispatch('confirmSelf', ['2', '1'])
  expect(await dispatch('listMembers', ['2'])).toEqual([{ id: '1', displayName: '示例成员', selfHint: true, confirmedSelf: true }])
  await dispatch('confirmSelf', ['2', null])
  expect(await dispatch('listMembers', ['2'])).toEqual([{ id: '1', displayName: '示例成员', selfHint: true, confirmedSelf: false }])
  await expect(dispatch('listMembers', ['999'])).rejects.toMatchObject({ code: 'INVALID_ID' })
  await expect(dispatch('getImport', ['999'])).rejects.toMatchObject({ code: 'INVALID_JOB' })
})
it('returns a staged ChatLab candidate with more than 10000 declared members', async () => {
  const { directory, service, dispatch } = await setup()
  const file = join(directory, 'large-members.json')
  await writeFile(file, JSON.stringify({
    chatlab: { version: '0.0.2' }, meta: { name: 'Synthetic members', platform: 'discord', type: 'group', groupId: 'synthetic-room' },
    members: Array.from({ length: 10001 }, (_, index) => ({ platformId: `member-${index}`, accountName: `Member ${index}` })),
    messages: [{ sender: 'member-0', accountName: 'Member 0', timestamp: 1700000000, type: 0, content: 'Synthetic message' }],
  }))
  const id = await dispatch('prepareImport', [[{ rootPath: file }]]) as string
  const initial = await service.getImport(id)
  await dispatch('startImport', [{ kind: 'stage', jobId: id, entryIds: initial.discovery!.entries.map(entry => entry.entryId) }])
  await service.idle()
  try {
    const staged = await dispatch('getImport', [id]) as ImportSnapshot
    expect(staged.status).toBe('awaiting_commit')
    expect(staged.candidates[0].members).toHaveLength(10001)
    expect(staged.candidates[0].members[10000].sourceKey).toBe('member-10000')
  } finally { await dispatch('cancelImport', [id]) }
})
it('lists every persisted member when a conversation has more than 10000 members', async () => {
  const { store, dispatch } = await setup()
  store.writer.exec("INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'Synthetic members','group',0);INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(1,1,'test','test')")
  const insert = store.writer.prepare('INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES(?,1,1,?,?)')
  store.writer.transaction(() => {
    for (let id = 1; id <= 10001; id++) insert.run(id, `member-${id}`, `Member ${id}`)
  })()
  const members = await dispatch('listMembers', ['1']) as { id: string; displayName: string }[]
  expect(members).toHaveLength(10001)
  expect(members[10000]).toMatchObject({ id: '10001', displayName: 'Member 10001' })
})

async function stageDocuments(context: Awaited<ReturnType<typeof setup>>, documents: unknown[]) {
  const paths = await Promise.all(documents.map(async (document, index) => {
    const path = join(context.directory, `source-${index}.json`)
    await writeFile(path, JSON.stringify(document)); return { rootPath: path }
  }))
  const id = await context.dispatch('prepareImport', [paths]) as string
  const initial = await context.service.getImport(id)
  await context.dispatch('startImport', [{ kind: 'stage', jobId: id, entryIds: initial.discovery!.entries.map(entry => entry.entryId) }])
  await context.service.idle()
  const staged = await context.dispatch('getImport', [id]) as ImportSnapshot
  expect(staged.status).toBe('awaiting_commit')
  return staged
}
function identityDocument(messageId: string, ownerId?: string, platform = 'telegram') {
  return { chatlab: { version: '0.0.2' }, meta: { name: 'Synthetic identity', platform, type: 'group', groupId: 'chat', ...(ownerId ? { ownerId } : {}) },
    members: [{ platformId: 'owner', accountName: 'Same name' }, { platformId: 'other', accountName: 'Same name' }],
    messages: [{ sender: 'owner', accountName: 'Same name', timestamp: 1700000000, type: 0, content: messageId, platformMessageId: messageId }] }
}
async function commitIdentity(context: Awaited<ReturnType<typeof setup>>, staged: ImportSnapshot, conversationId?: string, explicit = false) {
  await context.dispatch('startImport', [{ kind: 'commit', plan: { jobId: staged.jobId, decisions: staged.candidates.map(candidate => ({ candidateId: candidate.candidateId,
    target: conversationId ? { kind: 'existing', conversationId } : { kind: 'new' }, confirmedAliases: [], ...(explicit ? { selfMemberKey: 'owner' } : {}) })) } }])
  await context.service.idle()
  const saved = await context.dispatch('getImport', [staged.jobId]) as ImportSnapshot
  expect(saved.status).toBe('completed')
  return saved.results[0].conversationId!
}
async function selfState(context: Awaited<ReturnType<typeof setup>>, id: string) {
  const page = await context.dispatch('readMessages', [{ conversationId: id, direction: 'after' }]) as MessagePage
  const members = await context.dispatch('listMembers', [id]) as MemberView[]
  return { messages: page.items.map(item => item.isSelf), members: members.map(member => member.confirmedSelf), memberIds: members.map(member => member.id) }
}
it('keeps confirmed self across actual same-account imports, reselection and local opt-out', async () => {
  const context = await setup()
  const first = await stageDocuments(context, [identityDocument('one', 'owner')])
  const id = await commitIdentity(context, first, undefined, true)
  const oldMessage = context.store.reader.prepare('SELECT * FROM messages').all()
  const second = await stageDocuments(context, [identityDocument('two')])
  await commitIdentity(context, second, id)
  let state = await selfState(context, id)
  expect(state.messages).toEqual([true, true]); expect(state.members).toEqual([true, true])
  expect(context.store.reader.prepare('SELECT count(DISTINCT source_conversation_id) AS n,count(DISTINCT account_id) AS accounts FROM memberships').get()).toEqual({ n: 2n, accounts: 1n })
  await context.dispatch('confirmSelf', [id, state.memberIds[1]])
  state = await selfState(context, id)
  expect(state.messages).toEqual([true, true]); expect(state.members).toEqual([true, true])
  expect(context.store.reader.prepare('SELECT * FROM messages WHERE id=1').all()).toEqual(oldMessage)
  await context.dispatch('confirmSelf', [id, null])
  state = await selfState(context, id)
  expect(state.messages).toEqual([false, false]); expect(state.members).toEqual([false, false])
  const third = await stageDocuments(context, [identityDocument('three')]); await commitIdentity(context, third, id)
  expect((await selfState(context, id)).messages).toEqual([false, false, false])
})
it('honors grouped explicit choices for two proven same-account source memberships', async () => {
  const context = await setup()
  const first = await stageDocuments(context, [identityDocument('initial', 'owner')])
  const id = await commitIdentity(context, first, undefined, true)
  const group = await stageDocuments(context, [identityDocument('one', 'owner'), identityDocument('two')])
  await commitIdentity(context, group, id, true)
  expect((await selfState(context, id)).messages).toEqual([true, true, true])
  expect((await selfState(context, id)).members).toEqual([true, true])
})
it('falls back to exact membership for account-less same-name imports and never confirms parser hints', async () => {
  const context = await setup()
  const document = identityDocument('one', 'owner', 'unknown')
  document.messages.push({ ...document.messages[0], sender: 'other', content: 'two', platformMessageId: 'two' })
  const first = await stageDocuments(context, [document])
  const id = await commitIdentity(context, first)
  expect((await selfState(context, id)).messages).toEqual([false, false])
  const initial = await selfState(context, id); await context.dispatch('confirmSelf', [id, initial.memberIds[0]])
  let state = await selfState(context, id)
  expect(state.messages).toEqual([true, false]); expect(state.members).toEqual([true, false])
  await context.dispatch('confirmSelf', [id, state.memberIds[1]])
  state = await selfState(context, id)
  expect(state.messages).toEqual([false, true]); expect(state.members).toEqual([false, true])
})
