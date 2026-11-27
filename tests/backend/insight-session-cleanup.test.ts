import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createAiService } from '../../electron/main/ai-service'
import { diagnosticErrorCode } from '../../electron/main/app-error-logs'
import { createInsightSessionCleanup } from '../../electron/main/insight-session-cleanup'
import { createInsightTraceWriter, type InsightTrace } from '../../electron/main/insight-trace'

let directory: string
let root: string
const tasks = new Map<string, string>()
const folder = (id: string) => join(root, createHash('sha256').update('insight:' + id).digest('hex'))
const staged = (id: string) => join(root, '.deleting-insight-' + id)
const traceRoot = () => join(directory, 'ai-runtime', 'insight-traces')
const traceFile = (id: string) => join(traceRoot(), 'task-' + id + '.json')
const stagedTrace = (id: string) => join(traceRoot(), '.deleting-insight-trace-' + id + '.json')
const exampleTrace = (taskId: string): InsightTrace => ({ taskId, pipeline: 'pi-insight-v1', timezone: 'Asia/Shanghai', totalMessages: 1,
  segments: [], evidenceCards: [], timeCoverage: { initial: null, correctionTriggered: false, final: null } })
const cleanup = () => createInsightSessionCleanup(directory, async id => tasks.has(id))

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'whomi-insight-cleanup-'))
  root = join(directory, 'ai-runtime', 'sessions')
  tasks.clear()
  for (const [id, conversation] of [['1', '8'], ['2', '8'], ['3', '9']]) {
    tasks.set(id, conversation)
    await mkdir(folder(id), { recursive: true })
    await writeFile(join(folder(id), 'session.jsonl'), '合成的聊天与洞察 ' + id)
    await createInsightTraceWriter(directory)(exampleTrace(id))
  }
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

it('从删除报告和会话的正式服务入口清理对应任务，保留其他会话', async () => {
  const service = createAiService({
    runtime: { run: vi.fn() }, secrets: { encrypt: vi.fn(), decrypt: vi.fn() }, deleteInsightSessions: cleanup().remove,
    storage: async (method, [id]) => {
      if (method === 'getAnalysis') return { id, conversationId: tasks.get(String(id)), state: 'completed' }
      if (method === 'deleteAnalysis') return tasks.delete(String(id))
      if (method === 'listAnalyses') return [...tasks].filter(([, conversation]) => conversation === id).map(([id]) => ({ id }))
      throw Error(method)
    },
  })
  await service.deleteAnalysis('1')
  expect((await readdir(traceRoot())).sort()).toEqual(['task-2.json', 'task-3.json'])
  expect(await readdir(root)).toHaveLength(2)
  expect(await readFile(join(folder('2'), 'session.jsonl'), 'utf8')).toContain('洞察 2')
  await service.deleteConversation('8', async () => { tasks.delete('2') })
  expect(await readdir(traceRoot())).toEqual(['task-3.json'])
  expect(await readdir(root)).toHaveLength(1)
  expect(await readFile(join(folder('3'), 'session.jsonl'), 'utf8')).toContain('洞察 3')
})

it('数据库删除失败恢复可续读的会话文件，重试才清除', async () => {
  const cleaner = cleanup()
  await expect(cleaner.remove(['1', '2'], async () => { throw Error('database busy') })).rejects.toThrow('database busy')
  expect((await readdir(traceRoot())).sort()).toEqual(['task-1.json', 'task-2.json', 'task-3.json'])
  expect(await readFile(join(folder('1'), 'session.jsonl'), 'utf8')).toContain('洞察 1')
  expect(await readFile(join(folder('2'), 'session.jsonl'), 'utf8')).toContain('洞察 2')
  await cleaner.remove(['1', '2'], async () => { tasks.delete('1'); tasks.delete('2') })
  expect(await readdir(traceRoot())).toEqual(['task-3.json'])
  expect(await readdir(root)).toHaveLength(1)
})

