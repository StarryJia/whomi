import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { isOperationId, operationActionLabels, operationAreaLabels, operationOutcomeLabels, type OperationArea,
  type OperationOutcome, type OperationSummary } from '../../src/shared/operation-diagnostics'
import { fieldLabels, safeFields, stageLabels, type SafeFields } from './operation-fields'
import { insightFailureAction, insightResumeFailureAction } from '../agent/insight-request-failure'

export type Outcome = Exclude<OperationOutcome, 'running'>
export type Row = { at: number; kind: 'start' | 'event' | 'progress' | 'retry' | 'end' | 'resume' | 'bind' | 'gap'
  stage?: string; fields?: SafeFields; outcome?: Outcome; area?: OperationArea; action?: string; version?: string
  taskId?: string; createdAt?: number; id?: string; incomplete?: boolean
  recordedEnd?: { outcome: Outcome; endedAt: number; lastAt: number; size?: number; partialAt?: number } }

const kinds = { start: '开始', event: '阶段变化', progress: '进度', retry: '自动重试', end: '结束', resume: '恢复', bind: '关联任务', gap: '记录不完整' }
const readableValues: Record<string, string> = { picker: '选择窗口', drop: '拖放', file: '文件', directory: '文件夹', mixed: '混合来源',
  requested: '已发起', success: '成功', failed: '失败', unknown: '尚未确认返回', cancelled: '已取消', interrupted: '中断',
  original: '原数据目录', new: '新数据目录', install: '安装目录',
  noNewReviewRange: '已读完，回查未增加范围', unreadRemaining: '尚有未读原文，阅读未推进',
  stop: '正常结束', toolUse: '调用工具', length: '达到输出上限', error: '请求出错', aborted: '请求已中止',
  inference: '模型推理', compaction: '压缩摘要', checking: '回查', reading: '阅读', writing: '成稿', resumePreparation: '准备恢复洞察',
  insufficient_capacity: '可用容量不足', first: '首次取文', continue: '续读', locate: '按编号定位',
  ok: '成功取文', out_of_scope: '超出所选范围', source_changed: '原文已变化', invalid_request: '取文参数错误' }
const unknownLabels: Readonly<Record<string, string>> = { stopReason: '原因未知', responseReceived: '未知' }
const inverse = (table: Readonly<Record<string, string>>) => new Map(Object.entries(table).map(([key, value]) => [value, key]))
const areas = inverse(operationAreaLabels), actions = inverse(operationActionLabels), events = inverse(kinds)
const outcomes = inverse(operationOutcomeLabels), stages = inverse(stageLabels), fields = inverse(fieldLabels), values = inverse(readableValues)
const headerLength = 512
export const validVersion = (v: unknown) => typeof v === 'string' && /^\d+(?:\.\d+){1,3}(?:[-+][a-zA-Z0-9.-]{1,32})?$/.test(v) ? v : 'unknown'

function localTimestamp(at: number) {
  const offset = -new Date(at).getTimezoneOffset()
  const pad = (n: number) => String(n).padStart(2, '0')
  return new Date(at + offset * 60_000).toISOString().slice(0, -1) + (offset >= 0 ? '+' : '-')
    + pad(Math.floor(Math.abs(offset) / 60)) + ':' + pad(Math.abs(offset) % 60)
}
export function logFilename(s: OperationSummary) {
  return localTimestamp(s.startedAt).slice(0, 23).replace('T', '_').replace(/[:.]/g, '-') + '-' + operationAreaLabels[s.area] + '-' + s.id + '.txt'
}
export function filenameId(name: string) {
  const match = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}-(.+)-([a-fA-F0-9-]{36})\.txt$/.exec(name)
  return match && areas.has(match[1]) && isOperationId(match[2]) ? match[2] : undefined
}

export function summaryHeader(s: OperationSummary, version: string, size?: number, partialAt?: number) {
  const text = ['Whomi 操作诊断', '操作编号：' + s.id, '版本：' + version,
    '功能：' + operationAreaLabels[s.area] + ' · ' + operationActionLabels[s.action],
    '开始时间：' + localTimestamp(s.startedAt), '结果：' + operationOutcomeLabels[s.outcome],
    '耗时：' + Math.max(0, (s.endedAt ?? s.lastAt) - s.startedAt) + ' ms',
    '记录：' + (s.complete ? '完整' : '不完整'), '最后已记录：' + localTimestamp(s.lastAt),
    ...(!s.complete && s.outcome !== 'running' && size !== undefined ? ['已记录字节数：' + size] : []),
    ...(partialAt !== undefined ? ['完整行截止字节：' + partialAt] : []),
    '', '操作经过'].join('\n')
  return text + ' '.repeat(headerLength - Buffer.byteLength(text) - 1) + '\n'
}
export async function updateHeader(path: string, summary: OperationSummary, version: string, size: number, partialAt?: number) {
  const handle = await open(path, 'r+')
  try { await handle.write(Buffer.from(summaryHeader(summary, version, size, partialAt)), 0, headerLength, 0) } finally { await handle.close() }
}

