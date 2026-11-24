export const operationRetentionMs = 30 * 86_400_000

export const operationAreaLabels = {
  import: '导入', conversation: '会话', model: '模型', insight: '会话洞察', startup: '启动', settings: '设置', storage: '数据存储',
} as const
export type OperationArea = keyof typeof operationAreaLabels
export const operationOutcomeLabels = {
  running: '进行中', success: '成功', cancelled: '已取消', failed: '失败', interrupted: '中断', unknown: '结果未知',
} as const
export type OperationOutcome = keyof typeof operationOutcomeLabels
export type OperationSummary = {
  id: string
  area: OperationArea
  action: string
  startedAt: number
  endedAt: number | null
  lastAt: number
  outcome: OperationOutcome
  endCode?: string
  complete: boolean
}

export const operationActionLabels: Readonly<Record<string, string>> = {
  operation: '操作', launch: '启动应用', workerExit: '后台进程退出', migrate: '迁移数据', open: '打开会话',
  page: '读取分页', locate: '定位来源', rename: '重命名', delete: '删除', arrange: '排列会话',
  settingsChange: '更新设置', import: '导入聊天记录', send: '发送消息', generate: '生成洞察', test: '测试连接',
}

export function isOperationId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export type OperationFailure = { operationId: string; failureAtMs: number }
export function operationFailure(value: unknown): OperationFailure | undefined {
  if (!value || typeof value !== 'object' || !('operationId' in value) || !isOperationId(value.operationId)
    || !('failureAtMs' in value) || typeof value.failureAtMs !== 'number' || !Number.isSafeInteger(value.failureAtMs) || value.failureAtMs < 0) return
  return { operationId: value.operationId, failureAtMs: value.failureAtMs }
}
