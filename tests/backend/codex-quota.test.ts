import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { createCodexQuota } from '../../electron/main/codex-quota'

const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()); vi.useRealTimers() })
const jwt = (value: object) => 'fixture.' + Buffer.from(JSON.stringify(value)).toString('base64url') + '.fixture'
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'whomi-quota-test-')), authPath = join(directory, 'auth.json')
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const writeAuth = (workspace = 'workspace-a', expires = Date.now() / 1000 + 3600) => writeFileSync(authPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    account_id: workspace, access_token: jwt({ exp: expires, 'https://api.openai.com/auth': { chatgpt_user_id: 'user-a' } }),
    id_token: jwt({ email: 'demo@example.invalid', 'https://api.openai.com/auth': { chatgpt_user_id: 'user-a' } }), refresh_token: 'never-copy-refresh'
  } }))
  writeAuth()
  const response = { plan_type: 'prolite', rate_limit: { primary_window: { used_percent: 38, limit_window_seconds: 604800, reset_at: 1794130454 }, secondary_window: null } }
  const request = vi.fn<typeof fetch>(async () => Response.json(response))
  const options = { directory, authPath, vault: { encrypt: (s: string) => s, decrypt: (s: string) => s }, fetch: request }
  const quota = createCodexQuota(options)
  cleanup.push(() => quota.close())
  return { quota, options, response, request, writeAuth, authPath, directory }
}

test('requires explicit connection, retrieves real weekly quota without inventing five hours, and keeps source credentials unchanged', async () => {
  const f = fixture(), before = readFileSync(f.authPath, 'utf8')
  expect(await f.quota.read('whomi-a', 'read')).toEqual({ state: 'disconnected' })
  expect(f.request).not.toHaveBeenCalled()
  const value = await f.quota.read('whomi-a', 'connect')
  expect(value).toMatchObject({ state: 'ready', source: { email: 'demo@example.invalid', workspaceId: 'workspace-a' }, planType: 'prolite', windows: [{ seconds: 604800, remainingPercent: 62, resetsAt: 1794130454000 }] })
  expect(value.state === 'ready' && value.windows).toHaveLength(1)
  const [url, init] = f.request.mock.calls[0]
  expect(url).toBe('https://chatgpt.com/backend-api/wham/usage')
  expect(init?.redirect).toBe('error')
  expect(new Headers(init?.headers).get('ChatGPT-Account-ID')).toBe('workspace-a')
  expect(JSON.stringify(value)).not.toContain('fixture.')
  expect(readFileSync(f.authPath, 'utf8')).toBe(before)
  expect(readFileSync(join(f.directory, 'whomi-codex-quota'), 'utf8')).not.toContain('never-copy-refresh')
  const restarted = createCodexQuota(f.options); cleanup.push(() => restarted.close())
  expect(await restarted.read('whomi-b', 'read')).toEqual({ state: 'disconnected' })
  expect(await restarted.read('whomi-a', 'read')).toMatchObject({ state: 'ready' })
})

test('preserves real zero, supports two returned windows, and does not infer a missing reset', async () => {
  const f = fixture()
  f.request.mockResolvedValueOnce(Response.json({ rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 18000 }, secondary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: 1794130454 } } }))
  expect(await f.quota.read('a', 'connect')).toMatchObject({ state: 'ready', windows: [{ seconds: 18000, remainingPercent: 0, resetsAt: null }, { seconds: 604800, remainingPercent: 100 }] })
  f.request.mockResolvedValueOnce(Response.json({ rate_limit: { primary_window: { used_percent: 99.96, limit_window_seconds: 18000 } } }))
  const fraction = await f.quota.read('a', 'read')
  expect(fraction.state === 'ready' && fraction.windows[0].remainingPercent).toBeCloseTo(0.04)
})

test('same email does not match another workspace; switching before or during a request removes quota until explicitly reconnected', async () => {
  const f = fixture()
  await f.quota.read('a', 'connect')
  f.writeAuth('workspace-b')
  expect(await f.quota.read('a', 'read')).toMatchObject({ state: 'unavailable', reason: 'source-changed' })
  expect(f.request).toHaveBeenCalledTimes(1)
  await f.quota.read('a', 'connect')
  f.request.mockImplementationOnce(async () => { f.writeAuth('workspace-c'); return Response.json(f.response) })
  expect(await f.quota.read('a', 'read')).toMatchObject({ state: 'unavailable', reason: 'source-changed' })
})

