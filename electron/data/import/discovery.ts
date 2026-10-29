import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, join, resolve, win32 } from 'node:path'
import type { Discovery } from '../../../src/shared/import-contract'
import type { ImportIssue } from '../../../src/shared/conversation-model'
import { getParsers } from '../parsers/registry'
import type { ParserAdapter } from '../parsers/types'
import { parseJson } from '../parsers/input'
import { checkSignal, failureCode, fileLimit, ImportFailure, importLimits, issue } from './limits'
import { identity, inspectFile, readSource, sourceAccess, within, type SourceAccess, type SourceFile } from './source-access'

/** Issued by the main process; never accept this record from a renderer request. */
export type GrantedSource = { rootPath: string }
export type PrivateEntry = { entryId: string; displayName: string; parser: ParserAdapter; files: SourceFile[]; generatedManifest?: Record<string, unknown> }
const json = (bytes: Uint8Array) => parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''))
export function safeRole(name: unknown): string {
  if (typeof name !== 'string' || !name || isAbsolute(name) || win32.isAbsolute(name) || name.includes(':') || name.includes('\0')) throw new ImportFailure('MANIFEST_PATH')
  const parts = name.replaceAll('\\', '/').split('/')
  if (parts.some(part => !part || part === '..' || part === '.')) throw new ImportFailure('MANIFEST_PATH')
  return parts.join('/')
}
export function createDiscovery(access: SourceAccess = sourceAccess, parsers: readonly ParserAdapter[] = getParsers()) {
  const records = new WeakMap<Discovery, readonly PrivateEntry[]>()
  function publish(entries: PrivateEntry[], unrecognized: { displayName: string }[], issues: ImportIssue[]): Discovery {
    const result = Object.freeze({ entries: Object.freeze(entries.map(({ entryId, displayName, parser }) => Object.freeze({ entryId, displayName, formatId: parser.id }))),
      unrecognized: Object.freeze(unrecognized.map(x => Object.freeze(x))), issues: Object.freeze(issues.map(x => Object.freeze(x))) })
    records.set(result, entries)
    return result
  }
  function resolveDiscovery(discovery: Discovery) {
    const entries = records.get(discovery)
    if (!entries) throw new ImportFailure('INVALID_DISCOVERY')
    return entries
  }
  function selectDiscovery(discovery: Discovery, entryIds: readonly string[]) {
    const entries = resolveDiscovery(discovery), ids = new Set(entryIds)
    if (!ids.size || entryIds.length !== ids.size || [...ids].some(id => !entries.some(e => e.entryId === id))) throw new ImportFailure('INVALID_SELECTION')
    return publish(entries.filter(e => ids.has(e.entryId)), [], [...discovery.issues])
  }
  async function discover(grants: readonly GrantedSource[], signal: AbortSignal): Promise<Discovery> {
    checkSignal(signal)
    if (grants.length > importLimits.maxEntries) return publish([], [], [issue('ENTRY_LIMIT')])
    const entries: PrivateEntry[] = [], unknown: { displayName: string }[] = [], issues: ImportIssue[] = []
    const files = new Map<string, SourceFile>(), visited = new Set<string>()
    let count = 0, exhausted = false
    async function walk(path: string, root: string, depth: number, ancestors: Set<string>) {
      checkSignal(signal)
      if (exhausted) return
      if (depth > importLimits.maxDepth) { issues.push(issue('DEPTH_LIMIT')); return }
      try {
        const actual = await access.realpath(path)
        if (!within(root, actual)) throw new ImportFailure('PATH_ESCAPE')
        const stat = await access.stat(actual), id = identity(stat)
        if (stat.isDirectory()) {
          if (ancestors.has(id)) throw new ImportFailure('DIRECTORY_CYCLE')
          if (visited.has(id)) return
          visited.add(id)
          const names = await access.readdir(actual)
          if (count + names.length > importLimits.maxEntries) { exhausted = true; issues.push(issue('ENTRY_LIMIT')); return }
          count += names.length
          const next = new Set(ancestors).add(id)
          for (const name of names.sort()) await walk(join(actual, name), root, depth + 1, next)
        } else if (stat.isFile() && !files.has(id)) files.set(id, await inspectFile(access, root, path, basename(path)))
      } catch (error) { checkSignal(signal); issues.push(issue(failureCode(error))) }
    }
    for (const grant of grants) {
      checkSignal(signal)
      try {
        const actual = await access.realpath(resolve(grant.rootPath)), stat = await access.stat(actual)
        if (stat.isFile() && ++count > importLimits.maxEntries) { exhausted = true; issues.push(issue('ENTRY_LIMIT')); break }
        await walk(actual, stat.isDirectory() ? actual : dirname(actual), 0, new Set())
      } catch (error) { checkSignal(signal); issues.push(issue(failureCode(error))) }
    }
    const consumed = new Set<string>(), wrapperIds = new Set<string>()
    // Only the known extracted Takeout layout supplies a synthetic manifest.
    const googleGroups = new Map<string, { group?: SourceFile; messages?: SourceFile; prefix: string; chatId: string; kind: string }>()
    for (const file of files.values()) {
      const name = file.actual.replaceAll('\\', '/')
      const match = name.match(/^(.*\/Takeout\/Google Chat)\/Groups\/((DM|Space) [^/]+)\/(group_info|messages)\.json$/)
      if (!match) continue
      const id = `${match[1]}/${match[2]}`, draft = googleGroups.get(id) ?? { prefix: match[1], chatId: `Groups/${match[2]}`, kind: match[3] }
      draft[match[4] === 'group_info' ? 'group' : 'messages'] = file; googleGroups.set(id, draft)
    }
    for (const draft of googleGroups.values()) {
      const users = [...files.values()].filter(f => f.actual.replaceAll('\\', '/').startsWith(draft.prefix + '/Users/') && /\/Users\/[^/]+\/user_info\.json$/.test(f.actual.replaceAll('\\', '/')))
      if (!draft.group || !draft.messages || users.length !== 1) { issues.push(issue('TAKEOUT_INCOMPLETE')); continue }
      const entryId = randomUUID(), dependencies = [
        { ...users[0], role: 'user_info.json' }, { ...draft.group, role: 'group_info.json' }, { ...draft.messages, role: 'messages.json' },
      ]
      entries.push({ entryId, displayName: basename(dirname(draft.group.path)), parser: parsers.find(p => p.id === 'google-chat-native')!, files: dependencies,
        generatedManifest: { format: 'chatlab-google-chat-takeout', version: 1, chatId: draft.chatId,
          chatType: draft.kind === 'Space' ? 'group' : 'private', chatName: basename(dirname(draft.group.path)),
          userInfoFile: 'user_info.json', groupInfoFile: 'group_info.json', messagesFile: 'messages.json' } })
      dependencies.forEach(f => consumed.add(identity(f.info)))
    }
    const supportedExtensions = new Set(parsers.flatMap(p => [...p.extensions]))
    for (const file of files.values()) {
      checkSignal(signal)
      if (consumed.has(identity(file.info)) || !supportedExtensions.has(extname(file.path).toLowerCase())) continue
      const entryId = randomUUID()
      try {
        const prefix = await readSource(access, file, importLimits.probeBytes, true)
        const matches: { parser: ParserAdapter; score: number }[] = []
        for (const parser of parsers) {
          const score = await parser.detect({ extension: extname(file.path), prefix, size: Number(file.info.size) })
          if (score > 0) matches.push({ parser, score })
        }
        matches.sort((a, b) => b.score - a.score)
        if (!matches.length) { unknown.push({ displayName: basename(file.path) }); continue }
        if (matches.length > 1 && matches[0].score === matches[1].score) throw new ImportFailure('AMBIGUOUS_FORMAT')
        const parser = matches[0].parser, dependencies: SourceFile[] = [{ ...file, role: basename(file.path) }]
        if (file.info.size > BigInt(fileLimit(parser.mode))) throw new ImportFailure('FILE_LIMIT')
        if (parser.id === 'qq-shuakami-chunked' || parser.id === 'google-chat-native') {
          const data = json(await readSource(access, file, importLimits.boundedFileBytes))
          const names: unknown[] = parser.id === 'google-chat-native' ? [data.userInfoFile, data.groupInfoFile, data.messagesFile]
            : Array.isArray(data.chunked?.chunks) ? data.chunked.chunks.map((c: Record<string, unknown>) => c.relativePath ?? c.file ?? (c.fileName ? `chunks/${c.fileName}` : null)) : (() => { throw new ImportFailure('INVALID_MANIFEST') })()
          if (parser.id === 'qq-shuakami-chunked' && data.avatars?.file) names.push(data.avatars.file)
          if (names.length + 1 > importLimits.maxEntries) throw new ImportFailure('ENTRY_LIMIT')
          for (const name of names) {
            const role = safeRole(name), path = resolve(dirname(file.path), role)
            dependencies.push(await inspectFile(access, file.root, path, role))
          }
          const combined = dependencies.reduce((total, f) => total + f.info.size, 0n)
          if (combined > BigInt(importLimits.boundedFileBytes)) throw new ImportFailure('FILE_LIMIT')
          const signature = dependencies.slice(1).map(f => `${f.role}:${identity(f.info)}`).sort().join('|')
          if (wrapperIds.has(signature)) { consumed.add(identity(file.info)); continue }
          wrapperIds.add(signature)
          dependencies.slice(1).forEach(f => consumed.add(identity(f.info)))
        }
        entries.push({ entryId, displayName: basename(file.path), parser, files: dependencies })
        if (matches.length > 1) issues.push(issue('FORMAT_PRIORITY_SELECTED', entryId, 'warning'))
      } catch (error) { issues.push(issue(failureCode(error), entryId)) }
    }
    const result = entries.filter(e => e.generatedManifest || !consumed.has(identity(e.files[0].info)))
    checkSignal(signal)
    return publish(result, unknown, issues)
  }
  return { discover, resolveDiscovery, selectDiscovery }
}
