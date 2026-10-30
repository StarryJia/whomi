import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type ServerResponse } from 'node:http'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { PiRuntime } from '../../electron/agent/runtime'
import type { AiModel } from '../../src/shared/ai-contract'

describe('Pi runtime over a controlled OpenAI compatible service', () => {
  beforeAll(async () => { await import('@earendil-works/pi-coding-agent') }, 30000)
  let directory: string
  let server: ReturnType<typeof createServer>
  let model: AiModel
  let requests: { messages: { role: string; content: unknown }[]; tools?: unknown[] }[]
  let answer: (response: ServerResponse) => void
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'whomi-pi-'))
    requests = []
    answer = response => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'example', choices: [{ index: 0, delta: { role: 'assistant', content: '已' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: 'example', choices: [{ index: 0, delta: { content: '收到' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: 'example', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    }
    server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => { requests.push(JSON.parse(body)); answer(response) })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    model = { id: 'example-service', label: '测试模型', model: 'example-model', baseUrl: `http://127.0.0.1:${port}/v1`, contextWindow: 32000, maxTokens: 1000, version: 1, enabled: true, hasCredential: false }
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    syncBuiltinESMExports()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  })
  const options = () => ({ signal: new AbortController().signal, onText: () => {} })
  const input = (model: AiModel, prompt = '示例提问') => ({ key: 'example-thread', model, systemPrompt: '仅依据本轮许可材料回答。', prompt })

  it('streams real Pi output, records reported usage, and exposes no tools or ambient instructions', async () => {
    mkdirSync(join(directory, 'ai-runtime'), { recursive: true })
    writeFileSync(join(directory, 'ai-runtime', 'SYSTEM.md'), 'AMBIENT_SECRET')
    writeFileSync(join(directory, 'ai-runtime', 'APPEND_SYSTEM.md'), 'AMBIENT_APPEND_SECRET')
    writeFileSync(join(directory, 'ai-runtime', 'AGENTS.md'), 'AMBIENT_AGENT_SECRET')
    mkdirSync(join(directory, 'ai-runtime', 'skills', 'ambient'), { recursive: true })
    writeFileSync(join(directory, 'ai-runtime', 'skills', 'ambient', 'SKILL.md'), '---\nname: ambient\ndescription: AMBIENT_SKILL_SECRET\n---\nAMBIENT_BODY')
    mkdirSync(join(directory, 'ai-runtime', 'extensions'), { recursive: true })
    const extensionMarker = join(directory, 'extension-executed')
    writeFileSync(join(directory, 'ai-runtime', 'extensions', 'ambient.js'), `import { writeFileSync } from 'node:fs'; export default () => writeFileSync(${JSON.stringify(extensionMarker)}, 'executed')`)
    const chunks: string[] = []
    const result = await new PiRuntime(directory).run(input(model), { ...options(), onText: text => chunks.push(text) })
    expect(result.text).toBe('已收到')
    expect(chunks).toEqual(['已', '已收到'])
    expect(result.usage).toMatchObject({ inputTokens: 12, outputTokens: 3, incomplete: false })
    expect(JSON.stringify(requests[0])).not.toContain('AMBIENT_SECRET')
    expect(JSON.stringify(requests[0])).not.toContain('AMBIENT_APPEND_SECRET')
    expect(JSON.stringify(requests[0])).not.toContain('AMBIENT_AGENT_SECRET')
    expect(JSON.stringify(requests[0])).not.toContain('AMBIENT_SKILL_SECRET')
    expect(existsSync(extensionMarker)).toBe(false)
    expect(requests[0].tools ?? []).toEqual([])
    expect(JSON.parse(result.checkpoint)).toMatchObject({ leafId: expect.any(String), sessionFile: expect.any(String) })
  }, 20000)

  it('restores only the committed checkpoint after a later uncommitted attempt', async () => {
    const first = await new PiRuntime(directory).run(input(model, '已提交提问'), options())
    await new PiRuntime(directory).run({ ...input(model, '未提交提问'), checkpoint: first.checkpoint }, options())
    await new PiRuntime(directory).run({ ...input(model, '重启后提问'), checkpoint: first.checkpoint }, options())
    expect(JSON.stringify(requests[2].messages)).toContain('已提交提问')
    expect(JSON.stringify(requests[2].messages)).not.toContain('未提交提问')
  }, 20000)

  it('never scans the host skill directory even when it exists', async () => {
    const hostSkills = resolve(process.env.HOME || homedir(), '.agents', 'skills')
    const scans: string[] = []
    const originalExists = fs.existsSync
    const originalReadDirectory = fs.readdirSync
    vi.spyOn(fs, 'existsSync').mockImplementation(path => {
      const target = resolve(String(path))
      if (target === hostSkills) return true
      if (target.startsWith(hostSkills + sep)) return false
      return originalExists(path)
    })
    vi.spyOn(fs, 'readdirSync').mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
      if (resolve(String(path)) === hostSkills) { scans.push(String(path)); return [] }
      return Reflect.apply(originalReadDirectory, fs, [path, ...args])
    }) as typeof fs.readdirSync)
    syncBuiltinESMExports()
    await new PiRuntime(directory).run(input(model), options())
    expect(scans).toEqual([])
  }, 20000)

  it('rejects checkpoint files outside the task session directory without a model request', async () => {
    await expect(new PiRuntime(directory).run({ ...input(model), checkpoint: JSON.stringify({ sessionFile: join(directory, 'other.jsonl'), leafId: 'bad' }) }, options())).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT' })
    expect(requests).toHaveLength(0)
  })

  it('rejects another thread checkpoint before sending any of its history', async () => {
    const first = await new PiRuntime(directory).run(input(model, '其他线程保密提问'), options())
    await expect(new PiRuntime(directory).run({ ...input(model), key: 'different-thread', checkpoint: first.checkpoint }, options())).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT' })
    expect(requests).toHaveLength(1)
  }, 20000)

  it('keeps absent provider token counts unknown', async () => {
    answer = response => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ id: 'example', choices: [{ index: 0, delta: { content: '未报告用量' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    }
    const result = await new PiRuntime(directory).run(input(model), options())
    expect(result.usage.inputTokens).toBeUndefined()
    expect(result.usage.outputTokens).toBeUndefined()
    expect(result.usage.incomplete).toBe(true)
  }, 20000)

  it.each([
    { raw: { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 800 }, expected: { inputTokens: 200, outputTokens: 100, cacheReadTokens: 800, incomplete: false } },
    { raw: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 200 } }, expected: { inputTokens: 200, outputTokens: 100, cacheReadTokens: 600, cacheWriteTokens: 200, incomplete: false } },
    { raw: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }, expected: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, incomplete: false } },
  ])('preserves reported cache usage alongside uncached input: $raw', async ({ raw, expected }) => {
    answer = response => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ id: 'example', choices: [{ index: 0, delta: { content: '带缓存用量' }, finish_reason: 'stop' }], usage: raw })}\n\ndata: [DONE]\n\n`)
    }
    const result = await new PiRuntime(directory).run(input(model), options())
    expect(result.usage).toMatchObject(expected)
    if (!('cacheWriteTokens' in expected)) expect(result.usage.cacheWriteTokens).toBeUndefined()
  }, 20000)

  it('aborts an in-flight Pi request and never returns a committed checkpoint', async () => {
    answer = response => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'example', choices: [{ index: 0, delta: { content: '部分' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: 'example', choices: [{ index: 0, delta: { content: '文字' }, finish_reason: null }] })}\n\n`)
    }
    const controller = new AbortController()
    let displayed = ''
    let updates = 0
    await expect(new PiRuntime(directory).run(input(model), { signal: controller.signal, onText: text => { displayed = text; if (++updates === 2) controller.abort() } })).rejects.toMatchObject({ name: 'AbortError' })
    expect(displayed).toBe('部分文字')
    expect(requests).toHaveLength(1)
  }, 20000)

  it('retains provider-reported usage on a failed stream without silently retrying', async () => {
    answer = response => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'example', choices: [{ index: 0, delta: { content: '失败前文字' }, finish_reason: null }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } })}\n\n`)
      setTimeout(() => response.destroy(), 40)
    }
    await expect(new PiRuntime(directory).run(input(model), options())).rejects.toMatchObject({ code: 'MODEL_REQUEST_FAILED', usage: { inputTokens: 8, outputTokens: 2 } })
    expect(requests).toHaveLength(1)
  }, 20000)
})
