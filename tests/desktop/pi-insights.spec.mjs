import { test, expect, _electron as electron } from '@playwright/test'
import { appendFileSync } from 'node:fs'
import { cp, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { basename, dirname, join, resolve } from 'node:path'
import { correction, detailQuote, early, excerptCaption, imaginedQuote, mapQuote, meetingChat, meetingModel } from './fixtures/pi-insight-model.mjs'

function quoteLines(link) {
  const lines = []
  const reader = document.createTreeWalker(link.closest('p'), NodeFilter.SHOW_TEXT)
  while (reader.nextNode()) {
    const node = reader.currentNode
    const range = document.createRange()
    for (let i = 0; i < node.length; i++) {
      range.setStart(node, i)
      range.setEnd(node, i + 1)
      const rect = range.getBoundingClientRect()
      if (!rect.width) continue
      if (!lines.length || Math.abs(lines.at(-1).top - rect.top) > 2) lines.push({ top: rect.top, text: '', quoted: '' })
      const line = lines.at(-1)
      line.text += node.data[i]
      if (link.contains(node)) line.quoted += node.data[i]
    }
  }
  return lines
}

for (const { count, overloadOnPage } of [{ count: 8 }, { count: 4600 }, { count: 8, overloadOnPage: 2 }]) {
  test((overloadOnPage ? '模型连续两次过载后自动恢复，' : '') + '从当前会话洞察 ' + count + ' 条，回查远距回复并打开两处原文', async ({}, info) => {
    test.setTimeout(count === 8 ? 120_000 : 600_000)
    const directory = resolve(await mkdtemp(join(tmpdir(), 'whomi-runtime-issue35-')))
    const file = info.outputPath('合成聚会聊天.json')
    const checkLayout = count === 8 && !overloadOnPage
    const scene = checkLayout ? '像把大家的客厅搬到了一起，有人可以在窗边安静地看书，有人可以在桌边慢慢聊起最近的生活，等茶凉了再去添一杯，谁都不用赶着把自己的话说完\n' : imaginedQuote
    const chat = meetingChat(count, scene)
    await writeFile(file, JSON.stringify(chat, null, 2))
    const evidence = (name, value) => writeFile(info.outputPath(name + '.json'), JSON.stringify(value, null, 2))
    const track = []
    const model = await meetingModel({ count, scene, holdPage: count > 8, overloadOnPage, profileDirectory: directory, observe: item => {
      track.push(item)
      appendFileSync(info.outputPath('model-trace.jsonl'), JSON.stringify(item) + '\n')
    } })
    let app, page, startedAt, paused, waiting
    const btn = name => page.getByRole('button', { name, exact: true })
    const task = () => page.evaluate(async () => (await window.whomi.ai.listAnalyses())[0])
    const shot = name => page.screenshot({ path: info.outputPath(name + '.png'), animations: 'disabled' })
    async function launch() {
      app = await electron.launch({ args: [resolve(process.env.WHOMI_DESKTOP_TEST_ENTRY ?? 'out/main/index.cjs'), '--whomi-runtime-test'], env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
      page = await app.firstWindow()
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await expect(page.locator('.hello-cover')).toBeAttached({ timeout: 20_000 })
      await expect(page.locator('.startup-intro')).toHaveCount(0)
      const session = await page.context().newCDPSession(page)
      await session.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' })
    }
    try {
      await writeFile(join(directory, 'probe.cjs'), 'module.exports = () => async () => true')
      await launch()
      await page.evaluate(async baseUrl => {
        const provider = await window.whomi.settings.saveProvider({ name: '本机模拟', baseUrl, enabled: true, apiKey: 'synthetic-only' })
        const model = await window.whomi.settings.saveModel({ providerId: provider.id, label: '聚会模拟模型', model: 'example', contextWindow: null, maxTokens: null, enabled: true })
        await window.whomi.settings.selectModel('analysis', model.id)
      }, model.baseUrl)
      await app.close()
      await launch()
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
      }, file)
      await btn('导入会话').click()
      await btn('选择文件').click()
      await btn('打开会话').click({ timeout: 60_000 })
      const identity = page.getByRole('dialog', { name: '选择本人' })
      await identity.getByRole('radio', { name: /合成本人/ }).check()
      await identity.getByRole('button', { name: '设为本人' }).click()
      await expect(identity).toHaveCount(0)
      await btn('会话洞察').click()
      await page.getByRole('radio', { name: '日期范围' }).check()
      await page.getByLabel('开始日期', { exact: true }).fill('2026-10-07')
      await page.getByLabel('结束日期', { exact: true }).fill('2026-10-07')
      await expect(page.locator('.insight-scope')).toContainText(new RegExp(count.toLocaleString('en-US').replace(',', ',?') + ' 条消息'))
      await shot('01-start')
      expect(track).toHaveLength(0)
      startedAt = Date.now()
      await btn('开始洞察').click()
      if (overloadOnPage) {
        await expect.poll(() => track.filter(e => e.action === 'service-overloaded').length, { timeout: 30000 }).toBe(2)
        waiting = await task()
        expect(waiting).toMatchObject({ state: 'running', analyzedMessages: 0, totalMessages: count })
        await expect(btn('暂停生成')).toBeEnabled()
        await evidence('while-waiting', waiting)
        await shot('02-waiting')
      }
      if (count > 8) {
        await expect.poll(() => track.some(event => event.action === 'held-before-reply'), { timeout: 60_000 }).toBe(true)
        await btn('暂停生成').click()
        await expect(btn('继续洞察')).toBeEnabled()
        const firstSegment = track.find(event => event.action === 'segment-card')
        expect(firstSegment.segmentIndex).toBe(0)
        expect(firstSegment.confirmed).toBeGreaterThan(0)
        expect(firstSegment.confirmed).toBeLessThan(count)
        await expect(page.getByText('已提交分析 ' + firstSegment.confirmed.toLocaleString('en-US') + ' / 4,600 条', { exact: true })).toBeVisible()
        paused = await task()
        expect(paused).toMatchObject({ state: 'stopped', analyzedMessages: firstSegment.confirmed, totalMessages: count })
        await evidence('paused', paused)
        await shot('02-paused')
        await app.close()
        await launch()
        const reopened = await task()
        expect(reopened).toMatchObject({ id: paused.id, state: 'stopped', analyzedMessages: paused.analyzedMessages, usage: paused.usage })
        await btn('对话洞察').click()
        await btn('继续洞察').click()
      }
      await expect.poll(async () => {
        const current = await task()
        if (current?.state === 'failed') throw Error('Task failed: ' + JSON.stringify(current.error))
        return current?.state
      }, { timeout: count === 8 ? 60_000 : 480_000, intervals: [250, 500, 1000] }).toBe('completed')
      const saved = await task()
      const completedAt = Date.now()
      const report = await page.evaluate(id => window.whomi.ai.getReport(id), saved.id)
      if (overloadOnPage) {
        expect(saved.id).toBe(waiting.id)
        expect(await page.evaluate(async () => (await window.whomi.ai.listAnalyses()).length)).toBe(1)
        const db = new DatabaseSync(join(directory, 'whomi.db'), { readOnly: true })
        try {
          const rows = db.prepare('SELECT data FROM ai_request_usage WHERE owner_kind = ? AND owner_id = ?').all('analysis', Number(saved.id))
            .map(r => JSON.parse(r.data)).sort((a, b) => a.startedAt - b.startedAt)
          await evidence('per-request-usage', rows)
          expect(rows).toHaveLength(track.length)
          const unknown = rows.filter(r => r.incomplete)
          expect(unknown).toHaveLength(overloadOnPage)
          for (const receipt of unknown) {
            expect(receipt).not.toHaveProperty('inputTokens')
            expect(receipt).not.toHaveProperty('outputTokens')
          }
          expect(saved.usage.totalInputTokens).toBe(track.reduce((sum, e) => sum + (e.usage?.prompt_tokens ?? 0), 0))
          expect(saved.usage.outputTokens).toBe(track.reduce((sum, e) => sum + (e.usage?.completion_tokens ?? 0), 0))
        } finally { db.close() }
      }
      await evidence('first-report', report)
      await evidence('first-model-draft', model.state.report)
      await evidence('result', { count, startedAt, completedAt, paused: paused && { id: paused.id, usage: paused.usage }, task: saved,
        modelRequests: track.length, firstReadRequestMs: track.find(entry => entry.receivedIds?.length)?.receivedAt - startedAt,
        elapsedMs: completedAt - startedAt, messagesPerActiveSecond: count / (saved.elapsedMs / 1000),
        modelOutputTokensPerSecond: saved.usage.outputTokensPerSecond, fixtureUsage: 'Synthetic service, deterministic receipts' })
      expect(saved).toMatchObject({ id: paused?.id ?? saved.id, analyzedMessages: count, totalMessages: count })
      expect(model.state.wasMasked).toBe(true)
      expect(model.state.wasPseudo).toBe(true)
      expect(model.state.confirmed.size).toBe(count)
      expect(track.some(event => event.action === 'mock-error')).toBe(false)
      expect(track.find(event => event.previousArgs?.messageId === String(count + 1))?.status).toBe('out_of_scope')
      const reread = track.find(event => event.previousArgs?.messageId === model.state.earlyId)
      expect(reread?.receivedIds).toEqual(['1', '2', '3', '4'])
      if (count > 8) {
        const cards = track.filter(event => event.action === 'segment-card')
        expect(cards.length).toBeGreaterThan(1)
        expect(cards.map(event => event.segmentIndex)).toEqual(cards.map((_, i) => i))
        expect(cards.flatMap(event => event.receivedIds)).toHaveLength(count)
        expect(cards.every(event => event.tools.length === 0)).toBe(true)
        expect(reread.action).toBe('report')
        expect(track.some(event => event.action === 'compaction')).toBe(false)
        await page.getByRole('button', { name: new RegExp('会话洞察 #' + saved.id + '$') }).click()
      } else {
        expect(model.state.cards).toHaveLength(0)
        await btn('查看报告').click()
      }
      await expect(page.getByRole('heading', { name: '关于你' })).toBeVisible()
      await expect(page.getByRole('heading', { name: '你们的相处' })).toBeVisible()
      if (count > 8) await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(960, 640))
      await shot('03-report')
      const article = page.getByRole('article')
      const prediction = article.getByText('ES??', { exact: true })
      await expect(prediction).toBeInViewport()
      await expect(article.getByRole('heading', { level: 2 })).toHaveText(['关于你', '你们的相处'])
      await expect(article.getByRole('heading', { level: 3 })).toHaveText(['MBTI 人格倾向', '个人观察'])
      await expect(article.getByRole('heading', { level: 4 })).toHaveText([
        /E.*偏向外向/, /S.*偏向实感/, /T\s*\/\s*F.*暂难判断/, /J\s*\/\s*P.*暂难判断/,
      ])
      await expect(page.getByRole('button', { name: /打开完整会话|回到开头/ })).toHaveCount(0)
      await expect(article.getByRole('complementary', { name: '分析依据限制' })).toHaveCount(0)
      const placement = await prediction.evaluate(element => {
        const article = element.closest('article').getBoundingClientRect()
        const range = document.createRange()
        range.selectNodeContents(element)
        const letters = range.getBoundingClientRect()
        const glyphs = Array.from(element.children, glyph => glyph.getBoundingClientRect())
        const gaps = glyphs.slice(1).map((glyph, i) => glyph.left - glyphs[i].right)
        return { offset: Math.abs(letters.x + letters.width / 2 - article.x - article.width / 2), height: letters.height, gaps }
      })
      expect(placement.offset).toBeLessThan(8)
      expect(placement.height).toBeGreaterThan(48)
      expect(placement.gaps).toHaveLength(3)
      expect(Math.min(...placement.gaps)).toBeGreaterThan(0)
      await article.getByRole('heading', { level: 4, name: /偏向实感/ }).scrollIntoViewIfNeeded()
      await shot('03-personality')
      if (checkLayout) {
        for (const [width, height] of [[1280, 800], [960, 640]]) {
          await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [width, height])
          await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height])
          const link = article.getByRole('button', { name: scene.trim(), exact: true })
          await link.evaluate(el => el.scrollIntoView({ block: 'center' }))
          const lines = await link.evaluate(quoteLines)
          await evidence('quote-lines-' + width, lines)
          const quotedLines = lines.filter(line => line.quoted)
          expect(quotedLines.length).toBeGreaterThan(1)
          expect(quotedLines[0].text.slice(0, quotedLines[0].text.indexOf(quotedLines[0].quoted))).toMatch(/\p{Script=Han}/u)
          expect(lines.map(line => line.text)).not.toContainEqual(expect.stringMatching(/^[，。！？、；：」』”）]|[「『“（]$/u))
          expect(await link.evaluate(el => el.closest('article').scrollWidth <= el.closest('article').clientWidth)).toBe(true)
          await shot('03-personality-quote-' + width)
        }
        await prediction.evaluate(element => element.scrollIntoView({ block: 'center' }))
        await expect(prediction).toBeInViewport()
        expect(await article.evaluate(element => element.scrollWidth <= element.clientWidth &&
          document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        await shot('03-personality-narrow')
      }
      const quoteTargets = [[detailQuote, model.state.detailId], [mapQuote, model.state.imaginedId], [scene, model.state.imaginedId]]
      for (const [index, [quote, messageId]] of quoteTargets.entries()) {
        const sourceButton = article.getByRole('button', { name: quote.trim(), exact: true })
        await sourceButton.click()
        const detail = page.getByRole('region', { name: '引用聊天记录' }).locator('[data-citation=true]')
        await expect(detail).toHaveAttribute('data-message-id', messageId)
        await expect(detail.locator('mark')).toHaveText(quote)
        if (quote.endsWith('\n')) expect(await detail.locator('mark').textContent()).toBe(quote)
        await shot('04-personality-source-' + (index + 1))
        await page.keyboard.press('Escape')
        await expect(sourceButton).toBeFocused()
      }
      for (const [index, original] of [early, correction].entries()) {
        await btn(excerptCaption[index]).click()
        const source = page.getByRole('region', { name: '引用聊天记录' }).locator('[data-citation=true]')
        await expect(source.locator('.message-text')).toHaveText(original)
        if (index === 1) await expect(source.locator('mark')).toHaveText(excerptCaption[1])
        await shot('04-source-' + (index + 1))
        await btn('关闭原文').click()
      }
    } catch (error) {
      if (page && !page.isClosed()) {
        await shot('failure').catch(() => {})
        await task().then(state => evidence('failure-state', state)).catch(() => {})
      }
      throw error
    } finally {
      await app?.close()
      await model.close()
      for (const name of ['logs', 'Crashpad']) await cp(join(directory, name), info.outputPath(name), { recursive: true }).catch(error => {
        if (error.code !== 'ENOENT') console.warn('Could not copy ' + name, error)
      })
      if (dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('whomi-runtime-issue35-')) await rm(directory, { recursive: true, force: true })
    }
  })
}
