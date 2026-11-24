import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createAiService } from '../../electron/main/ai-service'
import { createInsightSessionCleanup } from '../../electron/main/insight-session-cleanup'

let directory: string
let root: string
const tasks = new Map<string, string>()
const folder = (id: string) => join(root, createHash('sha256').update('insight:' + id).digest('hex'))
const staged = (id: string) => join(root, '.deleting-insight-' + id)
const cleanup = () => createInsightSessionCleanup(directory, async id => tasks.has(id))

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'whomi-insight-cleanup-'))
  root = join(directory, 'ai-runtime', 'sessions')
  tasks.clear()
  for (const [id, conversation] of [['1', '8'], ['2', '8'], ['3', '9']]) {
    tasks.set(id, conversation)
    await mkdir(folder(id), { recursive: true })
    await writeFile(join(folder(id), 'session.jsonl'), '合成的聊天与洞察 ' + id)
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
  expect(await readdir(root)).toHaveLength(2)
  expect(await readFile(join(folder('2'), 'session.jsonl'), 'utf8')).toContain('洞察 2')
  await service.deleteConversation('8', async () => { tasks.delete('2') })
  expect(await readdir(root)).toHaveLength(1)
  expect(await readFile(join(folder('3'), 'session.jsonl'), 'utf8')).toContain('洞察 3')
})

it('数据库删除失败恢复可续读的会话文件，重试才清除', async () => {
  const cleaner = cleanup()
  await expect(cleaner.remove(['1', '2'], async () => { throw Error('database busy') })).rejects.toThrow('database busy')
  expect(await readFile(join(folder('1'), 'session.jsonl'), 'utf8')).toContain('洞察 1')
  expect(await readFile(join(folder('2'), 'session.jsonl'), 'utf8')).toContain('洞察 2')
  await cleaner.remove(['1', '2'], async () => { tasks.delete('1'); tasks.delete('2') })
  expect(await readdir(root)).toHaveLength(1)
})

it('重启后按数据库提交结果恢复仍存在的任务并清理已删除任务', async () => {
  await rename(folder('1'), staged('1'))
  await rename(folder('2'), staged('2'))
  tasks.delete('2')
  await cleanup().recover()
  expect(await readFile(join(folder('1'), 'session.jsonl'), 'utf8')).toContain('洞察 1')
  expect(await readdir(root)).toHaveLength(2)
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
