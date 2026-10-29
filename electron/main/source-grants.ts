import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import type { SourceHandle } from '../../src/shared/desktop-api'
import type { GrantedSource } from '../data/import/discovery'
import { BoundaryError, sourceHandle } from '../../src/shared/desktop-validation'

export function createSourceGrants(now = Date.now) {
  const records = new Map<string, { owner: number; rootPath: string; handle: SourceHandle; expires: number }>()
  const invalid = (): never => { throw new BoundaryError('INVALID_SOURCE', '请重新选择文件或文件夹。') }
  return {
    async issue(owner: number, paths: readonly string[]): Promise<SourceHandle[]> {
      if (!paths.length || paths.length > 10000) invalid()
      const entries = await Promise.all(paths.map(async rootPath => {
        if (typeof rootPath !== 'string' || !isAbsolute(rootPath) || rootPath.includes('\0')) invalid()
        try {
          const info = await stat(rootPath)
          if (!info.isFile() && !info.isDirectory()) invalid()
          const handle: SourceHandle = { token: randomUUID(), displayName: basename(rootPath), kind: info.isDirectory() ? 'directory' : 'file' }
          return { owner, rootPath, handle, expires: now() + 30 * 60 * 1000 }
        } catch { return invalid() }
      }))
      for (const entry of entries) records.set(entry.handle.token, entry)
      return entries.map(entry => ({ ...entry.handle }))
    },
    consume(owner: number, handles: unknown): GrantedSource[] {
      if (!Array.isArray(handles) || !handles.length || handles.length > 10000 || !handles.every(sourceHandle)) invalid()
      const tokens = (handles as SourceHandle[]).map(handle => {
        const entry = records.get(handle.token)
        if (!entry || entry.owner !== owner || entry.expires <= now() || entry.handle.displayName !== handle.displayName || entry.handle.kind !== handle.kind) return invalid()
        return entry
      })
      if (new Set(tokens).size !== tokens.length) invalid()
      for (const entry of tokens) records.delete(entry.handle.token)
      return tokens.map(entry => ({ rootPath: entry.rootPath }))
    },
    revokeWindow(owner: number) { for (const [token, entry] of records) if (entry.owner === owner) records.delete(token) },
  }
}
export type SourceGrants = ReturnType<typeof createSourceGrants>
