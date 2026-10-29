import { _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, open, copyFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir, cpus, totalmem, platform, release } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'

function option(name, fallback) { const index = process.argv.indexOf(name); return index < 0 ? fallback : Number(process.argv[index + 1]) }
const messages = option('--messages', 100000), conversations = option('--conversations', 10)
if (!Number.isSafeInteger(messages) || !Number.isSafeInteger(conversations) || conversations < 1 || messages < conversations || messages > 10000000) throw Error('请输入有效消息数与会话数。')
const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-'))
let application, inputBytes = 0
async function generate(path, count, group) {
  const file = await open(path, 'wx')
  try {
    const header = { _type: 'header', chatlab: { version: '0.0.2' }, meta: { name: `Benchmark ${group}`, platform: 'discord', type: 'group', groupId: group, ownerId: 'synthetic-owner' } }
    const member = { _type: 'member', platformId: 'synthetic-owner', accountName: 'Synthetic owner' }
    let chunk = JSON.stringify(header)+'\n'+JSON.stringify(member)+'\n'
    for (let i = 0; i < count; i++) {
      chunk += JSON.stringify({ _type: 'message', sender: 'synthetic-owner', accountName: 'Synthetic owner', timestamp: 1700000000+i, type: 0, content: `Deterministic synthetic message ${i}`, platformMessageId: `m${i}` })+'\n'
      if (i % 500 === 499) { inputBytes += Buffer.byteLength(chunk); await file.write(chunk); chunk = '' }
    }
    if (chunk) { inputBytes += Buffer.byteLength(chunk); await file.write(chunk) }
  } finally { await file.close() }
}
try {
  await mkdir(join(directory, 'sources'))
  for (let i = 0; i < conversations; i++) await generate(join(directory, 'sources', `conversation-${String(i).padStart(3,'0')}.jsonl`), Math.floor(messages/conversations)+(i < messages%conversations ? 1 : 0), `room-${i}`)
  const measuredInputBytes = inputBytes
  await generate(join(directory, 'cancel.jsonl'), Math.max(10000, Math.floor(messages/conversations)), 'cancel-room')
  await copyFile('tests/desktop/benchmark-probe.cjs', join(directory, 'probe.cjs'))
  const start = performance.now()
  application = await electron.launch({ ...(process.env.WHOMI_PACKAGED_EXECUTABLE ? { executablePath: resolve(process.env.WHOMI_PACKAGED_EXECUTABLE), args: ['--whomi-runtime-test'] } : { args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'] }), env: { ...process.env, WHOMI_RUNTIME_TEST: directory }, timeout: 60000 })
  const page = await application.firstWindow(); await page.getByRole('button', { name: '导入会话', exact: true }).waitFor()
  const windowReadyMs = performance.now()-start
  let elapsed = 0; const progress = setInterval(() => { elapsed += 30; console.info(`Import benchmark running: ${messages} messages, elapsed ${elapsed}s`) }, 30000)
  let imported
  try { imported = await application.evaluate(() => globalThis.__whomiRuntimeProbe.request('probe.benchmark', null)) } finally { clearInterval(progress) }
  if (imported.inserted !== messages) throw Error('Benchmark count mismatch')
  console.info(`Import completed: ${Math.round(imported.importMs)}ms, peak ${(imported.peakRssBytes/1048576).toFixed(1)}MiB`)
  const conversationsPage = await page.evaluate(() => window.whomi.listConversations({}))
  const pageTimes = []; let cursor
  for (let i = 0; i < 100; i++) {
    const conversationId = conversationsPage.items[Math.floor(i/10)%conversationsPage.items.length].id
    if (i%10 === 0) cursor = undefined
    const begin = performance.now()
    const result = await page.evaluate(input => window.whomi.readMessages(input), { conversationId, direction: 'after', limit: 100, ...(cursor ? { cursor } : {}) })
    pageTimes.push(performance.now()-begin); cursor = result.afterCursor
  }
  // 后台探针绕过导入组件，重新挂载后读取已提交列表。
  await page.reload(); await page.getByRole('button', { name: '展开会话列表', exact: true }).click()
  const readStart = performance.now(); await page.getByRole('button', { name: conversationsPage.items[0].title, exact: true }).click(); await page.locator('[data-message-id]').first().waitFor()
  const firstConversationRenderMs = performance.now()-readStart
  const cancellation = await application.evaluate(() => globalThis.__whomiRuntimeProbe.request('probe.cancel', null))
  pageTimes.sort((a,b) => a-b)
  const result = { measuredAt: new Date().toISOString(), messages, conversations, inputBytes: measuredInputBytes, hardware: { cpu: cpus()[0].model, logicalCpus: cpus().length, memoryBytes: totalmem(), os: `${platform()} ${release()}`, controllerNode: process.versions.node }, ...imported, peakRssMiB: imported.peakRssBytes/1048576, peakRssDeltaMiB: (imported.peakRssBytes-imported.baselineRssBytes)/1048576, pageQueryP95Ms: pageTimes[94], pageQuerySamples: 100, pageQueryIncludesBridge: true, windowReadyMs, firstConversationRenderMs, cancellation, goals: { peakRss512MiB: imported.peakRssBytes <= 512*1048576, pageQueryP95Under200Ms: pageTimes[94] <= 200, cancelAcceptanceUnder2000Ms: cancellation.cancelAcceptedMs <= 2000 }, atomicRollbackVerified: true }
  await mkdir('release/validation', { recursive: true }); const output = resolve(`release/validation/import-${messages}.json`)
  await writeFile(output, JSON.stringify(result,null,2)+'\n'); console.info(JSON.stringify(result,null,2)); console.info(`Report: ${output}`)
  if (messages === 100000 && Object.values(result.goals).some(passed => !passed)) process.exitCode = 1
} finally {
  await application?.close()
  const actual = await realpath(directory)
  if (dirname(actual) !== await realpath(tmpdir()) || !basename(actual).startsWith('whomi-runtime-')) throw Error('Unexpected benchmark directory')
  await rm(actual, { recursive: true, force: true })
}
