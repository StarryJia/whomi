import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const ending = '合成报告末段：两人确认了新的见面地点。'
const limitation = '这份示例只记录了这次见面前的安排。'

for (const longName of [false, true]) test(`insight report with a ${longName ? 'long' : 'short'} conversation name resizes, scrolls, and returns focus`, async ({}, info) => {
  test.setTimeout(60_000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-feedback-report-'))
  const conversationName = '虚构报告会话' + (longName ? '测'.repeat(2000) : '')
  const reports = [{
    format: 'conversation-insights-v1',
    aboutYou: Array.from({ length: 12 }, () => ({ content: [{ text: '两人先核对安排，讨论了往返方案和需要提前准备的材料。'.repeat(8) }] })),
    relationship: [{ content: [{ text: ending }] }], citations: [], limitations: [limitation],
  }, {
    format: 'conversation-insights-v1',
    aboutYou: [{ content: [{ text: '示例正文。' }] }], relationship: [], citations: [], limitations: [],
  }]
  await writeFile(join(directory, 'probe.cjs'), `module.exports = writer => async method => {
    if (method !== 'probe.feedbackReports') throw Error('Unsupported synthetic report probe')
    const reports = ${JSON.stringify(reports)}
    writer.prepare("INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,?,'direct',0)").run(${JSON.stringify(conversationName)})
    writer.exec(\`INSERT INTO ai_models(id,version,data) VALUES('report-model',1,'{}');
      INSERT INTO ai_model_versions(model_id,version,data) VALUES('report-model',1,'{"model":"report","label":"合成模型"}');\`)
    reports.forEach((report, index) => {
      const id = index + 1, token = 'report-fixture-' + id
      writer.prepare("INSERT INTO ai_preparations(token,conversation_id,data,self_fingerprint,model_version,expires_at_ms) VALUES(?,1,'{}','fixture',1,0)").run(token)
      writer.prepare("INSERT INTO ai_analysis_tasks(id,conversation_id,request_id,preparation_token,model_id,model_version,prompt_version,self_fingerprint,snapshot_max_id,state,total_messages,skipped_messages) VALUES(?,1,?,?,'report-model',1,?,'fixture',0,'completed',12,0)").run(id, token, token, report.format)
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
    const report = page.getByRole('button', { name: /虚构报告会话.*会话洞察.*#1/ })
    await report.click()
    const reader = page.locator('.insight-reader-content')
    const measure = async label => {
      const { width } = await reader.boundingBox()
      const viewport = await page.evaluate(() => innerWidth)
      expect(width).toBeLessThanOrEqual(Math.min(viewport, 790))
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      widths.push({ label, viewport, width })
      await writeFile(info.outputPath('report-widths.json'), JSON.stringify(widths, null, 2))
      await page.screenshot({ path: info.outputPath(label + '.png'), animations: 'disabled' })
      return width
    }
    const initial = await measure('01-restored-report')
    await resize(Math.min(1200, workArea.width))
    expect(await measure('02-wider-report')).toBeGreaterThanOrEqual(initial)
    await resize(narrow)
    expect(await measure('03-narrow-report')).toBeCloseTo(initial, 0)
    await page.locator('.insights-home').evaluate(element => element.scrollTop = element.scrollHeight)
    await expect(reader.getByText(ending)).toBeInViewport({ ratio: 1 })
    await expect(reader.getByText(limitation)).toBeInViewport({ ratio: 1 })
    await expect(reader.getByText('阅读完毕', { exact: true })).toHaveCount(0)
    const extraSpaceBelowText = await reader.getByText(limitation).evaluate(paragraph => {
      const scroller = paragraph.closest('.insights-home')
      const viewportBottom = scroller.getBoundingClientRect().top + scroller.clientTop + scroller.clientHeight
      const bottomPadding = parseFloat(getComputedStyle(scroller).paddingBottom)
      return viewportBottom - bottomPadding - paragraph.getBoundingClientRect().bottom
    })
    await page.screenshot({ path: info.outputPath('04-report-ending.png') })
    expect(Math.abs(extraSpaceBelowText)).toBeLessThanOrEqual(1)
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await expect(report).toBeFocused()
    await report.click({ button: 'right' })
    await page.getByRole('menuitem', { name: '删除' }).click()
    const confirmation = page.getByRole('dialog', { name: '删除报告' })
    expect((await confirmation.locator('.reader-modal-card').boundingBox()).width).toBeCloseTo(440, 0)
    const cancel = confirmation.getByRole('button', { name: '取消' })
    await expect(confirmation.getByText(/删除后无法恢复/)).toBeInViewport()
    await expect(cancel).toBeInViewport()
    if (longName) await page.screenshot({ path: info.outputPath('06-delete-confirmation.png') })
    await cancel.click()
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
