import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { statfs } from 'node:fs/promises'
import { join } from 'node:path'
import type { Candidate, Discovery, ImportCounts } from '../../../src/shared/import-contract'
import { normalizeModel, type ImportIssue, type ParsedConversation, type ParsedMessage, type SourceIdentity } from '../../../src/shared/conversation-model'
import type { ParserAdapter } from '../parsers/types'
import { createDiscovery, type PrivateEntry } from './discovery'
import { checkSignal, failureCode, ImportFailure, importLimits, issue } from './limits'
import { sourceAccess, type SourceAccess } from './source-access'
import { createSnapshotArea, snapshotEntry } from './snapshot'

export type MessageOrigin = { fingerprint: string; sourceConversationKey: string; ordinal: number; parserId: string; parserVersion: string }
export type StagedMessage = { message: ParsedMessage; candidateId: string; origin: MessageOrigin }
/** A read view only. The merge caller must resolve all candidates to one target before committing. */
export type StagedConversation = { candidateIds: readonly string[]; sources: readonly { candidateId: string; identity: SourceIdentity }[]; messages(): Iterable<StagedMessage> }
export type StagedImport = {
  /** Backend only: never serialize this object through the desktop bridge. */
  path: string; jobId: string; candidates: Candidate[]; counts: ImportCounts; issues: ImportIssue[]
  preview(candidateId: string, options?: { afterOrdinal?: number; limit?: number }): { messages: ParsedMessage[]; nextOrdinal: number | null }
  conversation(candidateIds: readonly string[]): StagedConversation
  close(): void; cleanup(): Promise<void>
}
export type StagingOptions = {
  appDataDirectory: string
  access?: Partial<SourceAccess>
  freeBytes?: (path: string) => Promise<bigint>
  parsers?: readonly ParserAdapter[]
}
const emptyCounts = (): ImportCounts => ({ seen: 0, validRecords: 0, invalidRecords: 0 })
function candidate(source: PrivateEntry, chat?: ParsedConversation, fingerprint: string | null = null): Candidate {
  return { candidateId: randomUUID(), entryId: source.entryId, title: chat?.title ?? source.displayName,
    formatId: source.parser.id, parserVersion: source.parser.version, sourceKey: chat?.sourceKey ?? '', kind: chat?.kind ?? 'unknown',
    identity: chat?.identity ?? { platform: '', ownerKey: null, conversationKey: null, namespace: '' },
    members: [], fingerprint, counts: emptyCounts(), status: 'pending', issues: [] }
}

