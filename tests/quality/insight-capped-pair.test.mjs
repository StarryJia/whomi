import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { reserveStandardTextRequest } from './insight-capped-pair.mjs'

function ledgerFor(t) {
  const dir = mkdtempSync(join(tmpdir(), 'whomi-trial-cap-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'reservations.jsonl')
}

function reserve(ledger, content, options = {}, dispatched = 0) {
  const body = { model: 'gpt-6.1-sol', messages: [{ role: 'user', content }], max_completion_tokens: 6000, ...options }
  const request = new Request('https://api.openai.com/v1/chat/completions', { method: 'POST', body: JSON.stringify(body) })
  return reserveStandardTextRequest(request, body, ledger, dispatched)
}

test('four trial arms share a durable two-dollar ceiling even when a dispatched request returns no usage', async t => {
  const ledger = ledgerFor(t)
  const input = '合'.repeat(6400)
  const sent = reserve(ledger, input, { service_tier: 'priority' })
  assert.equal((await sent.json()).service_tier, 'default')
  for (let i = 1; i < 12; i++) reserve(ledger, input, {}, i)
  const previous = readFileSync(ledger, 'utf8')
  assert.throws(() => reserve(ledger, input, {}, 12), { code: 'TRIAL_COST_LIMIT' })
  assert.equal(readFileSync(ledger, 'utf8'), previous)
})

test('unpriced material stops before reservation, and a 25th cheap request cannot be sent', t => {
  const ledger = ledgerFor(t)
  for (const options of [{ model: 'another-model' }, { modalities: ['audio'] }, { functions: [{ name: 'extra' }] }]) {
    assert.throws(() => reserve(ledger, '试验', options), { code: 'UNPRICED_TRIAL_REQUEST' })
  }
  assert.equal(existsSync(ledger), false)
  for (let i = 0; i < 24; i++) reserve(ledger, '试验', { max_completion_tokens: 1 }, i)
  assert.throws(() => reserve(ledger, '试验', { max_completion_tokens: 1 }, 24), { code: 'TRIAL_CALL_LIMIT' })
  assert.equal(readFileSync(ledger, 'utf8').trim().split('\n').length, 24)
})

test('a later arm cannot use a missing, incomplete or inconsistent reservation ledger', t => {
  const ledger = ledgerFor(t)
  reserve(ledger, '试验')
  const first = readFileSync(ledger, 'utf8')
  unlinkSync(ledger)
  assert.throws(() => reserve(ledger, '试验', {}, 1), { code: 'INVALID_TRIAL_LEDGER' })
  assert.equal(existsSync(ledger), false)
  writeFileSync(ledger, first)
  assert.throws(() => reserve(ledger, '试验', {}, 2), { code: 'INVALID_TRIAL_LEDGER' })
  const invalid = JSON.stringify({ ...JSON.parse(first), microdollars: 1 }) + '\n'
  writeFileSync(ledger, invalid)
  assert.throws(() => reserve(ledger, '试验', {}, 1), { code: 'INVALID_TRIAL_LEDGER' })
  assert.equal(readFileSync(ledger, 'utf8'), invalid)
})