it('重启后按数据库提交结果恢复仍存在的任务并清理已删除任务', async () => {
  await rename(folder('1'), staged('1'))
  await rename(folder('2'), staged('2'))
  await rename(traceFile('2'), stagedTrace('2'))
  await rename(traceFile('3'), stagedTrace('3'))
  await writeFile(join(traceRoot(), '.writing-insight-trace-1.json'), '{"partial":')
  tasks.delete('2')
  await cleanup().recover()
  expect(await readFile(join(folder('1'), 'session.jsonl'), 'utf8')).toContain('洞察 1')
  expect(await readdir(root)).toHaveLength(2)
  expect((await readdir(traceRoot())).sort()).toEqual(['task-1.json', 'task-3.json'])
  expect(JSON.parse(await readFile(traceFile('3'), 'utf8'))).toMatchObject({ taskId: '3' })
})

it('拒绝任务路径和指向其他目录的链接，回滚已暂存的任务', async () => {
  const remove = vi.fn(async () => {})
  await expect(cleanup().remove(['../1'], remove)).rejects.toHaveProperty('code', 'INSIGHT_CLEANUP_FAILED')
  await rename(folder('2'), join(directory, 'outside'))
  await symlink(join(directory, 'outside'), folder('2'), 'junction')
  await expect(cleanup().remove(['1', '2'], remove)).rejects.toHaveProperty('code', 'INSIGHT_CLEANUP_FAILED')
  expect(remove).not.toHaveBeenCalled()
  expect(await readFile(join(directory, 'outside', 'session.jsonl'), 'utf8')).toContain('洞察 2')
  expect(await readFile(join(folder('1'), 'session.jsonl'), 'utf8')).toContain('洞察 1')
})

it('私有跟踪文件可完整替换，写入失败时保留上次内容且日志不包含路径和正文', async () => {
  const logFailure = vi.fn(() => { throw Error('日志不可用') })
  const write = createInsightTraceWriter(directory, logFailure)
  const trace = exampleTrace('3')
  trace.totalMessages = 2
  await write(trace)
  const saved = await readFile(traceFile('3'), 'utf8')
  expect(saved).toContain('\n  "schemaVersion": 1')
  expect(JSON.parse(saved)).toMatchObject({ ...trace, updatedAtMs: expect.any(Number) })
  expect(await readdir(directory)).toEqual(['ai-runtime'])

  await writeFile(join(traceRoot(), '.writing-insight-trace-3.json'), '模拟占用')
  await expect(write({ ...trace, totalMessages: 3 })).resolves.toBeUndefined()
  expect(logFailure).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSIGHT_TRACE_WRITE_FAILED' }))
  expect(await readFile(traceFile('3'), 'utf8')).toBe(saved)
  await expect(write(exampleTrace('../logs/非法路径'))).resolves.toBeUndefined()
  expect(logFailure).toHaveBeenCalledTimes(2)
  expect(JSON.stringify(logFailure.mock.calls)).not.toMatch(/非法路径|模拟占用|ai-runtime/)
})

it('跟踪目录指向可分享日志时停止写入和删除，并恢复已暂存的会话', async () => {
  const logs = join(directory, 'logs')
  await rename(traceRoot(), join(directory, 'saved-traces'))
  await mkdir(logs)
  await writeFile(join(logs, 'task-1.json'), '原有日志')
  await symlink(logs, traceRoot(), 'junction')
  let code: string | undefined
  await createInsightTraceWriter(directory, error => { code = diagnosticErrorCode(error) })(exampleTrace('5'))
  expect(code).toBe('INSIGHT_TRACE_WRITE_FAILED')
  const remove = vi.fn(async () => {})
  await expect(cleanup().remove(['1'], remove)).rejects.toHaveProperty('code', 'INSIGHT_CLEANUP_FAILED')
  expect(remove).not.toHaveBeenCalled()
  expect(await readFile(join(folder('1'), 'session.jsonl'), 'utf8')).toContain('洞察 1')
  expect(await readdir(logs)).toEqual(['task-1.json'])
  expect(await readFile(join(logs, 'task-1.json'), 'utf8')).toBe('原有日志')
})
