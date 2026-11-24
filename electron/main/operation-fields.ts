import { localId } from '../../src/shared/desktop-validation'
import { isDiagnosticCode } from './app-error-logs'
import { importCodes } from './import-diagnostics'

export const stageLabels: Readonly<Record<string, string>> = {
  estimate: '工作量估算', step: '阶段', start: '开始', finish: '结束', resume: '恢复', bind: '关联后台任务', gap: '记录不完整',
  startup: '启动', databaseOpen: '打开数据库', windowReady: '窗口就绪', workerExit: '后台退出',
  databaseUpgrade: '升级资料库',
  read: '读取', locate: '定位', display: '展示', write: '写入', refresh: '刷新', settingsSave: '保存设置',
  copy: '复制', verify: '校验', switchDirectory: '切换目录', waitingForRestart: '等待重启', reopen: '重新打开',
  accepted: '已接受来源', scan: '扫描', parse: '解析', selection: '选择会话', commit: '整批提交', rollback: '整批撤回',
  recovery: '恢复', issues: '异常记录汇总', prepare: '准备', queued: '已排队', reading: '阅读', checking: '核查',
  writing: '生成报告', request: '请求发起，尚未确认返回', firstResponse: '首段返回', returned: '请求已返回', requestFailed: '请求失败',
  requestUnknown: '尚未确认返回', retry: '重试', shrink: '缩小批次', saving: '保存中', saved: '已保存',
  recovered: '已恢复', budget: '触发预算限制', stalled: '触发阅读停滞保护', summary: '压缩摘要保存结果',
  requestBlocked: '请求未发出', targetRecovered: '已取到此前容量不足的目标',
}

export const fieldLabels: Readonly<Record<string, string>> = {
  taskId: '任务编号',
  contextWindow: '上下文容量', outputLimit: '单次输出上限', inputLimit: '单次输入上限',
  estimatedContext: '上下文容量为估算', estimatedOutput: '输出长度为估算', requestLimit: '请求保护次数', inputProtection: '输入保护 token', outputProtection: '输出保护 token',
  catalogContext: '上下文容量来自模型目录', catalogOutput: '输出长度依据模型目录',
  before: '向前条数', after: '向后条数', nextCursor: '后续游标', fromOffset: '起始偏移', endOffset: '结束偏移',
  targetOrdinal: '定位序号', action: '取文方式', kind: '请求类型', readStatus: '读取结果', repeated: '重复读取数',
  requestNumber: '请求序号', previousMiss: '上次容量不足的请求序号',
  rule: '保护规则', newRange: '已送达新范围', stalledCount: '连续无新增范围的请求数',
  priorRequests: '恢复前累计请求数', stopReason: '结束原因', summarySaved: '摘要已保存',
  httpStatus: '服务状态码', responseReceived: '收到服务响应',
  fromVersion: '原资料库版本', toVersion: '目标资料库版本',
  count: '数量', hasMore: '还有下一页', found: '找到目标', fileCount: '文件数', bytes: '字节数', totalBytes: '总字节数',
  category: '设置类别', sourceLocation: '来源目录', targetLocation: '目标目录', code: '错误码', reason: '原因',
  source: '选择方式', sourceKind: '来源类型', sourceCount: '所选来源数', recognizedCount: '识别会话数',
  selectedCount: '勾选会话数', newCount: '新建会话数', appendCount: '追加会话数', validRecords: '有效记录',
  invalidRecords: '异常记录', inserted: '新增消息数', duplicates: '重复消息数', processed: '已处理', total: '总数',
  ordinals: '记录序号', result: '结果', attempt: '尝试次数', batch: '当前批次', totalBatches: '总批次',
  messageCount: '输入消息数', readCount: '累计已读', inputTokens: '输入用量', outputTokens: '输出用量',
  cacheReadTokens: '缓存读取用量', cacheWriteTokens: '缓存写入用量', durationMs: '耗时毫秒',
  firstTokenMs: '首段等待毫秒', limit: '限额', customService: '自定义服务', provider: '服务商', budget: '预算项',
  phase: '任务阶段', merged: '合并进度次数', fromCount: '起始计数', fromAt: '起始时间',
}
const enumValues: Record<string, readonly string[]> = {
  action: ['first','locate','continue'], kind: ['inference','compaction'],
  readStatus: ['ok','out_of_scope','source_changed','invalid_request','insufficient_capacity'],
  rule: ['noNewReviewRange', 'unreadRemaining'],
  stopReason: ['stop', 'toolUse', 'length', 'error', 'aborted', 'unknown'],
  source: ['picker','drop'], sourceKind: ['file','directory','mixed'], result: ['requested','success','failed','unknown','cancelled','interrupted'],
  sourceLocation: ['original','new','install'], targetLocation: ['original','new','install'],
  provider: ['openai-codex','grok-cli','copilot','openai-completions','openai-responses','anthropic-messages','google-generative-ai'],
  budget: ['maxChecks','maxRoundsPerCheck','maxCalls','maxInputTokens','maxOutputTokens','maxElapsedMs'],
  phase: ['prepare','resumePreparation','reading','checking','writing','compaction','saving','generate','source','scan','parse','save','confirm','statistics','cancel'],
  category: ['prompt','processing','debug','model','provider','account'],
}
const booleans = new Set(['hasMore','found','newRange','summarySaved','responseReceived','customService','estimatedContext','estimatedOutput','catalogContext','catalogOutput'])
const extraCodes = new Set([
  'OPERATION_FAILED', 'WORKER_EXIT', 'SETTINGS_SAVE_FAILED', 'CONVERSATION_READ_FAILED', 'CONVERSATION_WRITE_FAILED',
  'UNKNOWN_SENDER', 'UNKNOWN_TIME', 'UNKNOWN_TYPE', 'UPSTREAM_SKIPPED_RECORDS', 'OWNER_CONFLICT',
])
export type SafeFields = Record<string, string | number | boolean | number[]>

export function safeFields(input?: Record<string, unknown>): SafeFields {
  const fields: SafeFields = {}
  for (const [key, value] of Object.entries(input ?? {})) {
    if (value == null || !Object.hasOwn(fieldLabels, key)) continue
    if (key === 'code' || key === 'reason') {
      fields[key] = typeof value === 'string' && (isDiagnosticCode(value) || importCodes.has(value) || extraCodes.has(value)) ? value : 'OPERATION_FAILED'
    } else if (key === 'taskId') {
      if (typeof value === 'string' && localId(value)) fields[key] = value
    } else if (key === 'responseReceived' && value === 'unknown') {
      fields[key] = value
    } else if (key === 'httpStatus') {
      if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) fields[key] = value
    } else if (key === 'nextCursor') {
      if (typeof value === 'string' && value.length <= 100 && /^\d+(?:\.\d+){3}$/.test(value)) fields[key] = value
    } else if (key === 'ordinals' && Array.isArray(value)) {
      fields[key] = value.filter(n => Number.isSafeInteger(n) && n >= 0).slice(0, 3)
    } else if (Object.hasOwn(enumValues, key)) {
      if (typeof value === 'string' && enumValues[key].includes(value)) fields[key] = value
    } else if (booleans.has(key)) {
      if (typeof value === 'boolean') fields[key] = value
    } else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) fields[key] = value
  }
  return fields
}
