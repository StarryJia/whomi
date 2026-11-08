import { _electron as electron, expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const conversationTitle = '合成重启验收'
const prompts = { failed: '失败后重启检查', stopped: '停止与用量汇总检查', running: '生成中退出检查' }
const partialStopped = '停止前已保存的部分'
const partialRunning = '退出前已保存的部分'
const resourceHost = 'whomi-resource-probe.invalid'
const finalAnswer = [
  '两次重试后完成的回答',
  '![远程图片示例](https://' + resourceHost + '/image.png)',
  '<img src="https://' + resourceHost + '/html-image.png" alt="原始图片标签">',
  '[只供显式打开的链接](https://' + resourceHost + '/page)',
].join('\n\n')
const firstUsage = { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 }
const lastUsage = { prompt_tokens: 70, completion_tokens: 11, total_tokens: 81 }

const seedProbe = 'module.exports = writer => method => {' +
  'if (method !== "probe.recoverySeed") throw Error("Unknown probe");' +
  'writer.exec(' + JSON.stringify(
    "INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'" + conversationTitle + "','direct',0);" +
    "INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(1,1,'example','recovery');" +
    "INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES(1,1,1,'self','本人');" +
    "INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(1,1,'confirmed','user');" +
    "INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal) VALUES(1,1,1,'member','本人','text','周六一起搬家',0);" +
    "INSERT INTO conversation_summaries(conversation_id,message_count,member_count,status) VALUES(1,1,1,'ready');"
  ) + '); return true; }'

function chunk(response, fields) {
  response.write('data: ' + JSON.stringify({ id: 'cherry-recovery', object: 'chat.completion.chunk', ...fields }) + '\n\n')
}

function textChunk(response, text) {
  chunk(response, { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })
}

function startFixture() {
  const requests = []
  const attempts = new Map()
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', value => { body += value })
    request.on('end', () => {
      const input = JSON.parse(body)
      const question = JSON.stringify(input.messages.findLast(message => message.role === 'user')?.content ?? '')
      const kind = Object.keys(prompts).find(key => question.includes(prompts[key]))
      const attempt = (attempts.get(kind) ?? 0) + 1
      attempts.set(kind, attempt)
      requests.push({ kind, attempt, model: input.model })

      if (!kind || kind === 'failed' || (kind === 'stopped' && attempt === 2)) {
        response.writeHead(400, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { message: '合成服务明确拒绝本次请求。', type: 'invalid_request_error' } }))
        return
      }

      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (kind === 'running') {
        textChunk(response, partialRunning)
      } else if (attempt === 1) {
        chunk(response, { choices: [], usage: firstUsage })
        textChunk(response, partialStopped)
      } else {
        textChunk(response, finalAnswer)
        chunk(response, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: lastUsage })
        response.end('data: [DONE]\n\n')
      }
    })
  })
  return { server, requests }
}

