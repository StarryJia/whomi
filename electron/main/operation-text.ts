import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { isOperationId, operationActionLabels, operationAreaLabels, operationOutcomeLabels, type OperationArea,
  type OperationOutcome, type OperationSummary } from '../../src/shared/operation-diagnostics'
import { fieldLabels, safeFields, stageLabels, type SafeFields } from './operation-fields'

export type Outcome = Exclude<OperationOutcome, 'running'>
export type Row = { at: number; kind: 'start' | 'event' | 'progress' | 'retry' | 'end' | 'resume' | 'bind' | 'gap'
  stage?: string; fields?: SafeFields; outcome?: Outcome; area?: OperationArea; action?: string; version?: string
  taskId?: string; createdAt?: number; id?: string; incomplete?: boolean }

const kinds = { start: '开始', event: '阶段变化', progress: '进度', retry: '自动重试', end: '结束', resume: '恢复', bind: '关联任务', gap: '记录不完整' }
const readableValues: Record<string, string> = { picker: '选择窗口', drop: '拖放', file: '文件', directory: '文件夹', mixed: '混合来源',
  requested: '已发起', success: '成功', failed: '失败', unknown: '尚未确认返回', cancelled: '已取消', interrupted: '中断',
  original: '原数据目录', new: '新数据目录', install: '安装目录' }
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

export function summaryHeader(s: OperationSummary, version: string) {
  const text = ['Whomi 操作诊断', '操作编号：' + s.id, '版本：' + version,
    '功能：' + operationAreaLabels[s.area] + ' · ' + operationActionLabels[s.action],
    '开始时间：' + localTimestamp(s.startedAt), '结果：' + operationOutcomeLabels[s.outcome],
    '耗时：' + Math.max(0, (s.endedAt ?? s.lastAt) - s.startedAt) + ' ms',
    '记录：' + (s.complete ? '完整' : '不完整'), '最后已记录：' + localTimestamp(s.lastAt),
    '', '操作经过'].join('\n')
  return text + ' '.repeat(headerLength - Buffer.byteLength(text) - 1) + '\n'
}
export async function updateHeader(path: string, summary: OperationSummary, version: string) {
  const handle = await open(path, 'r+')
  try { await handle.write(Buffer.from(summaryHeader(summary, version)), 0, headerLength, 0) } finally { await handle.close() }
}

export function encodeRow(row: Row, previous: number) {
  const parts = [localTimestamp(row.at), '+' + Math.max(0, row.at - previous) + ' ms', kinds[row.kind]]
  if (row.stage) parts.push('阶段=' + stageLabels[row.stage])
  if (row.outcome) parts.push('结果=' + operationOutcomeLabels[row.outcome])
  if (row.taskId) parts.push('任务编号=' + row.taskId, '任务创建时间=' + row.createdAt)
  for (const [key, value] of Object.entries(row.fields ?? {})) {
    const display = typeof value === 'boolean' ? (value ? '是' : '否') : typeof value === 'string' ? (readableValues[value] ?? value) : String(value)
    parts.push(fieldLabels[key] + '=' + display)
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
    else if (key === '阶段' && !row.stage) row.stage = stages.get(value)
    else if (key === '结果' && kind === 'end' && !row.outcome) row.outcome = outcomes.get(value) as Outcome
    else {
      const field = fields.get(key)
      if (!field) continue
      const decoded = values.get(value) ?? value
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
      visit({ kind: 'start', id, at, area, action, version, incomplete: value('记录') === '不完整' })
      headerDone = true
    }
    if (!headerDone) throw Error('Missing header')
  } finally { reader.close(); input.destroy() }
}
