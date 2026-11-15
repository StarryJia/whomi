import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('comparison dry run lists both fixed cases without opening the configuration database', () => {
  const result = spawnSync(process.execPath, ['scripts/insight-quality.mjs', '--comparison', '--dry-run'], {
    encoding: 'utf8', env: { ...process.env, WHOMI_QUALITY_DB: 'unavailable-comparison-dry-run.sqlite' },
  })
  assert.equal(result.status, 0, result.stderr)
  const plan = JSON.parse(result.stdout)
  assert.deepEqual(plan.cases.map(({ caseName, messageCount }) => [caseName, messageCount]), [
    ['shared-planning', 20], ['conditional-permission', 22],
  ])
  assert.equal(plan.modelCalls, 0)
})

test('the long trial has separate phases and limits without opening the configuration database', () => {
  const run = mode => spawnSync(process.execPath, ['scripts/insight-quality.mjs', mode, '--dry-run'], {
    encoding: 'utf8', env: { ...process.env, WHOMI_QUALITY_DB: 'unavailable-comparison-dry-run.sqlite' },
  })
  const longRun = run('--long-comparison')
  assert.equal(longRun.status, 0, longRun.stderr)
  const longPlan = JSON.parse(longRun.stdout)
  assert.deepEqual(longPlan.phases, ['reading', 'adaptive', 'direct', 'direct-rich'])
  assert.deepEqual(longPlan.cases.map(({ caseName, messageCount }) => [caseName, messageCount]),
    [['shared-workload', 120], ['conditional-reschedule', 120]])
  assert.equal(longPlan.outputDirectory, 'long-comparison')
  assert.equal(longPlan.totalRequestLimit, 64)
  assert.equal(longPlan.modelCalls, 0)
  assert.equal(longPlan.syntheticPackingInputEstimateLimit, 7000)
  assert.equal(longPlan.perRequestOutputLimit, 3000)
  assert.deepEqual(longPlan.perTaskLimits, {
    maxChecks: 8, maxRoundsPerCheck: 4, maxCalls: 28, maxInputTokens: 400_000, maxOutputTokens: 40_000, maxElapsedMs: 1_200_000,
  })
  const shortRun = run('--comparison')
  assert.equal(shortRun.status, 0, shortRun.stderr)
  const shortPlan = JSON.parse(shortRun.stdout)
  assert.equal(shortPlan.totalRequestLimit, 24)
  assert.deepEqual(shortPlan.phases, ['reading', 'adaptive', 'direct', 'full'])
})

test('direct writing keeps the shared notes and the frozen findings without citing pending guesses', async () => {
  const { comparisonWritingBase, comparisonDirectPayload, comparisonDirectEvidence } = await import('./insight-comparison.ts')
  const sent = {
    stage: 'writing', timezone: 'Asia/Shanghai',
    observations: [{ text: '观察', sourceIds: ['1'] }], openThreads: [{ text: '仍待回应', sourceIds: ['2'] }],
    checks: [{ id: 'c1', state: 'finished', finding: { supportingIds: ['8'], counterexampleIds: ['9'] } }],
    repair: true,
  }
  const frozen = [
    { id: 'c1', state: 'pending', observation: '暂定猜测', supportingIds: ['8'], finding: null },
    { id: 'c2', state: 'finished', observation: '已澄清', finding: {
      revisedObservation: '补充后的观察', supportingIds: ['3'], counterexampleIds: ['4'], alternativeExplanations: [], limitations: [],
    } },
  ]
  const direct = comparisonDirectPayload(comparisonWritingBase(JSON.stringify(sent)), frozen)
  assert.deepEqual(direct, {
    stage: 'writing', timezone: 'Asia/Shanghai',
    observations: [{ text: '观察', sourceIds: ['1'] }], openThreads: [{ text: '仍待回应', sourceIds: ['2'] }],
    checks: [
      { id: 'c1', state: 'pending', observation: '暂定猜测', finding: null },
      { id: 'c2', state: 'finished', finding: {
        revisedObservation: '补充后的观察', supportingIds: ['3'], counterexampleIds: ['4'], alternativeExplanations: [], limitations: [],
      } },
    ],
  })
  assert.deepEqual(comparisonDirectEvidence(direct), ['1', '2', '3', '4'])
})

