import { _electron as electron, expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('local manuscripts vote once per relationship and retract on identity correction', async () => {
  test.setTimeout(120000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-score-'))
  const evidence = resolve('artifacts/memory-scoring')
  const topics = ['周末旅行','展览','比赛','聚餐','放假']
  const names = ['我和小林','我和小方']
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const content = JSON.parse(body).messages.at(-1).content
      const payload = JSON.parse(typeof content === 'string' ? content : content.map(part => part.text).join(''))
      let result
      if (payload.messages) {
        result = { events: payload.messages.map(message => ({ key: topics.find(topic => message.text.includes(topic)),
          text: message.text, evidenceMessageIds: [message.id], signals: [{ direction: message.text.includes('提前') ? 'J' : 'P', messageId: message.id }] })) }
      } else {
        const first = payload.events[0]
        result = { groups: payload.events.map(event => [event.key]), events: [{ key: first.key, title: first.key, text: first.text }], relationship: '你们会一起商量各自喜欢的安排。',
          dimensionExplanations: { EI: null, SN: null, TF: null, JP: { text: first.text.includes('提前') ? '旅行、展览和比赛中，你都主动提出提前定好安排。' : '旅行、展览和比赛等事情中，你都提出到时候再决定。',
            eventKeys: payload.events.map(event => event.key) } } }
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'score', choices: [{ index: 0, delta: { content: JSON.stringify(result) }, finish_reason: null }] })}\n\n`)
      response.end(`data: ${JSON.stringify({ id: 'score', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 28, completion_tokens: 16 } })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let app
  try {
    await mkdir(evidence, { recursive: true })
    await writeFile(join(directory, 'probe.cjs'), `module.exports=writer=>async method=>{
      if(method!=='probe.seed')throw Error('unsupported');
      const topics=${JSON.stringify(topics)},names=${JSON.stringify(names)};
      for(let c=1;c<=2;c++){
        writer.prepare("INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(?,?,'direct',0)").run(c,names[c-1]);
        writer.prepare("INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(?,?,'sample',?)").run(c,c,'r'+c);
        const me=c*10, friend=me+1, friendName=c===1?'小林':'小方';
        for(const [id,key,name] of [[me,'self','本人'],[friend,'friend',friendName]]) writer.prepare("INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES(?,?,?,?,?)").run(id,c,c,key,name);
        writer.prepare("INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(?,?,'confirmed','user')").run(c,me);
        const insert=writer.prepare("INSERT INTO messages(conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal) VALUES(?,?,'member',?,'text',?,?)");
        const count=c===1?3:5;
        for(let i=0;i<count;i++) insert.run(c,me,'本人',topics[i]+(c===1?'我想提前定好安排。':'我喜欢到时候再决定。'),i);
        insert.run(c,friend,friendName,'展览我想提前选日子。',count);
        writer.prepare("INSERT INTO conversation_summaries(conversation_id,message_count,member_count,status) VALUES(?,?,2,'ready')").run(c,count+1);
      }return true;
    }`)
    app = await electron.launch({ args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'], env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
    const page = await app.firstWindow()
    await app.evaluate(() => globalThis.__whomiRuntimeProbe.request('probe.seed', null))
    const modelId = await page.evaluate(async baseUrl => {
      const provider = await window.whomi.settings.saveProvider({ name: '本机验证', baseUrl, enabled: true, apiKey: 'test-only' })
      return (await window.whomi.settings.saveModel({ providerId: provider.id, label: '虚构对话模型', model: 'score', contextWindow: 14000, maxTokens: 1000, enabled: true })).id
    }, `http://127.0.0.1:${server.address().port}/v1`)
    for (const conversationId of ['1','2']) {
      const id = await page.evaluate(async ({ conversationId, modelId }) => {
        const prepared = await window.whomi.ai.prepareAnalysis({ conversationId, modelId })
        return (await window.whomi.ai.confirmAnalysis({ token: prepared.token, requestId: crypto.randomUUID() })).id
      }, { conversationId, modelId })
      await expect.poll(() => page.evaluate(id => window.whomi.ai.getAnalysis(id), id), { timeout: 30000 }).toMatchObject({
        state: 'completed', report: { format: 'memory-v4', dimensions: { JP: conversationId === '1' ? 'J' : 'P' }, eventVotes: { JP: conversationId === '1' ? [3,0] : [0,5] } },
      })
    }
    await page.reload()
    await page.getByRole('button', { name: '个人总览', exact: true }).click()
    const row = page.getByRole('group', { name: '判断 J / 感知 P' })
    const resize = async width => {
      await app.evaluate(({ BrowserWindow }, width) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(320,320); win.setSize(width,800) }, width)
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
    }
    await page.getByRole('button', { name: '记忆仓库', exact: true }).click()
    const firstMemory = page.getByRole('region', { name: names[0], exact: true }).getByRole('button', { name: /我们的记忆/ })
    await firstMemory.click()
    const manuscript = page.getByRole('dialog', { name: '我们的记忆', exact: true })
    for (const width of [1280, 360]) {
      await resize(width)
      await expect(manuscript.getByText('???J', { exact: true })).toBeVisible()
      await expect(manuscript.getByText('旅行、展览和比赛中，你都主动提出提前定好安排。', { exact: true })).toBeVisible()
      await expect(manuscript.locator('.memory-dimension-explanations dt')).toHaveText(['精力来源', '理解信息', '做决定', '安排方式'])
      await expect(manuscript.getByText('偏向判断 J', { exact: true })).toBeVisible()
      await expect(manuscript.getByText('暂难判断', { exact: true })).toHaveCount(3)
      expect(await manuscript.locator('.memory-prose').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await page.screenshot({ path: join(evidence, `contextual-explanation-${width}.png`), animations: 'disabled' })
    }
    await manuscript.getByRole('button', { name: '关闭记忆' }).click()
    await expect(firstMemory).toBeFocused()
    await page.getByRole('button', { name: '个人总览', exact: true }).click()
    for (const width of [1280,360]) {
      await resize(width)
      await expect(row).toContainText('关系票数持平')
      await expect(row.getByRole('img')).toHaveCount(0)
      await expect(row).toContainText('与小林相处时，你更习惯提前安排。')
      await expect(row).toContainText('与小方相处时，你更习惯保留弹性。')
      await row.scrollIntoViewIfNeeded()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: join(evidence, `tie-${width}.png`), animations: 'disabled' })
    }
    await resize(1280)
    await page.getByRole('button', { name: '展开会话列表' }).click()
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: names[0], exact: true }).click()
    await page.getByRole('button', { name: '选择本人', exact: true }).click()
    const identity = page.getByRole('dialog', { name: '选择本人' })
    await identity.getByRole('radio', { name: '小林' }).check()
    await identity.getByRole('button', { name: '设为本人' }).click()
    await expect(identity).toHaveCount(0)
    await page.getByRole('button', { name: '个人总览', exact: true }).click()
    await expect(row).toContainText('尚待了解')
    await expect(row).not.toContainText('关系票数持平')
    await expect(row.getByRole('img')).toHaveCount(0)
    const relations = page.getByRole('region', { name: '你在不同关系中的表现' })
    await expect(relations).toContainText('至少需要两段关系')
    await expect(relations.getByRole('button', { name: /与小方相处时.*你的倾向/ })).toBeVisible()
    await expect(relations.getByRole('button', { name: /与小林相处时/ })).toHaveCount(0)
    await page.screenshot({ path: join(evidence, 'retracted.png'), animations: 'disabled' })
  } finally {
    server.closeAllConnections()
    await app?.close()
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
