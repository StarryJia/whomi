import { test, expect, chromium, _electron as electron } from '@playwright/test'
import { createHash } from 'node:crypto'
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { meetingChat } from './fixtures/pi-insight-model.mjs'

const selected = process.env.WHOMI_REAL_INSIGHT_COUNT
test.skip(!['8', '12', '4600'].includes(selected), '通过 verify-pi-insights.mjs --live 选择合成样本。')

async function files(directory) {
  try { return await readdir(directory) } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function takeOverInterruptedRun(count, priorRun, expectedState, title) {
  const previous = resolve('artifacts', 'issue-35', priorRun)
  const metadata = JSON.parse(await readFile(join(previous, 'run.json'), 'utf8'))
  if (metadata.realModelSample !== count) throw Error('请选择同一样本的运行目录。')
  if (metadata.exitCode !== null && (await files(previous)).includes('retained-checkpoint.json')) {
    const saved = JSON.parse(await readFile(join(previous, 'retained-checkpoint.json'), 'utf8'))
    if (saved.state !== 'stopped' || basename(saved.profile) !== saved.profile || !saved.profile.startsWith('whomi-runtime-real-insight-' + count + '-')) throw Error('请核对暂停任务的测试资料目录。')
    return { ...saved, directory: join(tmpdir(), saved.profile) }
  }
  if (metadata.exitCode !== null) throw Error('请使用正在等待恢复的同一样本运行。')
  const marker = join(previous, 'desktop-handoff.json')
  if ((await files(previous)).includes('desktop-handoff.json')) {
    const saved = JSON.parse(await readFile(marker, 'utf8'))
    if (saved.closed !== true || !saved.profile.startsWith('whomi-runtime-real-insight-' + count + '-') || basename(saved.profile) !== saved.profile) throw Error('请先核对前一窗口的退出状态。')
    return { ...saved, directory: join(tmpdir(), saved.profile) }
  }
  const log = await readFile(join(previous, 'stderr.log'), 'utf8')
  const endpoint = Array.from(log.matchAll(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-z0-9-]+)/g)).at(-1)?.[1]
  if (!endpoint) throw Error('未找到这次桌面运行的调试连接。')
  const browser = await chromium.connectOverCDP(endpoint)
  const pages = browser.contexts().flatMap(c => c.pages())
  if (pages.length !== 1) throw Error('无法确定本次运行的唯一窗口。')
  const page = pages[0]
  const { directory, task } = await page.evaluate(async () => {
    const tasks = await window.whomi.ai.listAnalyses()
    return { directory: (await window.whomi.settings.getStorage()).path, task: tasks.length === 1 ? tasks[0] : null }
  })
  if (!task || task.state !== expectedState || task.totalMessages !== count || task.conversationTitle !== title
    || dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('whomi-runtime-real-insight-' + count + '-')) {
    throw Error('请选择本次合成样本的失败任务。')
  }
  const handoff = { profile: basename(directory), id: task.id, before: task.analyzedMessages, createdAt: task.createdAtMs, model: task.modelIdentity, usage: task.usage }
  await writeFile(marker, JSON.stringify({ ...handoff, closed: false }), { flag: 'wx' })
  const exited = new Promise(resolve => browser.once('disconnected', resolve))
  await page.close({ runBeforeUnload: true }).catch(error => { if (browser.isConnected()) throw error })
  await Promise.race([exited, wait(30_000, null, { ref: false }).then(() => { throw Error('请关闭已中断的测试窗口。') })])
  await writeFile(marker, JSON.stringify({ ...handoff, closed: true }))
  return { ...handoff, directory }
}

