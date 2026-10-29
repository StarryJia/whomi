import { afterEach, expect, it } from 'vitest'
import { mkdtemp, copyFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { openStore, type Store } from '../../electron/data/db/open'
import { createDataService } from '../../electron/data/service'
import { createDataDispatcher } from '../../electron/data/dispatch'
import { validateResult } from '../../src/shared/desktop-validation'

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
