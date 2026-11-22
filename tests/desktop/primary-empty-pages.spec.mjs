import { _electron as electron, expect, test } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

for (const width of [1280, 360]) test(`全新资料库在 ${width} 像素窗口浏览个人总览、问一问和对话洞察`, async () => {
  test.setTimeout(90000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-primary-'))
  const evidence = test.info().outputPath('screenshots')
  let app
  try {
    await mkdir(evidence, { recursive: true })
    await writeFile(join(directory, 'probe.cjs'), 'module.exports=()=>async()=>true')
    app = await electron.launch({ ...(process.env.WHOMI_PACKAGED_EXECUTABLE ? { executablePath:resolve(process.env.WHOMI_PACKAGED_EXECUTABLE),args:['--whomi-runtime-test'] } : {args:[resolve('out/main/index.cjs'),'--whomi-runtime-test']}), env:{...process.env,WHOMI_RUNTIME_TEST:directory} })
    const page = await app.firstWindow()
    const button = name => page.getByRole('button', { name, exact:true })
    const snap = async name => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path:join(evidence, `${width}-${name}.png`), animations:'disabled' })
    }
    const snapCaption = async name => {
      // 网页截图不包含原生窗口按钮，必须检查桌面合成后的像素。
      const capture = await app.evaluate(async ({ BrowserWindow, desktopCapturer }) => {
        const window = BrowserWindow.getAllWindows()[0]
        const bounds = window.getBounds()
        const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: bounds.width, height: bounds.height } })
        const source = sources.find(item => item.id === window.getMediaSourceId())
        if (!source) throw new Error('Test window capture unavailable')
        const size = source.thumbnail.getSize()
        const pixels = source.thumbnail.toBitmap()
        const sample = offset => {
          const x = Math.round(size.width - offset * size.width / bounds.width)
          const y = Math.round(8 * size.height / bounds.height)
          return [...pixels.subarray((y * size.width + x) * 4, (y * size.width + x) * 4 + 3)]
        }
        return { png: source.thumbnail.toPNG().toString('base64'), adjacent: sample(160), controls: sample(120) }
      })
      await writeFile(join(evidence, `${width}-caption-${name}.png`), Buffer.from(capture.png, 'base64'))
      expect(capture.controls).toEqual(capture.adjacent)
    }
    await app.evaluate(({BrowserWindow}, width) => { const w=BrowserWindow.getAllWindows()[0]; w.setMinimumSize(320,320); w.setSize(width,800) }, width)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
    await button('个人总览').click()
    await expect(page.getByText('尚待了解',{exact:true})).toHaveCount(4)
    await expect(page.getByRole('heading',{name:/Spark/})).toBeVisible()
    await snap('overview-empty')
    await button('对话洞察').click()
    await expect(page.getByText('暂无洞察报告',{exact:true})).toBeVisible()
    await snap('library-empty')
    await button('问一问').click()
    await expect(page.getByRole('heading',{name:'问一问',exact:true})).toBeInViewport()
    await expect(page.getByRole('heading',{name:'目前还没有问题哦'})).toBeVisible()
    await expect(page.locator('.clarification-card.blank-card')).toHaveCount(3)
    await expect(page.getByRole('textbox',{name:'我有自己的想法…'})).toBeDisabled()
    await snap('clarification')
    await button('对话洞察').click()
    await expect(button('前往会话')).toBeVisible()
    await snapCaption('insights')
    await button('前往会话').click()
    await expect(button('收起会话列表')).toBeVisible()
    expect(await page.evaluate(() => window.whomi.ai.listAnalyses())).toEqual([])
  } finally {
    await app?.close()
    await rm(directory,{recursive:true,force:true})
  }
})
