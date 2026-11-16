import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { validateReadingChain } from '../../tests/quality/insight-comparison-resume.ts'
import { comparisonArguments } from '../../tests/quality/insight-comparison-profile.mjs'

const root = 'release/conversation-insights-20261115/long-comparison-runs/memory-bounded-20261116'
const phaseRoot = root + '/shared-workload-reading'
const files = ['input.json', 'snapshot.json', 'checkpoint.json', 'result.json', 'attempts.jsonl'].map(file => phaseRoot + '/' + file).concat(root + '/halt.json')
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const before = Object.fromEntries(files.map(file => [file, hash(file)]))
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const input = read(phaseRoot + '/input.json')
const snapshot = read(phaseRoot + '/snapshot.json')
const checkpoint = read(phaseRoot + '/checkpoint.json')
const result = read(phaseRoot + '/result.json')
const { profile } = comparisonArguments(['--long-comparison', 'shared-workload', 'reading', '--resume-reading', '--task-call-limit=50', '--run-id=memory-bounded-20261116'])
const material = profile.cases['shared-workload']
const expectedInput = {
  caseName: 'shared-workload', variant: 'reading', experiment: profile.experiment, scope: material.scope,
  messages: material.messages, excluded: material.excluded, limits: profile.perTaskLimits, model: 'gpt-6.1-sol', runId: profile.runId,
  protocol: input.protocol, configuredCapacity: input.configuredCapacity, syntheticPackingInputEstimateLimit: 7000,
  perRequestOutputLimit: 3000, totalRequestLimit: 104,
}
const charges = validateReadingChain([{
  phase: 'reading', input, snapshot, checkpoint, result, archivedHalt: read(root + '/halt.json'),
  ledger: fs.readFileSync(phaseRoot + '/attempts.jsonl', 'utf8'),
}], {
  caseName: 'shared-workload', expectedInput, expectedSnapshot: snapshot, modelVersion: 1,
  prompts: checkpoint.prompts, expectedLimits: profile.perTaskLimits, sourceIds: material.messages.map(message => message.id), resuming: true,
})
if (files.some(file => before[file] !== hash(file))) throw new Error('Original artifacts changed')
const verification = {
  networkCalls: 0, resumable: true, originalArtifactsUnchanged: true, originalHashes: before,
  charges, callsReserved: checkpoint.callsReserved, remainingCalls: checkpoint.limits.maxCalls - checkpoint.callsReserved,
  readCount: checkpoint.coveredMessageIds.length, navigationCursor: checkpoint.navigation.cursor,
  navigationRoots: checkpoint.navigation.roots.length, nextRoots: checkpoint.navigation.nextRoots.length,
}
fs.writeFileSync('release/conversation-insights-20261115/memory-retest/bounded-resume-preflight.json', JSON.stringify(verification, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify(verification, null, 2))