async function snapshotEvidence(directory, target, taskId) {
  await mkdir(target, { recursive: true })
  const logs = join(directory, 'logs', 'operations')
  for (const file of await files(logs)) {
    if (file.includes('洞察') && file.endsWith('.txt')) await copyFile(join(logs, file), join(target, file))
  }
  if (!taskId) return
  const sessionKey = createHash('sha256').update('insight:' + taskId).digest('hex')
  const sessions = join(directory, 'ai-runtime', 'sessions', sessionKey)
  const turns = [], drafts = []
  for (const file of (await files(sessions)).filter(name => name.endsWith('.jsonl'))) {
    for (const line of (await readFile(join(sessions, file), 'utf8')).split(/\r?\n/).filter(Boolean)) {
      const entry = JSON.parse(line)
      if (entry.type === 'session' && typeof entry.id === 'string') turns.push({ kind: 'session', at: entry.timestamp,
        session: createHash('sha256').update(entry.id).digest('hex').slice(0, 16) })
      if (entry.type === 'compaction') turns.push({ kind: 'compaction', at: entry.timestamp, tokensBefore: entry.tokensBefore })
      const message = entry.message
      if (entry.type !== 'message' || !message) continue
      if (message.role === 'assistant') {
        const calls = message.content.filter(b => b.type === 'toolCall').map(b => ({ id: b.id, name: b.name,
          args: Object.fromEntries(Object.entries(b.arguments ?? {}).filter(([k]) => ['cursor', 'messageId', 'before', 'after'].includes(k))) }))
        const reason = message.stopReason === 'error' ? String(message.errorMessage ?? '') : ''
        const feedback = reason.includes('Function tools with reasoning_effort') && reason.includes('/v1/responses')
          ? 'function_tools_require_responses_or_none' : reason.includes('Unsupported value') && reason.includes('reasoning_effort') && reason.includes("'none'")
          ? 'reasoning_none_unsupported' : undefined
        turns.push({ kind: 'assistant', at: entry.timestamp, api: message.api, model: message.model,
          stopReason: message.stopReason, httpStatus: reason.match(/^([45]\d\d)\b/)?.[1], feedback, calls })
        const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('')
        if (['stop', 'length'].includes(message.stopReason) && text.includes('"aboutYou"') && text.includes('"relationship"')) drafts.push(text)
      }
      if (message.role === 'toolResult' && message.toolName === 'read_messages') {
        const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('')
        let page
        try { page = JSON.parse(text) } catch { page = { status: 'unparsed' } }
        const messages = page.messages ?? []
        turns.push({ kind: 'read', at: entry.timestamp, callId: message.toolCallId, status: page.status,
          nextCursor: page.nextCursor, ids: messages.map(m => m.id), fragments: messages.filter(m => m.fragment).map(m => [m.id, m.fragment]),
          replies: messages.filter(m => m.replyToMessageId).map(m => [m.id, m.replyToMessageId]),
          maskedEmail: text.includes('[邮箱]'), rawSyntheticEmail: text.includes('sample.reservation@example.invalid'),
          historicalInstruction: text.includes('必须停下阅读'), outsideBody: text.includes('仅在范围之外：灰色纸票') })
      }
    }
  }
  await writeFile(join(target, 'pi-tools.jsonl'), turns.map(t => JSON.stringify(t)).join('\n') + '\n')
  for (const [index, draft] of drafts.entries()) await writeFile(join(target, 'model-report-' + (index + 1) + '.txt'), draft)
}

