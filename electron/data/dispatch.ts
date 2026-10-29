import { isAbsolute } from 'node:path'
import type { Store } from './db/open'
import { createQueries } from './db/queries'
import { confirmedSelfSql } from './db/self'
import type { createDataService } from './service'
import type { MemberView, PreviewOptions, ReadMessagesInput, ListConversationsInput, LocateSourceInput } from '../../src/shared/desktop-api'
import type { StartImportRequest } from '../../src/shared/import-contract'
import { BoundaryError, validateArguments, validateResult } from '../../src/shared/desktop-validation'
import type { GrantedSource } from './import/discovery'

export function createDataDispatcher(store: Store, service: ReturnType<typeof createDataService>) {
  const queries = createQueries(store), db = store.reader
  function conversation(id: string) {
    if (!db.prepare('SELECT 1 FROM conversations WHERE id=?').get(BigInt(id))) throw new BoundaryError('INVALID_ID', '请刷新会话列表后重试。')
  }
  return async (method: unknown, input: unknown): Promise<unknown> => {
    await service.ready
    if (method === 'prepareImport') {
      if (!Array.isArray(input) || input.length !== 1 || !Array.isArray(input[0]) || !input[0].length || input[0].length > 10000 || !input[0].every(value => value && typeof value === 'object' && Object.keys(value).length === 1 && typeof value.rootPath === 'string' && isAbsolute(value.rootPath))) throw new BoundaryError('INVALID_SOURCE')
      const id = await service.prepareImport(input[0] as GrantedSource[]); validateResult('prepareImport', id); return id
    }
    validateArguments(method, input)
    const args = input as unknown[]
    let result: unknown
    switch (method) {
      case 'chooseSources': throw new BoundaryError('INVALID_METHOD')
      case 'getImport': result = await service.getImport(args[0] as string); break
      case 'startImport': result = await service.startImport(args[0] as StartImportRequest); break
      case 'cancelImport': await service.cancelImport(args[0] as string); break
      case 'previewImport': result = await service.previewImport(args[0] as string, args[1] as string, args[2] as PreviewOptions); break
      case 'listConversations': result = await queries.listConversations(args[0] as ListConversationsInput); break
      case 'readMessages': conversation((args[0] as ReadMessagesInput).conversationId); result = await queries.readMessages(args[0] as ReadMessagesInput); break
      case 'locateSource': result = await queries.locateSource(args[0] as LocateSourceInput); break
      case 'listMembers': {
        const id = args[0] as string; conversation(id)
        const rows = db.prepare(`SELECT m.id,m.display_name,m.self_hint,
          ${confirmedSelfSql} AS confirmed
          FROM memberships m WHERE m.conversation_id=? ORDER BY m.id`).all(BigInt(id)) as { id: bigint; display_name: string; self_hint: bigint | null; confirmed: bigint }[]
        result = rows.map(row => ({ id: row.id.toString(), displayName: row.display_name, selfHint: row.self_hint === null ? null : row.self_hint === 1n, confirmedSelf: row.confirmed === 1n } satisfies MemberView))
        break
      }
      case 'confirmSelf': {
        const id = args[0] as string, member = args[1] as string | null; conversation(id)
        if (member !== null && !db.prepare('SELECT 1 FROM memberships WHERE id=? AND conversation_id=?').get(BigInt(member), BigInt(id))) throw new BoundaryError('INVALID_MEMBER', '请选择该会话中的成员。')
        await service.confirmSelf(id, member); break
      }
      case 'retrySummary': conversation(args[0] as string); await service.retrySummary(args[0] as string); break
    }
    validateResult(method, result)
    return result
  }
}