test('Cherry restores terminal and interrupted turns and shows real aggregate usage without loading remote answer resources', async () => {
  test.setTimeout(150000)
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-cherry-recovery-'))
  const { server, requests } = startFixture()
  let application, page

  const getTurn = async threadId => (await page.evaluate(id => window.whomi.ai.getThread(id), threadId)).turns[0]
  const waitForTurn = async (threadId, fields) => {
    await expect.poll(() => getTurn(threadId), { timeout: 30000 }).toMatchObject(fields)
    return getTurn(threadId)
  }
  const launch = async () => {
    application = await electron.launch({ args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'],
      env: { ...process.env, WHOMI_RUNTIME_TEST: directory } })
    page = await application.firstWindow()
  }

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    await writeFile(join(directory, 'probe.cjs'), seedProbe)
    await launch()
    await application.evaluate(() => globalThis.__whomiRuntimeProbe.request('probe.recoverySeed', null))
    const model = await page.evaluate(async baseUrl => {
      const provider = await window.whomi.settings.saveProvider({ name: '合成本机服务', baseUrl, enabled: true, apiKey: 'test-only' })
      const saved = await window.whomi.settings.saveModel({ providerId: provider.id, label: '重启验收模型', model: 'local-recovery',
        contextWindow: 64000, maxTokens: 1024, enabled: true })
      await window.whomi.settings.selectModel('conversation', saved.id)
      return saved
    }, 'http://127.0.0.1:' + server.address().port + '/v1')
    const startTurn = async key => {
      const thread = await page.evaluate(() => window.whomi.ai.createThread('1'))
      const turn = await page.evaluate(input => window.whomi.ai.sendTurn(input), {
        threadId: thread.id, requestId: 'recovery-' + key, prompt: prompts[key], referenceIds: ['1'], modelId: model.id,
      })
      return { thread, turn }
    }

    const failed = await startTurn('failed')
    failed.turn = await waitForTurn(failed.thread.id, { id: failed.turn.id, state: 'failed', attempt: 1 })
    const stopped = await startTurn('stopped')
    await waitForTurn(stopped.thread.id, { id: stopped.turn.id, state: 'running', text: partialStopped })
    await page.evaluate(id => window.whomi.ai.stopTurn(id), stopped.turn.id)
    stopped.turn = await waitForTurn(stopped.thread.id, {
      id: stopped.turn.id, state: 'stopped', text: partialStopped, usage: { inputTokens: 20, outputTokens: 7, incomplete: true },
    })
    const running = await startTurn('running')
    running.turn = await waitForTurn(running.thread.id, { id: running.turn.id, state: 'running', text: partialRunning })
    expect(requests).toHaveLength(3)

    await application.close()
    await launch()

    // The built renderer may inspect the synthetic links but cannot send a network request for them.
    const remoteResourceRequests = []
    page.on('request', request => { if (request.url().startsWith('https://' + resourceHost + '/')) remoteResourceRequests.push(request.url()) })
    await page.route(/^https?:\/\//, route => {
      const { hostname } = new URL(route.request().url())
      return ['127.0.0.1', 'localhost', '[::1]'].includes(hostname) ? route.continue() : route.abort()
    })
    await page.getByRole('button', { name: '展开会话列表' }).click()
    await page.getByRole('button', { name: conversationTitle, exact: true }).click()
    await page.getByRole('button', { name: 'AI 对话', exact: true }).click()
    const log = page.getByRole('log', { name: 'AI 对话记录' })
    const selectThread = async prompt => {
      await page.getByRole('button', { name: '显示对话列表' }).click()
      await page.getByRole('navigation', { name: 'AI 对话列表' }).getByRole('button', { name: prompt, exact: true }).click()
    }
    const reply = turn => log.locator('[data-message-id="' + turn.requestId + ':assistant"]')

    await test.step('recover failed, stopped and interrupted turns through the desktop bridge and history', async () => {
      for (const [key, before, state] of [['failed', failed, 'failed'], ['stopped', stopped, 'stopped'], ['running', running, 'interrupted']]) {
        const restored = await getTurn(before.thread.id)
        expect(restored).toMatchObject({ id: before.turn.id, requestId: before.turn.requestId, attempt: 1, state,
          text: before.turn.text, referenceIds: ['1'], modelIdentity: before.turn.modelIdentity })
        if (key === 'failed') expect(restored.error).toBe(before.turn.error)
        await selectThread(prompts[key])
        const answer = reply(restored)
        await expect(answer).toContainText(model.label)
        await expect(answer.getByRole('button', { name: '重试回答' })).toBeVisible()
        if (key === 'failed') await expect(answer).toContainText(restored.error)
        else await expect(answer).toContainText(before.turn.text)
        if (key === 'running') await expect(answer).toContainText('回答中断')
      }
      expect(requests).toHaveLength(3)
    })

    await test.step('retry the same stopped turn twice and present the reported cumulative usage', async () => {
      await selectThread(prompts.stopped)
      const answer = reply(stopped.turn)
      await answer.getByRole('button', { name: '重试回答' }).click()
      await waitForTurn(stopped.thread.id, { id: stopped.turn.id, attempt: 2, state: 'failed', referenceIds: ['1'],
        usage: { inputTokens: 20, outputTokens: 7, incomplete: true } })
      await answer.getByRole('button', { name: '重试回答' }).click()
      const completed = await waitForTurn(stopped.thread.id, {
        id: stopped.turn.id, requestId: stopped.turn.requestId, attempt: 3, state: 'completed', text: finalAnswer,
        referenceIds: ['1'], modelIdentity: stopped.turn.modelIdentity, usage: { inputTokens: 90, outputTokens: 18, incomplete: true },
      })
      expect(completed.usage.durationMs).toBeGreaterThan(stopped.turn.usage.durationMs)
      expect(completed.usage.firstTokenMs).toBeUndefined()
      expect((await page.evaluate(id => window.whomi.ai.getThread(id), stopped.thread.id)).turns).toHaveLength(1)
      expect(requests.filter(request => request.kind === 'stopped')).toEqual([1, 2, 3].map(attempt => ({ kind: 'stopped', attempt, model: model.model })))
      expect(requests).toHaveLength(5)
      await answer.getByRole('button', { name: /^输出 18 token\b/ }).click()
      const stats = page.getByRole('region', { name: '生成统计' })
      await expect(stats.getByTestId('message-metric-input')).toContainText('90 Tokens')
      await expect(stats.getByTestId('message-metric-output')).toContainText('18 Tokens')
      await page.keyboard.press('Escape')
    })

    await test.step('render remote image placeholders and a link without requesting the remote host', async () => {
      const body = reply(stopped.turn).locator('.conversation-answer-text')
      await expect(body).toContainText('远程图片示例')
      await expect(body.getByRole('link', { name: '只供显式打开的链接' })).toHaveAttribute('href', 'https://' + resourceHost + '/page')
      await expect(body.locator('img')).toHaveCount(0)
      expect(remoteResourceRequests).toEqual([])
    })
  } finally {
    await application?.close()
    server.closeAllConnections()
    if (server.listening) await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
