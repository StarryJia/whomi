import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs'
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