export function encodeRow(row: Row, previous: number) {
  const parts = [localTimestamp(row.at), '+' + Math.max(0, row.at - previous) + ' ms', kinds[row.kind]]
  if (row.stage) parts.push('阶段=' + stageLabels[row.stage])
  if (row.outcome) parts.push('结果=' + operationOutcomeLabels[row.outcome])
  if (row.taskId) parts.push('任务编号=' + row.taskId, '任务创建时间=' + row.createdAt)
  for (const [key, value] of Object.entries(row.fields ?? {})) {
    let display = String(value)
    if (typeof value === 'boolean') display = value ? '是' : '否'
    if (typeof value === 'string') display = (value === 'unknown' ? unknownLabels[key] : undefined) ?? readableValues[value] ?? value
    parts.push(fieldLabels[key] + '=' + display)
  }
  const { code, kind, rule } = row.fields ?? {}
  if (rule === 'noNewReviewRange' || rule === 'unreadRemaining') {
    parts.push('处理建议=请继续洞察，再次停止时换用支持工具调用的模型重新开始。')
  } else if (typeof code === 'string' && row.fields?.phase === 'resumePreparation') {
    parts.push('处理建议=' + insightResumeFailureAction(code))
  } else if (typeof code === 'string' && (code.startsWith('INSIGHT_') || kind === 'inference' || kind === 'compaction')) {
    const action = insightFailureAction(code)
    if (action) parts.push('处理建议=' + action)
  }
  return parts.join('  ') + '\n'
}

function decodeRow(line: string): Row {
  const [time, , type, ...details] = line.split('  ')
  const kind = events.get(type) as Row['kind'], at = Date.parse(time)
  if (!kind || !Number.isSafeInteger(at)) throw Error('Invalid timeline')
  const row: Row = { kind, at }
  const data: Record<string, unknown> = {}
  for (const part of details) {
    const [key, value] = part.split('=')
    if (key === '任务编号') row.taskId = value
    else if (key === '任务创建时间') row.createdAt = Number(value)
    else if (key === '阶段' && !row.stage && kind !== 'end' && stages.has(value)) row.stage = stages.get(value)
    else if (key === '结果' && kind === 'end' && !row.outcome) row.outcome = outcomes.get(value) as Outcome
    else {
      const field = key === '阶段' ? 'phase' : fields.get(key)
      if (!field) continue
      const decoded = unknownLabels[field] === value ? 'unknown' : values.get(value) ?? value
      data[field] = field === 'ordinals' ? value.split(',').map(Number) : /^\d+$/.test(value) ? Number(value)
        : value === '是' ? true : value === '否' ? false : decoded
    }
  }
  row.fields = safeFields(data)
  return row
}

export async function readLog(path: string, id: string, visit: (row: Row) => void) {
  const input = createReadStream(path, { encoding: 'utf8' })
  const reader = createInterface({ input, crlfDelay: Infinity })
  let headerDone = false
  const header: string[] = []
  try {
    for await (const line of reader) {
      if (headerDone) { visit(decodeRow(line)); continue }
      if (header.length > 12 || line.length > 512) throw Error('Invalid header')
      if (line.trimEnd() !== '操作经过') { header.push(line); continue }
      const value = (label: string) => header.find(part => part.startsWith(label + '：'))?.slice(label.length + 1) ?? ''
      const [feature, actionLabel] = value('功能').split(' · ')
      const area = areas.get(feature) as OperationArea, action = actions.get(actionLabel), version = value('版本'), at = Date.parse(value('开始时间'))
      if (header[0] !== 'Whomi 操作诊断' || value('操作编号') !== id || !area || !action || !Number.isSafeInteger(at)
        || validVersion(version) !== version) throw Error('Invalid header')
      const outcome = outcomes.get(value('结果')) as OperationOutcome | undefined
      const elapsed = /^(\d+) ms$/.exec(value('耗时'))
      const endedAt = elapsed ? at + Number(elapsed[1]) : NaN
      const lastAt = Date.parse(value('最后已记录'))
      const sizeText = value('已记录字节数'), size = /^\d+$/.test(sizeText) ? Number(sizeText) : undefined
      const boundary = Number(value('完整行截止字节'))
      const partialAt = size !== undefined && Number.isSafeInteger(boundary) && boundary >= headerLength && boundary < size ? boundary : undefined
      const recordedEnd = outcome && outcome !== 'running' && Number.isSafeInteger(endedAt) && Number.isSafeInteger(lastAt)
        ? { outcome, endedAt, lastAt, size, partialAt } : undefined
      visit({ kind: 'start', id, at, area, action, version, incomplete: value('记录') === '不完整', recordedEnd })
      headerDone = true
    }
    if (!headerDone) throw Error('Missing header')
  } finally { reader.close(); input.destroy() }
}
