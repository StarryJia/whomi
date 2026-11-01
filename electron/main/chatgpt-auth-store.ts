import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BoundaryError } from '../../src/shared/desktop-validation'

export type AuthVault = { encrypt(value: string): string; decrypt(value: string): string }
export type Registration = { clientId: string; subject?: string; email?: string; needsConsent?: true }
export type Tokens = { access: string; refresh: string; id: string; expiresAt: number }
export type Account = { hostId: string; registration?: Registration; tokens?: Tokens }

export function accountId(registration: Registration) {
  return createHash('sha256').update(JSON.stringify([registration.clientId, registration.subject])).digest('hex')
}

// 本地加密文件独立于可迁移的聊天资料，轮换后的访问和刷新凭据必须一起替换。
export function encryptedRecord<T>(directory: string, vault: AuthVault, name: string, initial: () => T, decode: (data: unknown) => T) {
  const path = join(directory, name)
  let current: T | undefined
  function read(): T {
    if (current !== undefined) return current
    let encrypted: string
    try { encrypted = readFileSync(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new BoundaryError('ACCOUNT_STORAGE', '无法读取账户连接，请检查本地目录权限。')
      current = initial()
      return current
    }
    try {
      const record = decode(JSON.parse(vault.decrypt(encrypted)))
      current = record
      return record
    } catch {
      throw new BoundaryError('ACCOUNT_STORAGE', '无法解密账户连接，请在原 Windows 账户中重试。')
    }
  }
  function save(next: T) {
    const temporary = path + '.' + randomUUID() + '.tmp'
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      writeFileSync(temporary, vault.encrypt(JSON.stringify(next)), { flag: 'wx', mode: 0o600 })
      renameSync(temporary, path)
      current = next
    } catch (error) {
      if (error instanceof BoundaryError) throw error
      throw new BoundaryError('ACCOUNT_STORAGE', '无法保存账户连接，请检查本地目录权限。')
    } finally {
      try { rmSync(temporary, {force: true}) } catch { /* 清理不影响已提交的凭据。 */ }
    }
  }
  return {read, save}
}

export function createAuthStore(directory: string, vault: AuthVault) {
  return encryptedRecord<Account>(directory,vault,'whomi-chatgpt-session',() => ({hostId:'urn:uuid:' + randomUUID()}), data => {
    const record = data as Account
    if (!record || typeof record.hostId !== 'string' || !record.hostId.startsWith('urn:uuid:') ||
      (record.registration && !record.registration.clientId) ||
      (record.tokens && (!record.registration?.subject || !record.tokens.access || !record.tokens.refresh ||
        !record.tokens.id || !Number.isFinite(record.tokens.expiresAt)))) throw Error()
    return record
  })
}
