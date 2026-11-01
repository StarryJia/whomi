import type { Database } from 'better-sqlite3'
import type { ListArrangement } from '../../../src/shared/desktop-api'
import { BoundaryError } from '../../../src/shared/desktop-validation'

export const conversationOrder = 'pinned DESC, list_rank ASC, id DESC'
export const threadOrder = 'pinned DESC, list_rank ASC, updated_at_ms DESC, id DESC'

export function arrangeList(db: Database, change: ListArrangement, conversationId?: string) {
  const isThread = conversationId !== undefined
  const table = isThread ? 'ai_threads' : 'conversations'
  const scope = isThread ? ' AND conversation_id=?' : ''
  const args = isThread ? [BigInt(conversationId)] : []
  const invalid = () => new BoundaryError('INVALID_LIST_ITEM', '请刷新列表后重试。')
  db.transaction(() => {
    const find = db.prepare(`SELECT pinned FROM ${table} WHERE id=?${scope}`)
    const current = find.get(BigInt(change.id), ...args) as { pinned: bigint } | undefined
    if (!current) throw invalid()
    if ('pinned' in change) {
      db.prepare(`UPDATE ${table} SET pinned=?,list_rank=0 WHERE id=? AND pinned<>?`).run(Number(change.pinned), BigInt(change.id), Number(change.pinned))
      return
    }
    const rows = db.prepare(`SELECT id FROM ${table} WHERE pinned=?${scope} ORDER BY ${isThread ? threadOrder : conversationOrder}`).all(current.pinned, ...args) as { id: bigint }[]
    if (change.id === change.targetId) return
    const from = rows.findIndex(row => String(row.id) === change.id)
    const [moving] = rows.splice(from, 1)
    const to = rows.findIndex(row => String(row.id) === change.targetId)
    if (to < 0) throw invalid()
    const insertion = to + (change.placement === 'after' ? 1 : 0)
    if (from === insertion) return
    rows.splice(insertion, 0, moving)
    // 排序覆盖数据库中的整组，保留尚未加载到侧栏的会话。
    const update = db.prepare(`UPDATE ${table} SET list_rank=? WHERE id=? AND list_rank<>?`)
    rows.forEach((row, index) => update.run(index + 1, row.id, index + 1))
  })()
}
