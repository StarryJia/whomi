import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const base = 'release/conversation-insights-20261115'
const destination = 'docs/research/assets/conversation-insights-paired-capacity-20261116'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const selected = new Map()
function add(source, target) {
  if (selected.has(target)) throw new Error('Duplicate archive target: ' + target)
  selected.set(target, source)
}
function visit(source, target) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourceFile = path.join(source, entry.name), targetFile = path.posix.join(target, entry.name)
    if (entry.isSymbolicLink()) throw new Error('Unexpected symlink: ' + sourceFile)
    if (entry.isDirectory()) visit(sourceFile, targetFile)
    else add(sourceFile, targetFile)
  }
}
for (const id of ['memory-capacity-baseline-20261116', 'memory-capacity-current-20261116', 'memory-capacity-current-v2-20261116']) visit(base + '/long-comparison-runs/' + id, 'runs/' + id)
const implementations = []
for (const folder of ['paired-capacity-frozen', 'paired-capacity-v2-frozen']) {
  const source = base + '/' + folder, manifest = read(source + '/implementation.json')
  for (const arm of ['current', 'baseline']) for (const item of manifest[arm + 'Files']) {
    if (hash(fs.readFileSync(source + '/' + arm + '/source/' + item.file)) !== item.sha256) throw new Error('Frozen source differs: ' + folder + '/' + item.file)
  }
  if (hash(fs.readFileSync(source + '/current/implementation.patch')) !== manifest.patchSha256) throw new Error('Frozen patch differs')
  const engine = read(source + '/baseline/manifest.json')
  if (hash(fs.readFileSync(source + '/baseline/baseline.mjs')) !== manifest.baselineBundleSha256 || engine.bundleSha256 !== manifest.baselineBundleSha256) throw new Error('Frozen baseline bundle differs')
  if (Object.keys(engine.sourceHashes).length !== 9) throw new Error('Unexpected baseline dependency count')
  visit(source, 'implementations/' + folder)
  implementations.push({ directory: 'implementations/' + folder, currentFiles: manifest.currentFiles.length, baselineFiles: manifest.baselineFiles.length, sourceHashesVerified: true, baselineBundleSha256: manifest.baselineBundleSha256 })
}
for (const file of ['paired-capacity-audit.mjs', 'paired-capacity-initial-audit.mjs', 'paired-capacity-monitor.mjs', 'paired-capacity-snapshot.mjs', 'paired-capacity-v2-snapshot.mjs', 'paired-capacity-blind.mjs', 'paired-capacity-archive.mjs']) add(base + '/' + file, 'offline/' + file)
add(base + '/paired-capacity-audit-final.json', 'audit.json')
for (const file of [
  'capacity-13000-preflight.json', 'capacity-13000-preflight.mjs',
  'mixed-kind-red.log', 'mixed-kind-coordination-red.log', 'mixed-kind-green.log', 'mixed-kind-green-final.log', 'mixed-kind-replay.json', 'mixed-kind-typecheck-final.log',
  'net-progress-red.log', 'net-progress-green-verified.log', 'net-progress-green-final.log', 'net-progress-replay.json', 'net-progress-typecheck-final.log',
  'paired-capacity-current-failed-audit.json', 'paired-capacity-current-failed-summary.json', 'paired-capacity-current-failed-summary.md',
  'paired-capacity-baseline-conditional-failure.json', 'paired-capacity-baseline-conditional-failure.md',
  'paired-capacity-workload-error-trace.json', 'paired-capacity-workload-error-trace.md', 'paired-capacity-workload-error-trace.mjs',
]) add(base + '/memory-retest/' + file, 'offline/' + file)
for (const file of ['paired-capacity-v2-backend-final.log', 'paired-capacity-v2-tool-tests-final.log', 'paired-capacity-v2-build-final.log', 'paired-capacity-v2-desktop-final.log', 'paired-capacity-v2-port-ranges-final.log', 'memory-frontend.log']) add(base + '/' + file, 'validation/' + file)
const blind = []
for (const name of ['shared-workload', 'conditional-reschedule']) {
  const mappingFile = base + '/paired-blind-' + name + '-mapping.json', mapping = read(mappingFile)
  add(mappingFile, 'reviews/' + name + '/mapping.json')
  visit(base + '/blind-source-order/paired-' + name, 'reviews/paired-' + name)
  const review = fs.readFileSync(base + '/blind-source-order/paired-' + name + '/blind-review.md', 'utf8')
  for (const entry of mapping.mapping) {
    const report = read(entry.file), anonymous = { aboutYou: report.aboutYou, relationship: report.relationship, citations: report.citations, limitations: report.limitations }
    const expected = JSON.stringify(anonymous, null, 2) + '\n', bytes = fs.readFileSync(path.join(mapping.output, entry.label + '.json'))
    if (!bytes.equals(Buffer.from(expected)) || hash(bytes) !== entry.anonymousSha256) throw new Error('Anonymous report or mapping differs: ' + entry.label)
    const row = review.split('\n').find(line => line.startsWith('|') && line.includes(entry.label) && /\d+\/20/.test(line))
    if (!row) throw new Error('Missing independent review: ' + entry.label)
    const total = Number(row.match(/(\d+)\/20/)[1])
    blind.push({ caseName: name, label: entry.label, arm: entry.arm === 'current' ? 'current-v2' : entry.arm, method: entry.method, total, maximum: 20, anonymousSha256: entry.anonymousSha256, projectionVerified: true })
  }
}
for (const file of ['workload-sources.json', 'workload-ground-truth.md', 'reschedule-sources.json', 'reschedule-ground-truth.md']) add(base + '/blind-source-order/' + file, 'reviews/' + file)
const audit = read(base + '/paired-capacity-audit-final.json')
if (audit.mode !== 'final' || audit.issues.length || audit.pending.length || audit.costs.allActual.requests !== 137 || audit.costs.allActual.inputTokens !== 328325 || audit.costs.allActual.outputTokens !== 161390) throw new Error('Final audit differs')
for (const id of ['memory-capacity-baseline-20261116', 'memory-capacity-current-20261116']) if (!fs.existsSync(base + '/long-comparison-runs/' + id + '/halt.json')) throw new Error('Original halt missing')
const postArgument = process.argv.find(argument => argument.startsWith('--post-trial='))?.slice('--post-trial='.length)
if (postArgument) {
  const full = path.resolve(postArgument), within = path.relative(path.resolve(base), full)
  if (!within || within.startsWith('..') || path.isAbsolute(within)) throw new Error('Post-trial evidence must remain in the release evidence directory')
  visit(full, 'post-trial-compatibility')
}
const sensitive = [
  /\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})/i,
  /"(?:apiKey|accessToken|refreshToken|clientSecret|credential|authorization)"\s*:\s*"(?!\[redacted\])[^\"]+"/i,
  /C:\x5c{1,2}Users|AppData.*[\\/]Roaming.*[\\/]whomi|whomi\.db/i,
]
const files = [...selected].map(([target, source]) => {
  if (!/\.(?:json|jsonl|txt|patch|md|mjs|ts|log)$/.test(target) || /(?:^|\/)(?:runtime|node_modules|\.env)(?:\/|$)|source\.tar$/.test(target)) throw new Error('Unexpected archive file: ' + target)
  const bytes = fs.readFileSync(source)
  if (sensitive.some(pattern => pattern.test(bytes.toString('utf8')))) throw new Error('Sensitive pattern in ' + target)
  return { source: source.split(path.sep).join('/'), file: target, bytes: bytes.length, sha256: hash(bytes) }
})
if (process.argv.includes('--check-only')) { console.log(JSON.stringify({ sourceFiles: files.length, sourceBytes: files.reduce((sum, file) => sum + file.bytes, 0), sensitivePatternMatches: 0, anonymousProjections: blind, implementations }, null, 2)); process.exit(0) }
fs.mkdirSync(destination, { recursive: true })
for (const file of files) {
  const target = path.join(destination, file.file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (!fs.existsSync(target)) fs.copyFileSync(file.source, target, fs.constants.COPYFILE_EXCL)
  if (hash(fs.readFileSync(target)) !== file.sha256 || hash(fs.readFileSync(file.source)) !== file.sha256) throw new Error('Original or archive copy changed: ' + file.file)
}
const validation = {
  scope: 'Pre-model frozen v2 implementation; post-trial offline compatibility evidence is separate.',
  focusedBackend: { passed: 89, failed: 0, log: 'offline/mixed-kind-green-final.log' },
  tools: { passed: 36, failed: 0, log: 'validation/paired-capacity-v2-tool-tests-final.log' },
  frontend: { passed: 592, failed: 0, unchangedFrontendEarlierValidation: true, log: 'validation/memory-frontend.log' },
  typecheck: { passed: true, log: 'offline/mixed-kind-typecheck-final.log' },
  backend: { passed: 672, failed: 1, unhandledErrors: 1, failure: 'Grok fixed callback port 56121 is in Windows excluded range 56028–56127', log: 'validation/paired-capacity-v2-backend-final.log', portEvidence: 'validation/paired-capacity-v2-port-ranges-final.log' },
  build: { passed: true, log: 'validation/paired-capacity-v2-build-final.log' },
  desktop: { passed: 1, failed: 0, totalSeconds: 9.9, log: 'validation/paired-capacity-v2-desktop-final.log' },
}
fs.writeFileSync(destination + '/validation/summary.json', JSON.stringify(validation, null, 2) + '\n')
fs.writeFileSync(destination + '/reviews/revealed-summary.json', JSON.stringify({ methodology: 'Independent agent qualitative rubric, not human acceptance or statistical accuracy; 0–5 on four domains, sum out of 20.', reports: blind, comparisonScope: audit.reportComparisonScope }, null, 2) + '\n')
const verification = {
  kind: 'paired-capacity-evidence-archive', closed: true, resumePermitted: false,
  trialOutcomes: audit.runs.map(run => ({ arm: run.arm, runId: run.runId, totals: run.totals, comparisons: run.comparisons })),
  retiredInitialCurrent: audit.retiredInitialCurrent,
  costs: { ...audit.costs, thisPairedExperimentIncludingRetired: { requests: 53, inputTokens: 176457, outputTokens: 83503 } },
  implementations, postTrialOfflineEvidenceIncluded: !!postArgument,
  allOriginalCopiesByteIdentical: true, originalFilesUnchanged: true, sensitivePatternMatches: 0,
  copiedFiles: files.length, copiedBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  excluded: ['Full source.tar', 'Whole baseline source tree', 'Desktop runtime', 'Databases', 'Installed model configuration', 'Credentials', 'Earlier three closed archives'],
  files,
}
fs.writeFileSync(destination + '/archive-audit.json', JSON.stringify(verification, null, 2) + '\n')
const { files: omitted, trialOutcomes: details, ...summary } = verification
console.log(JSON.stringify({ destination, ...summary }, null, 2))
