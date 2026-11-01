import { expect, test, vi } from 'vitest'
import { createSettingsService } from '../../electron/main/settings-service'
import type { ChatgptStatus } from '../../src/shared/chatgpt-plan'

function setup() {
  let status: ChatgptStatus = { state: 'connected', accountId: 'whomi-a' }
  const read = vi.fn().mockResolvedValue({ state: 'disconnected' })
  const storage = vi.fn().mockResolvedValue({ models: [] })
  const accounts = { 'openai-codex': { getStatus: async () => status, signIn: vi.fn(), cancel: vi.fn(), signOut: vi.fn(async () => { status = { state: 'disconnected' } }), listModels: vi.fn() } }
  const service = createSettingsService({ accounts, codexQuota: { read, close: vi.fn() }, storage, secrets: { encrypt: String, decrypt: String }, testModel: async () => {}, beforeModelChange: async () => {} })
  return { service, read, storage, change: (value: ChatgptStatus) => { status = value } }
}

test('quota settings verify expected Whomi owner and reject invalid actions before accessing credentials', async () => {
  const f = setup()
  await expect(f.service.getCodexQuota('whomi-b', 'connect')).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' })
  await expect(f.service.getCodexQuota('whomi-a', 'invalid' as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  expect(f.read).not.toHaveBeenCalled()
  await f.service.getCodexQuota('whomi-a', 'read')
  expect(f.read).toHaveBeenCalledWith('whomi-a', 'read')
})

test('logout does not wait on quota requests, disconnects the source, and discards late responses', async () => {
  const f = setup()
  let finish!: (value: unknown) => void
  f.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = f.service.getCodexQuota('whomi-a', 'connect')
  await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce())
  await f.service.signOutAccount('openai-codex')
  expect(f.read).toHaveBeenLastCalledWith('whomi-a', 'disconnect')
  finish({ state: 'ready', source: { email: 'previous' } })
  expect(await pending).toEqual({ state: 'disconnected' })
})

test('new quota requests cannot reconnect while logout is waiting for storage', async () => {
  const f = setup()
  let release!: () => void
  f.storage.mockResolvedValueOnce({ models: [] }).mockImplementationOnce(() => new Promise<void>(done => { release = done }))
  const logout = f.service.signOutAccount('openai-codex')
  await vi.waitFor(() => expect(f.storage).toHaveBeenCalledTimes(2))
  try {
    await expect(f.service.getCodexQuota('whomi-a', 'connect')).rejects.toMatchObject({ code: 'ACCOUNT_BUSY' })
    expect(f.read).toHaveBeenCalledTimes(1)
  } finally { release(); await logout }
  await expect(f.service.getCodexQuota('whomi-a', 'read')).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' })
  f.change({ state: 'connected', accountId: 'whomi-a' })
  f.storage.mockRejectedValueOnce(new Error('fixture storage failed'))
  await expect(f.service.signOutAccount('openai-codex')).rejects.toThrow('fixture storage failed')
  await expect(f.service.getCodexQuota('whomi-a', 'read')).resolves.toEqual({ state: 'disconnected' })
})
