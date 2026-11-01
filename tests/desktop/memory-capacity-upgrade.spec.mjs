import { _electron as electron, expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { memoryModelReply } from './fixtures/memory-model.mjs'

const groups = [
  { id: 1, offset: 0, count: 14639, title: '容量验收 · 万条短消息', context: 256000 },
  { id: 2, offset: 20000, count: 46, title: '断点验收 · 已整理前缀', context: 3880 },
]
const event = { title: '周六整理书箱', text: '两人在东门见面，一起整理书箱。' }
const evidence = resolve(process.env.WHOMI_CAPACITY_EVIDENCE ?? 'artifacts/memory-capacity-upgrade')
const old = process.env.WHOMI_OLD_EXECUTABLE
const current = process.env.WHOMI_PACKAGED_EXECUTABLE ?? 'out'
const stage = process.env.WHOMI_CAPACITY_STAGE
const sequence = (start, count) => Array.from({ length: count }, (_, i) => start + i)
const describeRequests = batches => batches.map(ids => ({ first: ids[0], last: ids.at(-1), count: ids.length }))

test('0.1.7 capacity failure and committed prefix resume after upgrading the same database', async () => {
  test.skip(!stage, '设置 WHOMI_CAPACITY_STAGE 为 both、baseline 或 upgrade 后运行容量升级验收。')
  test.setTimeout(360000)
  expect(['both', 'baseline', 'upgrade']).toContain(stage)
  if (stage !== 'upgrade') expect(old).toBeTruthy()
  await mkdir(evidence, { recursive: true })
  const manifest = join(evidence, 'baseline.json')
  let before = stage === 'upgrade' ? JSON.parse(await readFile(manifest, 'utf8')) : undefined
  const directory = before?.directory ?? await mkdtemp(join(tmpdir(), 'whomi-runtime-capacity-'))
  expect(dirname(directory)).toBe(resolve(tmpdir()))
  expect(basename(directory)).toMatch(/^whomi-runtime-capacity-/)
  let app, page, holdPrefix = stage !== 'upgrade'
  const requests = [], problems = []
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') throw Error('本机测试收到非预期请求')
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const { messages } = JSON.parse(Buffer.concat(chunks).toString())
      const system = JSON.stringify(messages[0].content)
      let text
      if (system.includes('提取共同事件')) {
        const last = messages.at(-1).content
        const { messages: source } = JSON.parse(typeof last === 'string' ? last : last.map(part => part.text).join(''))
        const ids = source.flatMap(item => item.sourceIds ?? [item.id]).map(Number)
        const markers = source.flatMap(item => [...item.text.matchAll(/例(\d{5})/g)].map(match => Number(match[1])))
        if (!ids.length || JSON.stringify(ids) !== JSON.stringify(markers)) throw Error('请求原文与消息编号不一致')
        requests.push(ids)
        if (holdPrefix && ids[0] > groups[1].offset && requests.filter(batch => batch[0] > groups[1].offset).length === 2) return
        text = JSON.stringify({ events: [{ key: event.title, text: event.text, evidenceMessageIds: [String(ids[0])], signals: [] }] })
      } else text = memoryModelReply(messages, event)
      if (!text) throw Error('本机测试收到非预期指令')
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const data = (delta, finish_reason) => 'data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n'
      res.end(data({ content: text }, null) + data({}, 'stop') + 'data: [DONE]\n\n')
    } catch (error) {
      problems.push(String(error))
      res.writeHead(400).end()
    }
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(before?.port ?? 0, '127.0.0.1', resolve))
  const port = server.address().port
  async function launch(executablePath) {
    app = await electron.launch({
      ...(executablePath === 'out' ? { args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'] } :
        { executablePath: resolve(executablePath), args: ['--whomi-runtime-test'] }),
      env: { ...process.env, WHOMI_RUNTIME_TEST: directory }
    })
    page = await app.firstWindow()
    await expect(page.locator('main')).toBeVisible()
    await resize(1280)
    return app.evaluate(({ app }) => app.getVersion())
  }
  async function close() {
    await app?.close()
    app = undefined
  }
  async function resize(width) {
    await app.evaluate(({ BrowserWindow }, width) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setMinimumSize(320, 320)
      window.setSize(width, 800)
    }, width)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
  }
  async function openMemory(group) {
    const title = page.getByRole('button', { name: group.title, exact: true })
    if (!await title.isVisible()) await page.getByRole('button', { name: '展开会话列表' }).click()
    await title.click()
    await page.getByRole('button', { name: '整理成记忆', exact: true }).click()
  }
  const tasks = () => app.evaluate(() => globalThis.__whomiRuntimeProbe.request('probe.tasks', null))
  const task = async group => (await tasks()).find(row => row.conversation === String(group.id))
  const state = async (group, expected) => expect.poll(async () => {
    const row = await task(group)
    return row?.state === 'failed' && expected !== 'failed' ? row.error : row?.state
  }, { timeout: 100000 }).toBe(expected)
  const snapshot = name => page.screenshot({ path: join(evidence, name + '.png'), animations: 'disabled' })
  let keep = stage === 'upgrade'
  try {
    if (stage !== 'upgrade') {
      await copyFile(resolve('tests/desktop/fixtures/memory-capacity-probe.cjs'), join(directory, 'probe.cjs'))
      await writeFile(join(directory, 'fixtures.json'), JSON.stringify(groups))
      expect(await launch(old)).toBe('0.1.7')
      await app.evaluate(() => globalThis.__whomiRuntimeProbe.request('probe.seed', null))
      const models = await page.evaluate(async ({ port, groups }) => {
        const settings = window.whomi.settings
        const provider = await settings.saveProvider({ name: '本机合成验收', baseUrl: 'http://127.0.0.1:' + port + '/v1', enabled: true, apiKey: 'fixture-only' })
        const models = []
        for (const group of groups) {
          const model = await settings.saveModel({ providerId: provider.id, label: '示例模型 ' + group.id, model: 'fixture-' + group.id, enabled: true, contextWindow: group.context, maxTokens: 512 })
          models.push(model.id)
        }
        return models
      }, { port, groups })
      for (const [index, group] of groups.entries()) {
        await page.evaluate(model => window.whomi.settings.selectModel('analysis', model), models[index])
        await close()
        await launch(old)
        await openMemory(group)
        await page.getByRole('button', { name: '生成记忆', exact: true }).click()
        if (index === 0) {
          await state(group, 'failed')
          expect(await task(group)).toMatchObject({ total: group.count, covered: 0, reports: 0, error: expect.stringContaining('超出最大输入长度') })
          expect(requests).toHaveLength(0)
          await expect(page.getByText(/超出最大输入长度/)).toBeVisible()
          await snapshot('01-017-failed-1280')
        } else {
          await expect.poll(() => requests.length, { timeout: 15000 }).toBe(2)
          await page.getByRole('button', { name: '暂停生成', exact: true }).click()
          await state(group, 'stopped')
          const { covered } = await task(group)
          expect(covered).toBeGreaterThan(0)
          expect(covered).toBeLessThan(group.count)
          expect(requests[0]).toEqual(sequence(group.offset + 1, covered))
          await resize(360)
          await expect(page.getByRole('button', { name: '继续生成' })).toBeInViewport({ ratio: 1 })
          await snapshot('02-017-paused-360')
        }
      }
      before = { directory, port, tasks: await tasks(), oldRequests: describeRequests(requests) }
      expect(before.tasks).toHaveLength(2)
      expect(problems).toEqual([])
      await close()
      await writeFile(manifest, JSON.stringify(before, null, 2))
      if (stage === 'baseline') { keep = true; return }
    }
    holdPrefix = false
    const updated = []
    for (const [index, group] of groups.entries()) {
      expect(await launch(current)).not.toBe('0.1.7')
      const original = before.tasks[index]
      expect(await task(group)).toEqual(original)
      await openMemory(group)
      const resume = page.getByRole('button', { name: '继续生成', exact: true })
      const width = index === 0 ? 360 : 1280
      await resize(width)
      await expect(resume).toBeInViewport({ ratio: 1 })
      await resume.focus()
      await expect(resume).toBeFocused()
      await snapshot('03-' + group.id + '-resume-' + width)
      const start = requests.length
      await page.keyboard.press('Enter')
      await state(group, 'completed')
      const received = requests.slice(start)
      expect(received.flat()).toEqual(sequence(group.offset + original.covered + 1, group.count - original.covered))
      expect(await tasks()).toHaveLength(2)
      expect(await task(group)).toEqual({ ...original, state: 'completed', error: null, covered: group.count, reports: 1 })
      const read = page.getByRole('button', { name: '查看记忆', exact: true })
      await expect(read).toBeEnabled()
      await snapshot('04-' + group.id + '-complete-' + width)
      await read.click()
      const dialog = page.getByRole('dialog', { name: '我们的记忆' })
      await expect(dialog.locator('h4')).toHaveText([event.title])
      await expect(dialog.getByText(event.text, { exact: true })).toBeVisible()
      await snapshot('05-' + group.id + '-report-' + width)
      updated.push({ task: await task(group), requests: describeRequests(received) })
      await close()
    }
    expect(problems).toEqual([])
    await writeFile(join(evidence, 'upgrade.json'), JSON.stringify({ old: before.tasks, upgraded: updated }, null, 2))
    keep = false
  } finally {
    await close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    if (!keep && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('whomi-runtime-capacity-')) await rm(directory, { recursive: true, force: true })
  }
})