test('the rich control sends only exact excerpts from the frozen reading state', async () => {
  const { comparisonReadEvidence, comparisonDirectPayload, comparisonDirectEvidence } = await import('./insight-comparison.ts')
  const frozen = [{
    id: 'c1', state: 'pending', observation: '待核解释', finding: null,
    evidenceNotes: [
      { sourceId: '3', quote: '如果下雨', text: '未经校验的释义' },
      { sourceId: '3', quote: '如果下雨', text: '重复摘录' },
      { sourceId: '3', quote: '先短信确认', text: '另一处摘录' },
    ],
  }]
  const sources = new Map([
    ['2', { id: '2', text: '还按原计划走吗？', senderName: '合成本人', isSelf: true, sentAtMs: 4900, replyToMessageId: null }],
    ['3', { id: '3', text: '如果下雨就改天，先短信确认。', senderName: '合成对方', isSelf: false, sentAtMs: 5000, replyToMessageId: '2' }],
    ['4', { id: '4', text: '核查之后才补充记录。', senderName: '合成本人', isSelf: true, sentAtMs: 6000, replyToMessageId: null }],
    ['5', { id: '5', text: '我收到了这条。', senderName: '合成对方', isSelf: false, sentAtMs: 7000, replyToMessageId: '999' }],
  ])
  const excerpts = comparisonReadEvidence(frozen, sources)
  assert.deepEqual(excerpts, [
    { sourceId: '3', quote: '如果下雨', senderName: '合成对方', isSelf: false, sentAtMs: 5000, replyToMessageId: '2' },
    { sourceId: '3', quote: '先短信确认', senderName: '合成对方', isSelf: false, sentAtMs: 5000, replyToMessageId: '2' },
  ])
  const base = { timezone: 'Asia/Shanghai', observations: [{ text: '已读笔记', sourceIds: ['1'] }], openThreads: [] }
  assert.deepEqual(comparisonDirectEvidence(comparisonDirectPayload(base, frozen)), ['1'])
  const rich = comparisonDirectPayload(base, frozen, excerpts)
  assert.deepEqual(rich.readEvidence, excerpts)
  assert.deepEqual(comparisonDirectEvidence(rich), ['1', '3'])
  assert.throws(() => comparisonReadEvidence([{ evidenceNotes: [{ sourceId: '999', quote: '如果下雨' }] }], sources),
    { code: 'OUTSIDE_EVIDENCE' })
  assert.throws(() => comparisonReadEvidence([{ evidenceNotes: [{ sourceId: '3', quote: '如果下雪' }] }], sources),
    { code: 'OUTSIDE_EVIDENCE' })
  const [outOfScopeReply] = comparisonReadEvidence([{ evidenceNotes: [{ sourceId: '5', quote: '我收到了这条' }] }], sources)
  assert.equal(outOfScopeReply.replyToMessageId, null)
})

test('the rich control needs a dispatched check that contained original text', async () => {
  const { hasDispatchedCheckingOriginals } = await import('./insight-comparison.ts')
  const requests = new Map([
    [1, { stage: 'checking', prompt: JSON.stringify({ evidence: [], evidenceNotes: [{ sourceId: '3', quote: '如果下雨' }] }) }],
    [2, { stage: 'checking', prompt: JSON.stringify({ evidence: [{ id: '3', text: '如果下雨就改天' }] }) }],
    [3, { stage: 'writing', prompt: '{}' }],
  ])
  const ledger = [
    { kind: 'dispatched', call: 1 },
    { kind: 'reserved', call: 2 },
    { kind: 'dispatched', call: 3 },
  ].map(entry => JSON.stringify(entry)).join('\n')
  const loadRequest = call => requests.get(call)
  assert.equal(hasDispatchedCheckingOriginals(ledger, loadRequest), false)
  const dispatched = JSON.stringify({ kind: 'dispatched', call: 2 })
  assert.equal(hasDispatchedCheckingOriginals(ledger + '\n' + dispatched, loadRequest), true)
})

