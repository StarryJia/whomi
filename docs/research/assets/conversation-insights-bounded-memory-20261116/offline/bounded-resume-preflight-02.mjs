import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { validateReadingChain } from '../../tests/quality/insight-comparison-resume.ts'
import { comparisonArguments } from '../../tests/quality/insight-comparison-profile.mjs'

const root = 'release/conversation-insights-20261115/long-comparison-runs/memory-bounded-20261116'
const names = ['reading', 'reading-resume']
const directories = names.map(name => root + '/shared-workload-' + name)
const files = directories.flatMap(directory => fs.readdirSync(directory).map(name => path.join(directory, name))).concat(root + '/halt.json')
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const before = Object.fromEntries(files.map(file => [file, hash(file)]))
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const phases = directories.map((directory, index) => ({
  phase: names[index], input: read(directory + '/input.json'), snapshot: read(directory + '/snapshot.json'),
  checkpoint: read(directory + '/checkpoint.json'), result: read(directory + '/result.json'),
  archivedHalt: read(index === 0 ? directory + '/halt-before-resume.json' : root + '/halt.json'),
  ledger: fs.readFileSync(directory + '/attempts.jsonl', 'utf8'),
}))
const { profile } = comparisonArguments(['--long-comparison', 'shared-workload', 'reading', '--resume-reading=2', '--task-call-limit=50', '--run-id=memory-bounded-20261116'])
const material = profile.cases['shared-workload']
const expectedInput = {
  caseName: 'shared-workload', variant: 'reading', experiment: profile.experiment, scope: material.scope,
  messages: material.messages, excluded: material.excluded, limits: profile.perTaskLimits, model: 'gpt-6.1-sol', runId: profile.runId,
  protocol: phases[0].input.protocol, configuredCapacity: phases[0].input.configuredCapacity, syntheticPackingInputEstimateLimit: 7000,
  perRequestOutputLimit: 3000, totalRequestLimit: 104,
}
const charges = validateReadingChain(phases, {
  caseName: 'shared-workload', expectedInput, expectedSnapshot: phases[0].snapshot, modelVersion: 1,
  prompts: phases[0].checkpoint.prompts, expectedLimits: profile.perTaskLimits, sourceIds: material.messages.map(message => message.id), resuming: true,
})
if (files.some(file => before[file] !== hash(file))) throw new Error('Original artifacts changed')
const checkpoint = phases.at(-1).checkpoint
const verification = {
  networkCalls: 0, resumable: true, ordinal: 2, originalArtifactsUnchanged: true, originalHashes: before,
  charges, callsReserved: checkpoint.callsReserved, remainingCalls: checkpoint.limits.maxCalls - checkpoint.callsReserved,
  readCount: checkpoint.coveredMessageIds.length, navigationCursor: checkpoint.navigation.cursor,
  navigationRoots: checkpoint.navigation.roots.length, nextRoots: checkpoint.navigation.nextRoots.length,
  navigationRepairs: checkpoint.navigation.repairs,
}
fs.writeFileSync('release/conversation-insights-20261115/memory-retest/bounded-resume-preflight-02.json', JSON.stringify(verification, null, 2) + '\n', { flag: 'wx' })
const { originalHashes, ...summary } = verification
console.log(JSON.stringify({ ...summary, originalArtifactCount: Object.keys(originalHashes).length }, null, 2))
