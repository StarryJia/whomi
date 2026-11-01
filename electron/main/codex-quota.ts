import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { CodexQuotaAction, CodexQuotaState, CodexQuotaWindow } from '../../src/shared/codex-quota'
import { BoundaryError } from '../../src/shared/desktop-validation'
import { encryptedRecord, type AuthVault } from './chatgpt-auth-store'

type Options = { directory: string; vault: AuthVault; authPath?: string; fetch?: typeof fetch }
type Binding = { owner: string; identity: string } | null
type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
const text = (value: unknown, max = 320): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined
const invalid = () => new BoundaryError('CODEX_QUOTA_RESPONSE', '额度数据暂不可用，请稍后刷新。')
const disconnected = (): CodexQuotaState => ({ state: 'disconnected' })
const unavailable = (reason: 'source-changed' | 'login-required' | 'unsupported'): CodexQuotaState => ({ state: 'unavailable', reason })
const maximumBytes = 128 * 1024

function claims(token: unknown) {
  if (typeof token !== 'string' || token.length > 32768) return {}
  try { return record(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))) } catch { return {} }
}

async function readJson(response: Response) {
  if (!response.body || Number(response.headers.get('content-length') ?? 0) > maximumBytes) { await response.body?.cancel(); throw invalid() }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximumBytes) throw invalid()
      chunks.push(value)
    }
    try { return record(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { throw invalid() }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

function windows(value: unknown): CodexQuotaWindow[] {
  if (value === null) return []
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const limit = record(value)
  return [limit.primary_window, limit.secondary_window].flatMap(raw => {
    if (raw == null) return []
    const window = record(raw), percent = window.used_percent, seconds = window.limit_window_seconds, reset = window.reset_at
    if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100 || typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 366 * 86400 || (reset != null && (typeof reset !== 'number' || !Number.isSafeInteger(reset) || reset < 0 || reset > 8640000000000))) throw invalid()
    return [{ seconds, remainingPercent: 100 - percent, resetsAt: typeof reset === 'number' ? reset * 1000 : null }]
  }).sort((a, b) => a.seconds - b.seconds)
}

export function createCodexQuota(options: Options) {
  const authPath = resolve(options.authPath ?? join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json'))
  const request = options.fetch ?? fetch
  const binding = encryptedRecord<Binding>(options.directory, options.vault, 'whomi-codex-quota', () => null, value => {
    if (value === null) return null
    const entry = record(value)
    if (!text(entry.owner, 128) || typeof entry.identity !== 'string' || !/^[a-f0-9]{64}$/.test(entry.identity)) throw invalid()
    return { owner: entry.owner as string, identity: entry.identity }
  })
  let generation = 0, closed = false
  let pending: { owner: string; action: CodexQuotaAction; controller: AbortController; promise: Promise<CodexQuotaState> } | undefined

  async function source() {
    let data: RecordValue
    try {
      const file = await open(authPath, 'r')
      try {
        if ((await file.stat()).size > maximumBytes) return undefined
        const buffer = Buffer.alloc(maximumBytes + 1)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        if (bytesRead > maximumBytes) return undefined
        data = record(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')))
      } finally { await file.close() }
    } catch { return undefined }
    if ((data.auth_mode && data.auth_mode !== 'chatgpt') || (!data.auth_mode && data.OPENAI_API_KEY)) return undefined
    const tokens = record(data.tokens), access = text(tokens.access_token, 32768), id = claims(tokens.id_token), accessClaims = claims(access)
    const auth = record(id['https://api.openai.com/auth']), accessAuth = record(accessClaims['https://api.openai.com/auth'])
    if (auth.chatgpt_account_is_fedramp || accessAuth.chatgpt_account_is_fedramp) return { unsupported: true } as const
    const user = text(auth.chatgpt_user_id) ?? text(auth.user_id) ?? text(accessAuth.chatgpt_user_id) ?? text(accessAuth.user_id)
    const workspace = text(tokens.account_id, 200)
    const email = text(id.email) ?? text(record(id['https://api.openai.com/profile']).email)
    if (!access || !user || !workspace || !/^[\w-]+$/.test(workspace)) return undefined
    if (typeof accessClaims.exp === 'number' && accessClaims.exp * 1000 <= Date.now()) return undefined
    const identity = createHash('sha256').update(JSON.stringify([authPath, user, workspace])).digest('hex')
    // 邮箱只用于展示；本机来源按用户与工作区绑定。
    return { unsupported: false, identity, access, user, workspace, email: email ?? '邮箱未提供' } as const
  }

  async function query(owner: string, action: CodexQuotaAction, controller: AbortController, version: number): Promise<CodexQuotaState> {
    const live = () => !closed && version === generation && !controller.signal.aborted
    const before = await source()
    if (!live()) return disconnected()
    if (!before) return unavailable('login-required')
    if (before.unsupported) return unavailable('unsupported')
    if (action === 'read' && binding.read()?.identity !== before.identity) return unavailable('source-changed')
    const timeout = setTimeout(() => controller.abort(), 15000)
    try {
      const response = await request('https://chatgpt.com/backend-api/wham/usage', {
        headers: { Authorization: 'Bearer ' + before.access, 'ChatGPT-Account-ID': before.workspace, Accept: 'application/json', 'User-Agent': 'Whomi' },
        redirect: 'error', signal: controller.signal
      })
      if (response.status === 401 || response.status === 403) { await response.body?.cancel(); return unavailable('login-required') }
      if (response.status === 429 || response.status >= 500) { await response.body?.cancel(); throw new BoundaryError('CODEX_QUOTA_NETWORK', '读取额度失败，请稍后刷新。') }
      if (!response.ok || response.redirected) { await response.body?.cancel(); throw invalid() }
      const data = await readJson(response)
      if (!Object.hasOwn(data, 'rate_limit')) throw invalid()
      if ((data.account_id != null && data.account_id !== before.workspace) || (data.user_id != null && data.user_id !== before.user)) throw invalid()
      const remaining = windows(data.rate_limit)
      const after = await source()
      if (!live()) return disconnected()
      if (!after) return unavailable('login-required')
      if (after.unsupported || before.identity !== after.identity) return unavailable('source-changed')
      if (action === 'connect') binding.save({ owner, identity: before.identity })
      return { state: 'ready', source: { email: before.email, workspaceId: before.workspace, authFile: authPath }, planType: text(data.plan_type, 64) ?? null, windows: remaining, updatedAt: Date.now() }
    } catch (error) {
      if (closed || version !== generation) return disconnected()
      const after = await source()
      if (closed || version !== generation) return disconnected()
      if (!after) return unavailable('login-required')
      if (after.unsupported || before.identity !== after.identity) return unavailable('source-changed')
      if (error instanceof BoundaryError) throw error
      throw new BoundaryError('CODEX_QUOTA_NETWORK', '读取额度失败，请检查网络后重试。')
    } finally { clearTimeout(timeout) }
  }

  function read(owner: string, action: CodexQuotaAction): Promise<CodexQuotaState> {
    if (!text(owner, 128) || !['read', 'connect', 'disconnect'].includes(action)) return Promise.reject(new BoundaryError('INVALID_ARGUMENT'))
    if (closed) return Promise.resolve(disconnected())
    if (action === 'disconnect') {
      generation++; pending?.controller.abort(); pending = undefined
      if (binding.read()?.owner === owner) binding.save(null)
      return Promise.resolve(disconnected())
    }
    if (action === 'read' && binding.read()?.owner !== owner) return Promise.resolve(disconnected())
    if (pending?.owner === owner && pending.action === action) return pending.promise
    generation++; pending?.controller.abort()
    const version = generation, controller = new AbortController()
    const promise = query(owner, action, controller, version).finally(() => { if (pending?.promise === promise) pending = undefined })
    pending = { owner, action, controller, promise }
    return promise
  }
  function close() { closed = true; generation++; pending?.controller.abort(); pending = undefined }
  return { read, close }
}