function haltFolder(t) {
  const output = mkdtempSync(join(tmpdir(), 'whomi-comparison-halt-'))
  const marker = join(output, 'halt.json')
  t.after(() => {
    if (existsSync(marker)) unlinkSync(marker)
    rmdirSync(output)
  })
  return { output, marker }
}

test('an outbound rejection survives SDK wrapping and stops later comparison phases', async t => {
  const { createTrialOutboundGuard, assertTrialNotHalted, recordComparisonHalt } = await import('./insight-comparison.ts')
  const { output, marker } = haltFolder(t)
  const active = { outputLimit: 3000, call: 1, outbound: 0 }
  let dispatches = 0
  const guard = createTrialOutboundGuard({
    getActive: () => active, hasDispatchBudget: () => true, authorizedOrigin: 'https://api.openai.com',
    modelName: 'example-model', excludedText: 'outside material',
    dispatch: async () => { dispatches++; return new Response() },
  })
  const sdk = async () => {
    try {
      await guard.fetch('https://api.openai.com/unapproved', { method: 'POST' })
    } catch {
      throw Object.assign(new Error('wrapped by SDK'), { code: 'MODEL_REQUEST_FAILED' })
    }
  }
  assertTrialNotHalted(output)
  await assert.rejects(sdk().catch(error => {
    const failure = guard.restoreError(error)
    recordComparisonHalt(output, failure.code, JSON.stringify({ error: failure.code }))
    throw failure
  }), { code: 'UNAPPROVED_NETWORK_REQUEST' })
  assert.equal(dispatches, 0)
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), { error: 'UNAPPROVED_NETWORK_REQUEST' })
  assert.throws(() => assertTrialNotHalted(output), { code: 'TRIAL_HALTED' })
})

test('the production insight budget halts the comparison while a normal provider failure does not', async t => {
  const { createTrialOutboundGuard, assertTrialNotHalted, recordComparisonHalt } = await import('./insight-comparison.ts')
  const { output } = haltFolder(t)
  const guard = createTrialOutboundGuard({
    getActive: () => ({ outputLimit: 3000, call: 1, outbound: 0 }), hasDispatchBudget: () => true,
    authorizedOrigin: 'https://api.openai.com', modelName: 'example-model', excludedText: 'outside material',
    dispatch: async () => new Response(),
  })
  const providerError = Object.assign(new Error('provider failure'), { code: 'MODEL_REQUEST_FAILED' })
  assert.equal(guard.restoreError(providerError), providerError)
  recordComparisonHalt(output, providerError.code, JSON.stringify({ error: providerError.code }))
  assertTrialNotHalted(output)
  recordComparisonHalt(output, 'INSIGHT_BUDGET_EXHAUSTED', JSON.stringify({ error: 'INSIGHT_BUDGET_EXHAUSTED' }))
  assert.throws(() => assertTrialNotHalted(output), { code: 'TRIAL_HALTED' })
})

test('a prohibited writing repair stops subsequent long comparison phases', async t => {
  const { assertTrialNotHalted, recordComparisonHalt } = await import('./insight-comparison.ts')
  const { output, marker } = haltFolder(t)
  const error = 'COMPARISON_WRITING_REPAIR_DISABLED'
  recordComparisonHalt(output, error, JSON.stringify({ error, httpRequests: 1 }))
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), { error, httpRequests: 1 })
  assert.throws(() => assertTrialNotHalted(output), { code: 'TRIAL_HALTED' })
})

