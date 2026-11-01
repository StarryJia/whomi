import { _electron as electron, expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { memoryModelReply } from './fixtures/memory-model.mjs'

for (const width of [1280, 360]) test(`首次整理在 ${width} 像素窗口从总览、问一问、仓库到真实文稿`, async () => {
  test.setTimeout(90000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-primary-'))
  const evidence = resolve('artifacts/primary-pages-018')
  const source = join(directory, 'weekend.json')
  const title = '虚构会话 · 周末散步'
  let pauseAtFinal = true, reachedFinal = false
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const messages = JSON.parse(body).messages
      if (pauseAtFinal && JSON.stringify(messages[0].content).includes('撰写《我们的记忆》')) { reachedFinal = true; return }
      const text = memoryModelReply(messages, { title: '河边散步', text: '你们约好周六在河边散步。' })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: ' + JSON.stringify({ choices: [{index:0, delta:{content:text}, finish_reason:null}] }) + '\n\n')
      res.end('data: ' + JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:28,completion_tokens:16}}) + '\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let app
  try {
    await mkdir(evidence, { recursive: true })
    await writeFile(join(directory, 'probe.cjs'), 'module.exports=()=>async()=>true')
    await writeFile(source, JSON.stringify({ chatlab:{version:'0.0.2'}, meta:{name:title,platform:'discord',type:'direct',groupId:'sample-walk'},members:[{platformId:'a',accountName:'小禾'},{platformId:'b',accountName:'小松'}],messages:['周六去河边散步吗？','好，十点见。'].map((content,i)=>({content,sender:i?'b':'a',accountName:i?'小松':'小禾',timestamp:1761700000+i*60,type:0,platformMessageId:'m'+i})) }))
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
    await button('记忆仓库').click()
    await expect(page.getByText('文稿预览',{exact:true})).toBeVisible()
    await snap('library-empty')
    await button('问一问').click()
    await expect(page.getByRole('heading',{name:'问一问',exact:true})).toBeInViewport()
    await expect(page.getByRole('heading',{name:'目前还没有问题哦'})).toBeVisible()
    await expect(page.locator('.clarification-card.blank-card')).toHaveCount(3)
    await expect(page.getByRole('textbox',{name:'我有自己的想法…'})).toBeDisabled()
    await snap('clarification')
    await expect(button('返回记忆仓库')).toHaveCount(0)
    await button('记忆仓库').click()
    await button('导入聊天记录').click()
    await app.evaluate(({dialog},f)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[f]})},source)
    await button('选择文件').click()
    await expect(button('打开会话')).toBeVisible()
    await page.evaluate(async endpoint => {
      const provider=await window.whomi.settings.saveProvider({name:'本机回归',baseUrl:endpoint,enabled:true})
      const model=await window.whomi.settings.saveModel({providerId:provider.id,label:'本机模型',model:'local',enabled:true,contextWindow:8000,maxTokens:512})
      await window.whomi.settings.selectModel('analysis',model.id)
    }, `http://127.0.0.1:${server.address().port}/v1`)
    await page.reload()
    await button('个人总览').click()
    await expect(page.locator('main')).toContainText(title)
    await snap('overview-imported')
    await button('记忆仓库').click()
    await button('生成新记忆').click()
    await button('取消选择').click()
    await expect(page.getByText('文稿预览',{exact:true})).toBeVisible()
    await button('生成新记忆').click()
    await snap('choose-conversation')
    await page.getByRole('main').getByRole('button',{name:new RegExp(title)}).click()
    const identity = page.getByRole('dialog',{name:'选择本人'})
    await identity.getByRole('radio',{name:'小禾'}).check()
    await identity.getByRole('button',{name:'设为本人'}).click()
    await expect(identity).toBeHidden()
    await expect(button('生成记忆')).toBeEnabled()
    expect(await page.evaluate(()=>window.whomi.ai.listAnalyses())).toHaveLength(0)
    await button('生成记忆').click()
    await expect.poll(() => reachedFinal, {timeout:15000}).toBe(true)
    await button('暂停生成').click()
    await expect(button('继续生成')).toBeVisible()
    await page.keyboard.press('Escape')
    await button('记忆仓库').click()
    const pending = page.getByRole('region', {name:/未完成的记忆/}).getByRole('button', {name:/继续整理/})
    await expect(pending).toContainText('2 / 2')
    await snap('library-paused')
    pauseAtFinal = false
    await pending.click()
    await button('查看记忆').click()
    const article=page.getByRole('dialog',{name:'我们的记忆'})
    await expect(article).toContainText('你们约好周六在河边散步。')
    await expect(article.locator('.memory-prediction')).toHaveText('????')
    await snap('memory-article')
    await snapCaption('memory-open')
    await button('关闭记忆').click()
    await expect(page.getByRole('button',{name:/周末散步.*#0001/})).toBeFocused()
    await snap('library-complete')
    await snapCaption('memory-closed')
    const row = page.getByRole('button', {name:/周末散步.*#0001/})
    await row.click({button:'right'})
    await page.getByRole('menuitem',{name:'置顶',exact:true}).click()
    await expect(row).toHaveAttribute('data-pinned','true')
    await row.click({button:'right'})
    await page.getByRole('menuitem',{name:'删除',exact:true}).click()
    const confirm = page.getByRole('dialog',{name:'删除记忆'})
    await expect(confirm).toContainText('#0001')
    await confirm.getByRole('button',{name:'取消',exact:true}).click()
    await expect(row).toBeVisible()
    await row.click({button:'right'})
    await page.getByRole('menuitem',{name:'删除',exact:true}).click()
    await confirm.getByRole('button',{name:'确认删除'}).click()
    await expect(row).toHaveCount(0)
    expect(await page.evaluate(()=>window.whomi.ai.listAnalyses())).toHaveLength(0)
    expect(await page.evaluate(async ()=>(await window.whomi.listConversations({limit:10})).items[0].messageCount)).toBe(2)
  } finally {
    await app?.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(directory,{recursive:true,force:true})
  }
})