test('disconnect cancels a request and cannot be undone by its late response', async () => {
  const f = fixture()
  let resolve!: (value: Response) => void
  f.request.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  const pending = f.quota.read('a', 'connect')
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce())
  expect(await f.quota.read('a', 'disconnect')).toEqual({ state: 'disconnected' })
  resolve(Response.json(f.response))
  expect(await pending).toEqual({ state: 'disconnected' })
  expect(await f.quota.read('a', 'read')).toEqual({ state: 'disconnected' })
})

test('expired or missing credentials never trigger refresh or substitute another account', async () => {
  const f = fixture()
  f.writeAuth('workspace-a', 1)
  expect(await f.quota.read('a', 'connect')).toMatchObject({ state: 'unavailable', reason: 'login-required' })
  rmSync(f.authPath)
  expect(await f.quota.read('a', 'connect')).toMatchObject({ state: 'unavailable', reason: 'login-required' })
  expect(f.request).not.toHaveBeenCalled()
})

test('rejects mismatched response identity, malformed windows, redirects, oversized content and credential-bearing errors', async () => {
  const f = fixture()
  for (const response of [Response.json({ ...f.response, account_id: 'another-workspace' }), Response.json({ rate_limit: { primary_window: { used_percent: -5, limit_window_seconds: 18000 } } }), new Response('', { status: 302, headers: { location: 'https://elsewhere.invalid' } }), new Response('x'.repeat(131073))]) {
    f.request.mockResolvedValueOnce(response)
    await expect(f.quota.read('a', 'connect')).rejects.toMatchObject({ code: 'CODEX_QUOTA_RESPONSE' })
  }
  f.request.mockRejectedValueOnce(new Error('secret fixture.token'))
  await expect(f.quota.read('a', 'connect')).rejects.toMatchObject({ code: 'CODEX_QUOTA_NETWORK', message: expect.not.stringContaining('secret') })
  for (const status of [401, 403]) {
    f.request.mockResolvedValueOnce(new Response('private detail', { status }))
    expect(await f.quota.read('a', 'connect')).toMatchObject({ state: 'unavailable', reason: 'login-required' })
  }
})

test('coalesces concurrent reads and bounds network waiting without disclosing transport errors', async () => {
  const f = fixture()
  await f.quota.read('a', 'connect')
  let started!: () => void
  const waiting = new Promise<void>(done => { started = done })
  f.request.mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) => {
    started(); init!.signal!.addEventListener('abort', () => reject(new Error('private transport token')))
  }))
  vi.useFakeTimers()
  const one = f.quota.read('a', 'read'), two = f.quota.read('a', 'read')
  expect(one).toBe(two)
  const rejected = expect(one).rejects.toMatchObject({ code: 'CODEX_QUOTA_NETWORK', message: expect.not.stringContaining('private') })
  await waiting
  await vi.advanceTimersByTimeAsync(15000)
  await rejected
  expect(f.request).toHaveBeenCalledTimes(2)
})

test('a source change during a failed refresh removes stale data and a null window is never zero', async () => {
  const f = fixture()
  await f.quota.read('a', 'connect')
  f.request.mockImplementationOnce(async () => { f.writeAuth('workspace-b'); throw Error('offline') })
  expect(await f.quota.read('a', 'read')).toEqual({ state: 'unavailable', reason: 'source-changed' })
  f.request.mockResolvedValueOnce(Response.json({ rate_limit: null }))
  expect(await f.quota.read('a', 'connect')).toMatchObject({ state: 'ready', windows: [] })
})

test('unsupported government accounts and legacy API-key records never send credentials to the normal endpoint', async () => {
  const f = fixture(), data = JSON.parse(readFileSync(f.authPath, 'utf8'))
  data.tokens.id_token = jwt({ 'https://api.openai.com/auth': { chatgpt_account_is_fedramp: true, chatgpt_user_id: 'user-a' } })
  writeFileSync(f.authPath, JSON.stringify(data))
  expect(await f.quota.read('a', 'connect')).toEqual({ state: 'unavailable', reason: 'unsupported' })
  delete data.auth_mode; data.OPENAI_API_KEY = 'fixture-private-key'
  writeFileSync(f.authPath, JSON.stringify(data))
  expect(await f.quota.read('a', 'connect')).toEqual({ state: 'unavailable', reason: 'login-required' })
  expect(f.request).not.toHaveBeenCalled()
})