test('reading recovery requires the archived halt and a matching reading-only pending batch', async () => {
  const { validateReadingResume } = await import('./insight-comparison-resume.ts')
  const originalResult = {
    state: 'failed', error: 'INVALID_EVIDENCE', calls: 2, httpRequests: 2,
    inputCharged: 3891, outputCharged: 2018, elapsedMs: 36638,
  }
  const expectedLimits = {
    maxChecks: 8, maxRoundsPerCheck: 4, maxCalls: 28, maxInputTokens: 400_000, maxOutputTokens: 40_000, maxElapsedMs: 1_200_000,
  }
  const prepared = {
    caseName: 'shared-workload', originalResult, expectedLimits,
    sourceIds: ['1', '2', '3', '4'],
    archivedHalt: { caseName: 'shared-workload', variant: 'reading', ...originalResult },
    checkpoint: {
      stage: 'reading', report: null, navigation: null, writingRepairs: 0, callsReserved: 2, elapsedMs: 36633, limits: expectedLimits,
      cursor: { messageIndex: 2, textOffset: 0 },
      pendingRead: { from: { messageIndex: 2, textOffset: 0 }, to: { messageIndex: 4, textOffset: 0 }, depth: 0, repairs: 0 },
      attempts: [{ stage: 'reading', status: 'returned' }, { stage: 'reading', status: 'returned' }],
      checks: [], coveredMessageIds: ['1', '2'],
    },
    ledger: [
      { kind: 'reserved', stage: 'reading', call: 1 }, { kind: 'dispatched', call: 1 },
      { kind: 'reserved', stage: 'reading', call: 2 }, { kind: 'dispatched', call: 2 },
    ].map(entry => JSON.stringify(entry)).join('\n'),
  }
  assert.doesNotThrow(() => validateReadingResume(prepared))
  assert.throws(() => validateReadingResume({ ...prepared, archivedHalt: { ...prepared.archivedHalt, variant: 'adaptive' } }),
    { code: 'INVALID_COMPARISON_READING_RESUME' })
  assert.throws(() => validateReadingResume({ ...prepared, ledger: prepared.ledger.replace('"stage":"reading"', '"stage":"checking"') }),
    { code: 'INVALID_COMPARISON_READING_RESUME' })
  assert.throws(() => validateReadingResume({ ...prepared, checkpoint: { ...prepared.checkpoint, pendingRead: null } }),
    { code: 'INVALID_COMPARISON_READING_RESUME' })
  assert.throws(() => validateReadingResume({ ...prepared, checkpoint: { ...prepared.checkpoint, limits: { ...expectedLimits, maxCalls: 29 } } }),
    { code: 'INVALID_COMPARISON_READING_RESUME' })
})

test('only the halted reading phase may start before a successful recovery is recorded', async t => {
  const { archivedReadingHaltName, assertReadingRecoverySettled, sumComparisonCharges } = await import('./insight-comparison-resume.ts')
  const output = mkdtempSync(join(tmpdir(), 'whomi-comparison-resume-'))
  const reading = join(output, 'shared-workload-reading')
  const recovery = join(output, 'shared-workload-reading-resume')
  const archivedHalt = join(reading, archivedReadingHaltName)
  const result = join(recovery, 'result.json')
  mkdirSync(reading)
  mkdirSync(recovery)
  t.after(() => {
    for (const file of [result, archivedHalt]) if (existsSync(file)) unlinkSync(file)
    for (const folder of [reading, recovery, output]) rmdirSync(folder)
  })
  writeFileSync(archivedHalt, '{}')
  const cases = ['shared-workload', 'conditional-reschedule']
  assert.throws(() => assertReadingRecoverySettled(output, cases), { code: 'TRIAL_HALTED' })
  assert.throws(() => assertReadingRecoverySettled(output, cases, 'conditional-reschedule'), { code: 'TRIAL_HALTED' })
  assert.doesNotThrow(() => assertReadingRecoverySettled(output, cases, 'shared-workload'))
  writeFileSync(result, JSON.stringify({ state: 'failed' }))
  assert.throws(() => assertReadingRecoverySettled(output, cases), { code: 'TRIAL_HALTED' })
  writeFileSync(result, JSON.stringify({ state: 'completed' }))
  assert.doesNotThrow(() => assertReadingRecoverySettled(output, cases))
  assert.deepEqual(sumComparisonCharges(
    { httpRequests: 2, inputCharged: 3_891, outputCharged: 2_018, elapsedMs: 36_638 },
    { httpRequests: 8, inputCharged: 15_000, outputCharged: 4_000, elapsedMs: 128_000 },
  ), { httpRequests: 10, inputCharged: 18_891, outputCharged: 6_018, elapsedMs: 164_638 })
})
