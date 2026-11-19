import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const ending = '合成报告末段：两人确认了新的见面地点。'

test('the same historical report grows with the desktop window, scrolls, and returns focus', async ({}, info) => {
  test.setTimeout(60_000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-feedback-report-'))
  const unknown = { EI: null, SN: null, TF: null, JP: null }
  const reports = [{
    format: 'memory-v4', dimensions: unknown, dimensionExplanations: unknown,
    eventVotes: { EI: [0, 0], SN: [0, 0], TF: [0, 0], JP: [0, 0] },
    events: Array.from({ length: 12 }, (_, index) => ({
      title: '合成经历 ' + (index + 1),
      text: '两人先核对各自的安排，并讨论了两种往返方案。确定见面时段后，其中一人又询问是否需要提前准备材料。'.repeat(4),
    })),
    relationship: ending,
  }, {
    format: 'conversation-insights-v1',
    aboutYou: [{ content: [{ text: '示例正文。' }] }], relationship: [], citations: [], limitations: [],
  }]
  await writeFile(join(directory, 'probe.cjs'), `module.exports = writer => async method => {
    if (method !== 'probe.feedbackReports') throw Error('Unsupported synthetic report probe')
    const reports = ${JSON.stringify(reports)}
    writer.exec("INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'虚构报告会话','direct',0)")
    writer.exec(\`INSERT INTO ai_models(id,version,data) VALUES('report-model',1,'{}');
      INSERT INTO ai_model_versions(model_id,version,data) VALUES('report-model',1,'{"model":"report","label":"合成模型"}');\`)
    reports.forEach((report, index) => {
      const id = index + 1, token = 'report-fixture-' + id
      writer.prepare("INSERT INTO ai_preparations(token,conversation_id,data,self_fingerprint,model_version,expires_at_ms) VALUES(?,1,'{}','fixture',1,0)").run(token)
      writer.prepare("INSERT INTO ai_analysis_tasks(id,conversation_id,request_id,preparation_token,model_id,model_version,prompt_version,self_fingerprint,snapshot_max_id,state,total_messages,skipped_messages) VALUES(?,1,?,?,'report-model',1,?,'fixture',0,'completed',12,0)").run(id, token, token, index ? 'conversation-insights-v1' : 'conversation-memory-v4')
      writer.prepare("INSERT INTO ai_reports(task_id,data) VALUES(?,?)").run(id, JSON.stringify(report))
    })
    return true
  }`)
  let app, page
  const widths = []
  try {
    app = await electron.launch({ args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'], env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
    page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await app.evaluate(() => globalThis.__whomiRuntimeProbe.request('probe.feedbackReports', null))
    const workArea = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea)
    const resize = async width => {
      await app.evaluate(({ BrowserWindow }, [width, workArea]) => {
        const window = BrowserWindow.getAllWindows()[0]
        if (window.isMaximized()) window.unmaximize()
        window.setBounds({ x: workArea.x, y: workArea.y, width, height: Math.min(740, workArea.height) })
      }, [width, workArea])
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
    }
    const narrow = Math.min(960, workArea.width)
    await resize(narrow)
    await page.getByRole('button', { name: '对话洞察', exact: true }).click()
    const report = page.getByRole('button', { name: /虚构报告会话.*我们的记忆.*#0001/ })
    await report.click()
    const dialog = page.getByRole('dialog', { name: '我们的记忆' })
    const body = dialog.locator('article')
    const close = dialog.getByRole('button', { name: '关闭记忆' })
    const measure = async label => {
      const viewport = await page.evaluate(() => innerWidth)
      const width = (await dialog.locator('section.insight-history-card').boundingBox()).width
      const prose = (await body.boundingBox()).width
      const firstParagraphHeight = (await body.locator('section').nth(1).locator('p').first().boundingBox()).height
      widths.push({ label, viewport, width, prose, firstParagraphHeight })
      await writeFile(info.outputPath('report-widths.json'), JSON.stringify(widths, null, 2))
      await page.screenshot({ path: info.outputPath(label + '.png'), animations: 'disabled' })
      return widths.at(-1)
    }
    const initial = await measure('01-restored-report')
    expect(initial.width).toBeCloseTo(narrow * 0.75, 0)
    const widerWidth = Math.min(1200, workArea.width)
    await resize(widerWidth)
    await expect(dialog).toBeVisible()
    const wider = await measure('02-wider-report')
    if (widerWidth > narrow) {
      expect(wider.width).toBeGreaterThan(initial.width)
      expect(wider.prose).toBeGreaterThan(initial.prose)
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize())
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(true)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeGreaterThanOrEqual(widerWidth)
    const maximized = await measure('03-maximized-report')
    expect(maximized.width).toBeCloseTo(Math.min(maximized.viewport * 0.75, 960), 0)
    expect(maximized.prose).toBeLessThanOrEqual(790)
    if (maximized.viewport >= 1280) expect(maximized.firstParagraphHeight).toBeLessThan(initial.firstParagraphHeight)
    await resize(narrow)
    expect((await measure('04-narrow-report')).width).toBeCloseTo(initial.width, 0)
    const scroller = dialog.getByRole('region', { name: '报告正文' })
    expect(await scroller.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await scroller.press('End')
    await expect(dialog.getByText(ending)).toBeInViewport()
    await expect(close).toBeInViewport()
    await page.screenshot({ path: info.outputPath('05-report-last-paragraph.png') })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(report).toBeFocused()
    await report.press('Enter')
    await close.click()
    await expect(report).toBeFocused()
    await report.click({ button: 'right' })
    await page.getByRole('menuitem', { name: '删除' }).click()
    const confirmation = page.getByRole('dialog', { name: '删除报告' })
    expect((await confirmation.locator('.reader-modal-card').boundingBox()).width).toBeCloseTo(440, 0)
    await confirmation.getByRole('button', { name: '取消' }).click()
    await page.getByRole('button', { name: /虚构报告会话.*会话洞察.*#2/ }).click()
    await expect(page.getByRole('heading', { name: '关于你' })).toBeVisible()
    expect((await page.locator('.insight-reader-content').boundingBox()).width).toBeLessThanOrEqual(790)
  } catch (error) {
    await page?.screenshot({ path: info.outputPath('failure.png') }).catch(() => {})
    throw error
  } finally {
    await app?.close()
    if (dirname(resolve(directory)) === resolve(tmpdir())) await rm(directory, { recursive: true, force: true })
  }
})