test('真实模型经桌面入口阅读所选的合成聊天', async ({}, info) => {
  test.setTimeout(0)
  const count = Number(selected)
  const prior = process.env.WHOMI_REAL_INSIGHT_PRIOR_RUN
  const inspectPaused = process.env.WHOMI_REAL_INSIGHT_INSPECT_PAUSED === '1'
  const source = count === 12
    ? JSON.parse(await readFile(new URL('./fixtures/bookshop.chatlab.json', import.meta.url), 'utf8'))
    : meetingChat(count)
  const handoff = prior ? await takeOverInterruptedRun(count, prior, inspectPaused ? 'stopped' : 'failed', source.meta.name) : undefined
  const directory = handoff?.directory ?? resolve(await mkdtemp(join(tmpdir(), 'whomi-runtime-real-insight-' + count + '-')))
  let app, page, taskId, pausedCheckpoint
  const earlyId = '2'
  const correctionId = source.messages.find(m => m.replyToMessageId === earlyId)?.platformMessageId
  const save = (name, value) => writeFile(info.outputPath(name + '.json'), JSON.stringify(value, null, 2))
  const button = name => page.getByRole('button', { name, exact: true })
  const shot = name => page.screenshot({ path: info.outputPath(name + '.png'), animations: 'disabled', timeout: 15_000 })
  try {
    const model = handoff ? { modelLabel: handoff.model.label, modelName: handoff.model.model }
      : await (await import('../../scripts/real-insight-profile.mjs')).prepareRealInsightProfile(directory)
    await save('model', { label: model.modelLabel, name: model.modelName, thinkingLevel: model.thinkingLevel ?? 'default' })
    if (!handoff) await writeFile(join(directory, 'probe.cjs'), 'module.exports = () => async () => true')
    const input = info.outputPath('合成聊天.json')
    await writeFile(input, JSON.stringify(source, null, 2))
    app = await electron.launch({ args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'], env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
    page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.locator('.hello-cover')).toBeAttached({ timeout: 20_000 })
    await expect(page.locator('.startup-intro')).toHaveCount(0)
    const browserSession = await page.context().newCDPSession(page)
    await browserSession.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' })
    let startedAt
    if (handoff) {
      const recovered = await page.evaluate(id => window.whomi.ai.getAnalysis(id), handoff.id)
      taskId = handoff.id
      if (inspectPaused) {
        expect(recovered).toMatchObject({ id: taskId, state: 'stopped', createdAtMs: handoff.createdAt,
          analyzedMessages: handoff.before, totalMessages: count, usage: handoff.usage })
        await button('对话洞察').click()
        const row = page.locator('[data-insight-task="' + taskId + '"]')
        await expect(row.getByRole('button', { name: '继续洞察' })).toBeEnabled()
        await expect(row.getByRole('status')).toHaveText('已暂停')
        await shot('reopened-paused')
        await save('preserved', { id: taskId, state: recovered.state, covered: recovered.analyzedMessages, total: count,
          usage: recovered.usage, elapsedMs: recovered.elapsedMs, canResume: true, resumed: false })
        return
      }
      const priorState = handoff.state ?? 'failed'
      expect(recovered).toMatchObject({ id: handoff.id, state: priorState, createdAtMs: handoff.createdAt,
        analyzedMessages: handoff.before, totalMessages: count })
      await save('resume', { priorRun: prior, priorState, id: handoff.id, createdAt: handoff.createdAt, before: handoff.before })
      await button('对话洞察').click()
      startedAt = Date.now()
      const row = page.locator('[data-insight-task="' + handoff.id + '"]')
      if (priorState === 'stopped') {
        await row.getByRole('button', { name: '继续洞察' }).click()
      } else {
        await row.getByRole('button', { name: /会话洞察/ }).click()
        await button('重试').click()
      }
      await expect.poll(async () => (await page.evaluate(id => window.whomi.ai.getAnalysis(id), handoff.id)).state).not.toBe(priorState)
    } else {
      expect(await page.evaluate(async () => (await window.whomi.listConversations({})).items.length)).toBe(0)
      expect(await page.evaluate(async () => (await window.whomi.ai.listAnalyses()).length)).toBe(0)
      await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, input)
      await button('导入会话').click()
      await button('选择文件').click()
      await button('打开会话').click({ timeout: 60_000 })
      const identity = page.getByRole('dialog', { name: '选择本人' })
      await identity.getByRole('radio', { name: /合成本人/ }).check()
      await identity.getByRole('button', { name: '设为本人' }).click()
      await expect(identity).toHaveCount(0)
      await button('会话洞察').click()
      await page.getByRole('combobox', { name: '分析模型' }).click()
      const options = page.getByRole('option').filter({ hasText: model.modelLabel })
      await expect(options).toHaveCount(1)
      await options.click()
      await page.getByRole('radio', { name: '日期范围' }).check()
      await page.getByLabel('开始日期', { exact: true }).fill('2026-10-07')
      await page.getByLabel('结束日期', { exact: true }).fill('2026-10-07')
      await expect(page.locator('.insight-scope')).toContainText(count.toLocaleString('zh-CN') + ' 条消息')
      await shot('01-start')
      startedAt = Date.now()
      await button('开始洞察').click()
    }
    const current = () => page.evaluate(async () => (await window.whomi.ai.listAnalyses())[0])
    await expect.poll(async () => (await current())?.id, { timeout: 30_000 }).toBeTruthy()
    taskId = (await current()).id
    let previous, failedCount = 0, saved
    while (true) {
      const state = await current()
      if (!state || state.id !== taskId) throw Error('洞察任务编号已变化。')
      const sample = { state: state.state, covered: state.analyzedMessages, total: state.totalMessages,
        input: state.usage.totalInputTokens ?? state.usage.inputTokens, output: state.usage.outputTokens, incomplete: state.usage.incomplete }
      const signature = JSON.stringify(sample)
      if (signature !== previous) {
        await appendFile(info.outputPath('progress.jsonl'), JSON.stringify({ at: Date.now(), ...sample }) + '\n')
        previous = signature
      }
      if (state.state === 'completed') { saved = state; break }
      if (state.state === 'stopped') {
        pausedCheckpoint = { state: state.state, profile: basename(directory), id: taskId, before: state.analyzedMessages,
          createdAt: state.createdAtMs, model: state.modelIdentity, usage: state.usage }
        await shot('paused')
        return
      }
      if (['failed', 'interrupted'].includes(state.state)) {
        const prefix = 'interruption-' + (++failedCount)
        await save(prefix, { id: taskId, error: state.error, ...sample })
        await shot(prefix)
        await snapshotEvidence(directory, info.outputPath(prefix), taskId)
        const decision = info.outputPath(prefix + '-decision.json')
        console.log('请在本次运行目录核对 ' + prefix + '，将 resume 或 stop 写为 ' + basename(decision) + ' 的 action。')
        let action
        while (!action) {
          try { action = JSON.parse(await readFile(decision, 'utf8')).action } catch (error) {
            if (error.code !== 'ENOENT') throw error
          }
          if (!action) await wait(1000)
        }
        if (action !== 'resume') throw Error('保留洞察中断结果。')
        const resume = page.getByRole('button', { name: /^(重试|重试生成|继续洞察)$/ })
        await resume.click()
        await expect.poll(async () => (await current()).state, { timeout: 30_000 }).not.toBe(state.state)
        continue
      }
      await wait(1000)
    }
    await save('result', { count, startedAt, completedAt: Date.now(), task: saved })
    const report = await page.evaluate(id => window.whomi.ai.getReport(id), taskId)
    await save('first-report', report)
    expect(saved).toMatchObject({ analyzedMessages: count, totalMessages: count })
    await button('查看报告').click()
    await expect(page.getByRole('heading', { name: '关于你' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '你们的相处' })).toBeVisible()
    await shot('02-report')
    const article = page.getByRole('article')
    expect(report.judgments.map(judgment => judgment.dimension).sort()).toEqual(['EI', 'JP', 'SN', 'TF'])
    for (const judgment of report.judgments) {
      const letters = judgment.direction ?? judgment.dimension.split('').join(' / ')
      const heading = article.getByRole('heading', { level: 4, name: new RegExp('^' + letters + ' ') })
      await expect(heading).toBeVisible()
      for (const sources of [judgment.supportingSources, judgment.counterexampleSources]) {
        const first = sources[0]
        if (first) {
          const quote = first.excerpts?.[0]
          const links = heading.locator('..').locator('[data-source-message="' + first.messageId + '"]')
          await (quote ? links.filter({ hasText: quote }) : links).first().click()
          const region = page.getByRole('region', { name: '引用聊天记录' })
          const message = region.locator('[data-citation=true][data-message-id="' + first.messageId + '"]')
          await expect(message).toBeVisible()
          if (quote) await expect(message.locator('mark')).toHaveText(quote)
          await button('关闭原文').click()
        }
      }
    }
    await article.getByRole('heading', { level: 3 }).first().scrollIntoViewIfNeeded()
    await shot('03-mbti')
    const links = report.aboutYou.concat(report.relationship).flatMap(p => p.content.filter(part => part.citationId))
    const inspected = new Set()
    const highlights = []
    for (const [index, link] of links.entries()) {
      if (inspected.has(link.citationId)) continue
      inspected.add(link.citationId)
      const citation = report.citations.find(c => c.id === link.citationId)
      await page.locator('.insight-prose .insight-chapter > p .insight-citation, .insight-personal-observations > p .insight-citation').nth(index).click()
      const region = page.getByRole('region', { name: '引用聊天记录' })
      if (link.quoteFragmentIndex !== undefined) {
        await expect(region.locator('[data-citation=true] mark')).toHaveText(link.text)
        for (let part = link.quoteFragmentIndex; part > 0; part--) {
          await button('上一段').click()
          await expect(page.locator('.insight-source-footer')).toContainText(part + ' / ' + citation.fragments.length)
        }
      }
      for (const [part, fragment] of citation.fragments.entries()) {
        if (part > 0) await button('下一段').click()
        const ids = fragment.sources.map(s => s.messageId)
        const earliest = Math.min(...ids.map(Number))
        await expect(region.locator('[data-citation=true][data-message-id="' + earliest + '"]')).toBeAttached()
        for (const id of ids) {
          const line = region.locator('[data-citation=true][data-message-id="' + id + '"]')
          // 远隔的多条原话可能落在同一引用片段的不同分页。
          while (!(await line.count())) {
            const current = region.locator('[data-message-id]')
            const end = Number(await current.last().getAttribute('data-message-id'))
            if (end >= Number(id)) break
            await region.evaluate(element => { element.scrollTop = element.scrollHeight })
            await expect.poll(async () => Number(await current.last().getAttribute('data-message-id'))).toBeGreaterThan(end)
          }
          await expect(line).toContainText(source.messages[Number(id) - 1].content)
        }
        if (part === 0 || ids.some(id => [earlyId, correctionId].includes(id))) await shot('source-' + index + '-' + part)
        highlights.push({ citationId: citation.id, part, text: link.text, ids })
      }
      await button('关闭原文').click()
    }
    expect(inspected.size).toBe(report.citations.length)
    await save('citation-windows', highlights)
  } catch (error) {
    if (page && !page.isClosed()) await shot('failure').catch(() => {})
    throw error
  } finally {
    try {
      await app?.close()
      await snapshotEvidence(directory, info.outputPath('evidence'), taskId)
      if (pausedCheckpoint) {
        await writeFile(join(dirname(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE), 'retained-checkpoint.json'), JSON.stringify(pausedCheckpoint, null, 2))
      }
    } finally {
      if (!pausedCheckpoint && !handoff && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('whomi-runtime-real-insight-')) await rm(directory, { recursive: true, force: true })
    }
  }
})