export function createStagingService(options: StagingOptions) {
  const access: SourceAccess = { ...sourceAccess, ...options.access }
  const discovery = createDiscovery(access, options.parsers), area = createSnapshotArea(options.appDataDirectory)
  const freeBytes = options.freeBytes ?? (async (path: string) => { const info = await statfs(path, { bigint: true }); return info.bavail * info.bsize })
  async function stageInputs(jobId: string, input: Discovery, signal: AbortSignal): Promise<StagedImport> {
    const entries = discovery.resolveDiscovery(input)
    checkSignal(signal)
    const directory = await area.create(), path = join(directory, 'staging.sqlite')
    let db: Database.Database | undefined
    try {
      const totalBytes = entries.reduce((sum, entry) => sum + entry.files.reduce((n, file) => n + file.info.size, 0n), 0n)
      if (await freeBytes(directory) < 3n * totalBytes + BigInt(importLimits.diskReserveBytes)) throw new ImportFailure('DISK_SPACE')
      checkSignal(signal)
      db = new Database(path)
      db.pragma('journal_mode = DELETE'); db.pragma('synchronous = FULL')
      db.exec(`CREATE TABLE candidates (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE snapshots (entry_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, files TEXT NOT NULL);
        CREATE TABLE messages (candidate_id TEXT NOT NULL, ordinal INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(candidate_id,ordinal));
        CREATE TABLE issues (candidate_id TEXT NOT NULL, data TEXT NOT NULL);`)
      const insert = db.prepare('INSERT INTO messages VALUES (?,?,?)'), saveCandidate = db.prepare('INSERT INTO candidates VALUES (?,?)')
      const saveIssue = db.prepare('INSERT INTO issues VALUES (?,?)')
      const candidates: Candidate[] = [], issues: ImportIssue[] = [...input.issues]
      for (const source of entries) {
        checkSignal(signal)
        const local: Candidate[] = [], chats = new Map<string, Candidate>(), ends = new Set<string>(), invalid = new Map<string, Set<number>>(), lastOrdinal = new Map<string, number>()
        const pendingIssues: ImportIssue[] = []
        let fingerprint: string | null = null, current: Candidate | undefined, blocked = false
        let batch: { id: string; ordinal: number; data: string }[] = [], batchBytes = 0
        const flush = db.transaction(() => { for (const row of batch) insert.run(row.id, row.ordinal, row.data) })
        async function flushBatch() { if (batch.length) { flush(); batch = []; batchBytes = 0 }; await new Promise<void>(resolve => setImmediate(resolve)); checkSignal(signal) }
        function addIssue(value: ImportIssue) {
          if (value.severity === 'blocking') blocked = true
          if (current) {
            const normalized = { ...value, candidateId: current.candidateId }
            saveIssue.run(current.candidateId, JSON.stringify(normalized))
            // Keep diagnostics bounded in memory; every occurrence remains in the temporary database.
            if (!current.issues.some(x => x.code === normalized.code && x.severity === normalized.severity)) current.issues.push(normalized)
            if (value.severity === 'blocking' && value.ordinal !== undefined) invalid.get(current.candidateId)!.add(value.ordinal)
          } else pendingIssues.push(value)
        }
        try {
          const snapshot = await snapshotEntry(access, source, join(directory, source.entryId), signal)
          fingerprint = snapshot.fingerprint
          db.prepare('INSERT INTO snapshots VALUES (?,?,?)').run(source.entryId, fingerprint, JSON.stringify(snapshot.files))
          for await (const event of source.parser.parse({ candidateId: source.entryId, entry: snapshot.entry, allowedFiles: snapshot.allowedFiles, signal })) {
            checkSignal(signal)
            if (event.type === 'conversation') {
              if (chats.has(event.value.sourceKey)) throw new ImportFailure('DUPLICATE_CONVERSATION_KEY')
              current = candidate(source, event.value, fingerprint); chats.set(current.sourceKey, current); local.push(current); invalid.set(current.candidateId, new Set())
            } else if (event.type === 'member') {
              const target = chats.get(event.conversationKey)
              if (!target) throw new ImportFailure('CONVERSATION_MISSING')
              const previous = target.members.find(m => m.sourceKey === event.value.sourceKey)
              if (previous && JSON.stringify(previous) !== JSON.stringify(event.value)) throw new ImportFailure('MEMBER_CONFLICT')
              if (!previous) target.members.push(event.value)
            } else if (event.type === 'message') {
              const target = chats.get(event.value.conversationKey)
              if (!target || ends.has(event.value.conversationKey)) throw new ImportFailure('CONVERSATION_MISSING')
              current = target
              try {
                const message = normalizeModel(event.value), data = JSON.stringify(message), size = Buffer.byteLength(data)
                if (size > importLimits.recordBytes) throw new ImportFailure('RECORD_LIMIT')
                if (message.ordinal <= (lastOrdinal.get(target.candidateId) ?? -1)) throw new ImportFailure('RECORD_ORDER')
                lastOrdinal.set(target.candidateId, message.ordinal)
                if (message.senderKind === 'member' && !target.members.some(member => member.sourceKey === message.senderKey)) throw new ImportFailure('MEMBER_MISSING')
                if (batch.length >= importLimits.batchRecords || batchBytes + size > importLimits.batchBytes) await flushBatch()
                batch.push({ id: target.candidateId, ordinal: message.ordinal, data }); batchBytes += size; target.counts.validRecords++
              } catch (error) {
                if (signal.aborted || failureCode(error) === 'DISK_SPACE') throw error
                addIssue({ ...issue(error instanceof ImportFailure ? error.code : 'INVALID_RECORD', target.candidateId), ordinal: event.value.ordinal })
              }
            } else if (event.type === 'issue') addIssue(event.value)
            else if (event.type === 'end') {
              const target = chats.get(event.conversationKey)
              if (!target || ends.has(event.conversationKey)) throw new ImportFailure('CONVERSATION_MISSING')
              current = target; ends.add(event.conversationKey)
              const observed = target.counts.validRecords + invalid.get(target.candidateId)!.size
              if (!Number.isSafeInteger(event.seen) || event.seen !== observed) addIssue(issue('RECORD_COUNT_MISMATCH'))
              if (event.declaredMessages !== undefined && event.declaredMessages !== observed) addIssue(issue('DECLARED_COUNT_MISMATCH'))
            }
          }
          await flushBatch()
        } catch (error) {
          const code = failureCode(error)
          if (signal.aborted || code === 'CANCELLED') throw new ImportFailure('CANCELLED')
          if (code === 'DISK_SPACE') throw new ImportFailure('DISK_SPACE')
          addIssue(issue(code))
        }
        if (!local.length) { current = candidate(source, undefined, fingerprint); local.push(current); invalid.set(current.candidateId, new Set()); blocked = true }
        for (const target of local) {
          current = target
          for (const value of pendingIssues) addIssue(value)
          if (!ends.has(target.sourceKey)) addIssue(issue('INCOMPLETE_PARSE'))
          target.counts.invalidRecords = invalid.get(target.candidateId)!.size
          target.counts.seen = target.counts.validRecords + target.counts.invalidRecords
        }
        for (const target of local) {
          if (blocked && !target.issues.some(i => i.severity === 'blocking')) target.issues.push(issue('SHARED_INPUT_INVALID', target.candidateId))
          target.status = blocked ? 'blocked' : 'staged'
          candidates.push(target); issues.push(...target.issues); saveCandidate.run(target.candidateId, JSON.stringify(target))
        }
      }
      checkSignal(signal)
      const database = db
      const persisted = new Map(candidates.map(c => [c.candidateId, structuredClone(c)]))
      function active() { if (!database.open) throw new ImportFailure('STAGING_CLOSED') }
      function find(id: string) { active(); const value = persisted.get(id); if (!value) throw new ImportFailure('INVALID_CANDIDATE'); return value }
      const result: StagedImport = {
        path, jobId, candidates, issues,
        counts: candidates.reduce((total, c) => ({ seen: total.seen + c.counts.seen, validRecords: total.validRecords + c.counts.validRecords, invalidRecords: total.invalidRecords + c.counts.invalidRecords }), emptyCounts()),
        preview(id, { afterOrdinal = -1, limit = importLimits.previewPage } = {}) {
          find(id)
          if (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < -1 || !Number.isInteger(limit) || limit < 1 || limit > importLimits.previewPage) throw new ImportFailure('INVALID_PAGE')
          const messages: ParsedMessage[] = []
          let bytes = 0, more = false
          for (const row of database.prepare('SELECT data FROM messages WHERE candidate_id=? AND ordinal>? ORDER BY ordinal LIMIT ?').iterate(id, afterOrdinal, limit + 1) as Iterable<{ data: string }>) {
            const size = Buffer.byteLength(row.data)
            if (messages.length === limit || (messages.length > 0 && bytes + size > importLimits.batchBytes)) { more = true; break }
            messages.push(JSON.parse(row.data)); bytes += size
          }
          return { messages, nextOrdinal: more ? messages[messages.length - 1].ordinal : null }
        },
        conversation(ids) {
          if (!ids.length || new Set(ids).size !== ids.length) throw new ImportFailure('INVALID_SELECTION')
          const group = ids.map(find)
          if (group.some(c => c.status !== 'staged')) throw new ImportFailure('CONVERSATION_BLOCKED')
          return { candidateIds: Object.freeze([...ids]), sources: group.map(c => ({ candidateId: c.candidateId, identity: structuredClone(c.identity) })),
            *messages() {
              for (const c of group) {
                active()
                for (const row of database.prepare('SELECT data FROM messages WHERE candidate_id=? ORDER BY ordinal').iterate(c.candidateId) as Iterable<{ data: string }>) {
                  const message = JSON.parse(row.data) as ParsedMessage
                  yield { message, candidateId: c.candidateId, origin: { fingerprint: c.fingerprint!, sourceConversationKey: c.sourceKey, ordinal: message.ordinal, parserId: c.formatId, parserVersion: c.parserVersion } }
                }
              }
            } }
        },
        close() { if (database.open) database.close() },
        async cleanup() { result.close(); await area.cleanup(directory) },
      }
      return result
    } catch (error) {
      if (db?.open) db.close()
      await area.cleanup(directory)
      if (signal.aborted) throw new ImportFailure('CANCELLED')
      throw error
    }
  }
  return { discover: discovery.discover, selectDiscovery: discovery.selectDiscovery, stageInputs }
}
