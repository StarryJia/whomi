import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
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

test('a named long trial isolates its output and keeps the frozen cases and budgets', () => {
  const result = spawnSync(process.execPath, ['scripts/insight-quality.mjs', '--long-comparison', '--dry-run', '--run-id=memory-preservation-20261115'], {
    encoding: 'utf8', env: { ...process.env, WHOMI_QUALITY_DB: 'unavailable-comparison-dry-run.sqlite' },
  })
  assert.equal(result.status, 0, result.stderr)
  const plan = JSON.parse(result.stdout)
  assert.equal(plan.runId, 'memory-preservation-20261115')
  assert.equal(plan.outputDirectory, 'long-comparison-runs/memory-preservation-20261115')
  assert.equal(plan.totalRequestLimit, 64)
  assert.equal(plan.syntheticPackingInputEstimateLimit, 7000)
  assert.equal(plan.perRequestOutputLimit, 3000)
  assert.equal(plan.perTaskLimits.maxCalls, 28)
  assert.equal(plan.modelCalls, 0)
  assert.deepEqual(plan.cases.map(({ caseName, messageCount }) => [caseName, messageCount]),
    [['shared-workload', 120], ['conditional-reschedule', 120]])
})

test('named trial parsing rejects ambiguous or escaping destinations before configuration access', async () => {
  const { comparisonArguments } = await import('./insight-comparison-profile.mjs')
  const original = comparisonArguments(['--long-comparison', 'shared-workload', 'reading'])
  const named = comparisonArguments(['--long-comparison', 'shared-workload', 'reading', '--resume-reading', '--run-id=memory-preservation-20261115'])
  assert.equal(original.profile.outputDirectory, 'long-comparison')
  assert.equal(original.profile.runtimeDirectory, '.long-comparison-runtime')
  assert.deepEqual(named.args, ['--long-comparison', 'shared-workload', 'reading', '--resume-reading'])
  assert.equal(named.profile.outputDirectory, 'long-comparison-runs/memory-preservation-20261115')
  assert.equal(named.profile.runtimeDirectory, '.memory-preservation-20261115-runtime')
  for (const args of [
    ['--comparison', '--dry-run', '--run-id=round-two'],
    ['--long-comparison', '--dry-run', '--run-id=../long-comparison'],
    ['--long-comparison', '--dry-run', '--run-id=round/two'],
    ['--long-comparison', '--dry-run', '--run-id=round\\two'],
    ['--long-comparison', '--dry-run', '--run-id='],
    ['--long-comparison', '--dry-run', '--run-id=round-two', '--run-id=round-three'],
    ['--long-comparison', '--run-id=round-two', '--dry-run'],
  ]) {
    const result = spawnSync(process.execPath, ['scripts/insight-quality.mjs', ...args], {
      encoding: 'utf8', env: { ...process.env, WHOMI_QUALITY_DB: 'unavailable-comparison-dry-run.sqlite' },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /INVALID_COMPARISON_RUN_ID/)
    assert.doesNotMatch(result.stderr, /WHOMI_QUALITY_DB/)
  }
})

test('a named long trial can reserve natural checking room without changing the total request budget', async () => {
  const result = spawnSync(process.execPath, ['scripts/insight-quality.mjs', '--long-comparison', '--dry-run',
    '--task-call-limit=30', '--run-id=memory-preservation-20261115'], {
    encoding: 'utf8', env: { ...process.env, WHOMI_QUALITY_DB: 'unavailable-comparison-dry-run.sqlite' },
  })
  assert.equal(result.status, 0, result.stderr)
  const plan = JSON.parse(result.stdout)
  assert.equal(plan.modelCalls, 0)
  assert.equal(plan.perTaskLimits.maxCalls, 30)
  assert.equal(plan.totalRequestLimit, 64)
  const { comparisonArguments } = await import('./insight-comparison-profile.mjs')
  const parsed = comparisonArguments(['--long-comparison', 'shared-workload', 'reading', '--resume-reading',
    '--task-call-limit=30', '--run-id=memory-preservation-20261115'])
  assert.deepEqual(parsed.args, ['--long-comparison', 'shared-workload', 'reading', '--resume-reading'])
  assert.equal(parsed.profile.perTaskLimits.maxCalls, 30)
})

test('an explicit task request limit requires a named long trial and stays within the shared budget', async () => {
  const { comparisonArguments } = await import('./insight-comparison-profile.mjs')
  for (const args of [
    ['--long-comparison', '--dry-run', '--task-call-limit=30'],
    ['--comparison', '--dry-run', '--task-call-limit=30', '--run-id=round-two'],
    ...['0', '-1', '1.5', '51', '9007199254740992', '', '03'].map(value =>
      ['--long-comparison', '--dry-run', '--task-call-limit=' + value, '--run-id=round-two']),
    ['--long-comparison', '--dry-run', '--task-call-limit=29', '--task-call-limit=30', '--run-id=round-two'],
    ['--long-comparison', '--task-call-limit=30', '--dry-run', '--run-id=round-two'],
  ]) assert.throws(() => comparisonArguments(args), { code: 'INVALID_COMPARISON_TASK_CALL_LIMIT' })
  assert.equal(comparisonArguments(['--long-comparison', '--dry-run', '--task-call-limit=1', '--run-id=round-two'])
    .profile.perTaskLimits.maxCalls, 1)
})

test('a bounded compaction trial reserves both task budgets and their comparison reports before dispatch', () => {
  const result = spawnSync(process.execPath, ['scripts/insight-quality.mjs', '--long-comparison', '--dry-run',
    '--task-call-limit=50', '--run-id=memory-bounded-20261116'], {
    encoding: 'utf8', env: { ...process.env, WHOMI_QUALITY_DB: 'unavailable-comparison-dry-run.sqlite' },
  })
  assert.equal(result.status, 0, result.stderr)
  const plan = JSON.parse(result.stdout)
  assert.equal(plan.modelCalls, 0)
  assert.equal(plan.perTaskLimits.maxCalls, 50)
  assert.equal(plan.totalRequestLimit, 104)
  assert.equal(plan.perTaskLimits.maxOutputTokens, 40000)
  assert.equal(plan.syntheticPackingInputEstimateLimit, 7000)
  assert.equal(plan.perRequestOutputLimit, 3000)
})

test('starting the other case cannot raise a legacy run budget before configuration access', async t => {
  const { comparisonArguments } = await import('./insight-comparison-profile.mjs')
  const runId = 'profile-guard-' + process.pid + '-' + Date.now()
  const profile = comparisonArguments(['--long-comparison', 'shared-workload', 'reading',
    '--task-call-limit=30', '--run-id=' + runId]).profile
  const parent = join('release', 'conversation-insights-20261115', 'long-comparison-runs')
  mkdirSync(parent, { recursive: true })
  const output = join(parent, runId)
  mkdirSync(output)
  const phase = join(output, 'shared-workload-reading')
  mkdirSync(phase)
  const sample = profile.cases['shared-workload']
  const original = JSON.stringify({ caseName: 'shared-workload', variant: 'reading', ...sample,
    limits: { maxChecks: 8, maxRoundsPerCheck: 4, maxCalls: 30, maxInputTokens: 400000, maxOutputTokens: 40000, maxElapsedMs: 1200000 },
    experiment: 'long-candidate-comparison', runId, totalRequestLimit: 64,
    syntheticPackingInputEstimateLimit: 7000, perRequestOutputLimit: 3000 })
  writeFileSync(join(phase, 'input.json'), original)
  t.after(() => {
    unlinkSync(join(phase, 'input.json'))
    rmdirSync(phase)
    if (existsSync(join(output, 'run-profile.json'))) unlinkSync(join(output, 'run-profile.json'))
    rmdirSync(output)
  })
  const result = spawnSync(process.execPath, ['scripts/insight-quality.mjs', '--long-comparison', 'conditional-reschedule', 'reading',
    '--task-call-limit=50', '--run-id=' + runId], {
    encoding: 'utf8', env: { ...process.env, WHOMI_QUALITY_DB: 'unavailable-profile-guard.sqlite',
      WHOMI_QUALITY_PROVIDER_ID: '', WHOMI_QUALITY_MODEL_ID: '' },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /INVALID_COMPARISON_RUN_PROFILE/)
  assert.doesNotMatch(result.stderr, /Set WHOMI_QUALITY_DB/)
  assert.equal(readFileSync(join(phase, 'input.json'), 'utf8'), original)
  assert.equal(existsSync(join(output, 'run-profile.json')), false)
  assert.deepEqual(readdirSync(output), ['shared-workload-reading'])
})

function profileDirectory(t) {
  const output = mkdtempSync(join(tmpdir(), 'whomi-run-profile-'))
  t.after(() => {
    for (const item of readdirSync(output, { withFileTypes: true })) {
      const file = join(output, item.name)
      if (item.isDirectory()) {
        for (const name of readdirSync(file)) unlinkSync(join(file, name))
        rmdirSync(file)
      } else unlinkSync(file)
    }
    rmdirSync(output)
  })
  return output
}

test('a new run freezes all budgets and material hashes without rewriting its profile', async t => {
  const { ensureComparisonRunProfile } = await import('./insight-comparison-run.mjs')
  const { comparisonArguments } = await import('./insight-comparison-profile.mjs')
  const profile = comparisonArguments(['--long-comparison', 'shared-workload', 'reading',
    '--task-call-limit=50', '--run-id=profile-fixture']).profile
  const output = profileDirectory(t)
  ensureComparisonRunProfile(output, profile)
  const file = join(output, 'run-profile.json')
  const original = readFileSync(file, 'utf8')
  const saved = JSON.parse(original)
  assert.equal(saved.perTaskLimits.maxCalls, 50)
  assert.equal(saved.perTaskLimits.maxOutputTokens, 40000)
  assert.equal(saved.totalRequestLimit, 104)
  assert.equal(saved.syntheticPackingInputEstimateLimit, 7000)
  assert.equal(saved.perRequestOutputLimit, 3000)
  assert.equal(saved.experiment, 'long-candidate-comparison')
  assert.equal(saved.runId, 'profile-fixture')
  assert.deepEqual(Object.keys(saved.materialHashes), ['shared-workload', 'conditional-reschedule'])
  assert.doesNotThrow(() => ensureComparisonRunProfile(output, profile))
  for (const mutate of [
    changed => { changed.perTaskLimits.maxCalls = 30; changed.requestLimit = 64 },
    changed => { changed.perTaskLimits.maxOutputTokens = 50000 },
    changed => { changed.packingLimit = 8000 },
    changed => { changed.outputLimit = 4000 },
    changed => { changed.experiment = 'different' },
    changed => { changed.runId = 'different' },
    changed => { changed.cases['conditional-reschedule'].messages[0].text += 'different' },
  ]) {
    const changed = structuredClone(profile)
    mutate(changed)
    assert.throws(() => ensureComparisonRunProfile(output, changed), { code: 'INVALID_COMPARISON_RUN_PROFILE' })
    assert.equal(readFileSync(file, 'utf8'), original)
  }
})

test('legacy task and one-call comparison phases migrate without changing their artifacts', async t => {
  const { ensureComparisonRunProfile } = await import('./insight-comparison-run.mjs')
  const { comparisonArguments } = await import('./insight-comparison-profile.mjs')
  const profile = comparisonArguments(['--long-comparison', 'shared-workload', 'reading',
    '--task-call-limit=30', '--run-id=profile-fixture']).profile
  const output = profileDirectory(t)
  const files = []
  for (const [caseName, variant, calls, outputTokens] of [
    ['shared-workload', 'reading', 30, 40000], ['shared-workload', 'adaptive', 30, 40000],
    ['shared-workload', 'direct', 1, 3000], ['shared-workload', 'direct-rich', 1, 3000],
    ['conditional-reschedule', 'reading', 30, 40000],
  ]) {
    const directory = join(output, caseName + '-' + variant)
    mkdirSync(directory)
    const content = JSON.stringify({ caseName, variant, ...profile.cases[caseName],
      limits: { maxChecks: 8, maxRoundsPerCheck: 4, maxCalls: calls, maxInputTokens: 400000, maxOutputTokens: outputTokens, maxElapsedMs: 1200000 },
      experiment: 'long-candidate-comparison', runId: 'profile-fixture', totalRequestLimit: 64,
      syntheticPackingInputEstimateLimit: 7000, perRequestOutputLimit: 3000 })
    const file = join(directory, 'input.json')
    writeFileSync(file, content)
    files.push({ file, content })
  }
  ensureComparisonRunProfile(output, profile)
  assert.equal(JSON.parse(readFileSync(join(output, 'run-profile.json'), 'utf8')).perTaskLimits.maxCalls, 30)
  for (const { file, content } of files) assert.equal(readFileSync(file, 'utf8'), content)
})

test('legacy migration checks every case and rejects incomplete dispatched artifacts', async t => {
  const { ensureComparisonRunProfile } = await import('./insight-comparison-run.mjs')
  const { comparisonArguments } = await import('./insight-comparison-profile.mjs')
  const profile = comparisonArguments(['--long-comparison', 'shared-workload', 'reading',
    '--task-call-limit=30', '--run-id=profile-fixture']).profile
  const output = profileDirectory(t)
  const input = caseName => ({ caseName, variant: 'reading', ...profile.cases[caseName],
    limits: { maxChecks: 8, maxRoundsPerCheck: 4, maxCalls: 30, maxInputTokens: 400000, maxOutputTokens: 40000, maxElapsedMs: 1200000 },
    experiment: 'long-candidate-comparison', runId: 'profile-fixture', totalRequestLimit: 64,
    syntheticPackingInputEstimateLimit: 7000, perRequestOutputLimit: 3000 })
  for (const caseName of ['shared-workload', 'conditional-reschedule']) {
    const directory = join(output, caseName + '-reading')
    mkdirSync(directory)
    const record = input(caseName)
    if (caseName === 'shared-workload') record.limits.maxCalls = 50
    writeFileSync(join(directory, 'input.json'), JSON.stringify(record))
  }
  assert.throws(() => ensureComparisonRunProfile(output, profile), { code: 'INVALID_COMPARISON_RUN_PROFILE' })
  assert.equal(existsSync(join(output, 'run-profile.json')), false)
  const directory = join(output, 'shared-workload-reading')
  unlinkSync(join(directory, 'input.json'))
  writeFileSync(join(directory, 'attempts.jsonl'), JSON.stringify({ kind: 'dispatched', call: 1 }) + '\n')
  assert.throws(() => ensureComparisonRunProfile(output, profile), { code: 'INVALID_COMPARISON_RUN_PROFILE' })
  assert.equal(existsSync(join(output, 'run-profile.json')), false)
})

test('second reading recovery requires an unbroken failed chain and keeps cumulative charges', async () => {
  const { validateReadingChain } = await import('./insight-comparison-resume.ts')
  const { comparisonDigest } = await import('./insight-comparison.ts')
  const limits = { maxChecks: 8, maxRoundsPerCheck: 4, maxCalls: 30, maxInputTokens: 400000, maxOutputTokens: 40000, maxElapsedMs: 1200000 }
  const input = { caseName: 'sample', variant: 'reading', model: 'sample-model', limits, messages: [{ id: '1' }, { id: '2' }, { id: '3' }] }
  const snapshot = { taskId: '201', createdAtMs: 123 }
  const attempt = n => ({ stage: 'reading', status: 'returned', input: { tokens: 100, method: 'estimate' }, reservedOutput: 3000,
    startedAtMs: n * 1000, usage: { totalInputTokens: 10, outputTokens: 20 } })
  const phase = n => {
    const checkpoint = { version: 1, taskId: '201', modelId: 'comparison-model', modelVersion: 1, prompts: { reading: 'fixed' }, limits,
      stage: 'reading', report: null, navigation: null, writingRepairs: 0, callsReserved: n, elapsedMs: n * 99,
      cursor: { messageIndex: n - 1, textOffset: 0 }, pendingRead: { from: { messageIndex: n - 1, textOffset: 0 }, to: { messageIndex: n, textOffset: 0 }, depth: 0, repairs: 0 },
      coveredMessageIds: ['1', '2', '3'].slice(0, n - 1), checks: [], attempts: Array.from({ length: n }, (_, i) => attempt(i + 1)) }
    const result = { state: 'failed', error: 'INVALID_EVIDENCE', calls: 1, httpRequests: 1, inputCharged: 10, outputCharged: 20, elapsedMs: 100 }
    return { phase: n === 1 ? 'reading' : 'reading-resume', input, snapshot, checkpoint, result,
      archivedHalt: { caseName: 'sample', variant: 'reading', ...result }, ledger: [
        { kind: 'reserved', stage: 'reading', call: 1, inputEstimate: 100, outputLimit: 3000 }, { kind: 'dispatched', call: 1 },
        { kind: 'settled', call: 1, usage: attempt(n).usage, charged: { input: 10, output: 20 } },
      ].map(JSON.stringify).join('\n') }
  }
  const first = phase(1), second = phase(2)
  second.input = { ...input, recovery: { sourcePhase: 'sample-reading', checkpointHash: comparisonDigest(first.checkpoint) } }
  const expected = { caseName: 'sample', expectedInput: input, expectedSnapshot: snapshot, modelVersion: 1,
    prompts: { reading: 'fixed' }, expectedLimits: limits, sourceIds: ['1', '2', '3'], resuming: true }
  assert.deepEqual(validateReadingChain([first, second], expected), { httpRequests: 2, inputCharged: 20, outputCharged: 40, elapsedMs: 200 })
  const third = phase(3)
  third.phase = 'reading-resume-2'
  third.input = { ...input, recovery: { sourcePhase: 'sample-reading-resume', checkpointHash: comparisonDigest(second.checkpoint) } }
  third.result = { state: 'completed', calls: 1, httpRequests: 1, inputCharged: 10, outputCharged: 20, elapsedMs: 100 }
  third.checkpoint = { ...third.checkpoint, stage: 'checking', pendingRead: null, navigation: { roots: [0] }, coveredMessageIds: ['1', '2', '3'] }
  assert.deepEqual(validateReadingChain([first, second, third], { ...expected, resuming: false }),
    { httpRequests: 3, inputCharged: 30, outputCharged: 60, elapsedMs: 300 })
  for (const mutate of [
    entries => { entries[1].phase = 'reading-resume-2' },
    entries => { delete entries[0].archivedHalt },
    entries => { entries[1].checkpoint.callsReserved = 1 },
    entries => { entries[1].checkpoint.attempts[0].usage.outputTokens = 1 },
    entries => { entries[1].input.model = 'different' },
    entries => { entries[1].result.inputCharged = 1 },
    entries => { entries[1].checkpoint.elapsedMs = 1 },
    entries => { entries[1].input.recovery.checkpointHash = 'different' },
    entries => { entries[1].ledger = entries[1].ledger.replace('"call":1', '"call":2') },
  ]) {
    const entries = structuredClone([first, second]); mutate(entries)
    assert.throws(() => validateReadingChain(entries, expected), { code: 'INVALID_COMPARISON_READING_RESUME' })
  }
})

test('reading recovery cannot skip a generation or overwrite an existing destination', async t => {
  const { readingChainPhases, assertReadingRecoverySettled, archivedReadingHaltName } = await import('./insight-comparison-resume.ts')
  const { readingResumeOrdinal } = await import('./insight-comparison-profile.mjs')
  assert.equal(readingResumeOrdinal('--resume-reading'), 1)
  assert.equal(readingResumeOrdinal('--resume-reading=2'), 2)
  assert.throws(() => readingResumeOrdinal('--resume-reading=3'), { code: 'INVALID_COMPARISON_READING_RESUME' })
  const output = mkdtempSync(join(tmpdir(), 'whomi-second-resume-'))
  const dirs = ['reading', 'reading-resume', 'reading-resume-2'].map(phase => join(output, 'sample-' + phase))
  t.after(() => {
    for (const dir of dirs.toReversed()) {
      for (const name of ['result.json', archivedReadingHaltName]) if (existsSync(join(dir, name))) unlinkSync(join(dir, name))
      if (existsSync(dir)) rmdirSync(dir)
    }
    rmdirSync(output)
  })
  mkdirSync(dirs[0])
  writeFileSync(join(dirs[0], archivedReadingHaltName), '{}')
  assert.deepEqual(readingChainPhases(output, 'sample', 1), ['reading'])
  assert.throws(() => readingChainPhases(output, 'sample', 2), { code: 'INVALID_COMPARISON_READING_RESUME' })
  mkdirSync(dirs[1])
  writeFileSync(join(dirs[1], archivedReadingHaltName), '{}')
  writeFileSync(join(dirs[1], 'result.json'), JSON.stringify({ state: 'failed' }))
  assert.throws(() => readingChainPhases(output, 'sample', 1), { code: 'INVALID_COMPARISON_READING_RESUME' })
  assert.deepEqual(readingChainPhases(output, 'sample', 2), ['reading', 'reading-resume'])
  assert.throws(() => assertReadingRecoverySettled(output, ['sample']), { code: 'TRIAL_HALTED' })
  mkdirSync(dirs[2])
  assert.throws(() => readingChainPhases(output, 'sample', 2), { code: 'INVALID_COMPARISON_READING_RESUME' })
  writeFileSync(join(dirs[2], 'result.json'), JSON.stringify({ state: 'completed' }))
  assert.doesNotThrow(() => assertReadingRecoverySettled(output, ['sample']))
  assert.deepEqual(readingChainPhases(output, 'sample'), ['reading', 'reading-resume', 'reading-resume-2'])
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

test('invalid compression output or insufficient capacity stops later trial phases', async t => {
  const { assertTrialNotHalted, recordComparisonHalt } = await import('./insight-comparison.ts')
  for (const code of ['INVALID_INSIGHT_OUTPUT', 'CONTEXT_TOO_LARGE']) {
    const output = mkdtempSync(join(tmpdir(), 'whomi-compression-halt-'))
    const halt = join(output, 'halt.json')
    t.after(() => {
      if (existsSync(halt)) unlinkSync(halt)
      rmdirSync(output)
    })
    const original = JSON.stringify({ error: code, httpRequests: 2 })
    recordComparisonHalt(output, code, original)
    assert.throws(() => assertTrialNotHalted(output), { code: 'TRIAL_HALTED' })
    recordComparisonHalt(output, code, JSON.stringify({ error: code, httpRequests: 3 }))
    assert.equal(readFileSync(halt, 'utf8'), original)
  }
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
