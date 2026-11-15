import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
const base = 'release/conversation-insights-20261115'
const root = 'docs/research/assets/conversation-insights-paired-capacity-20261116'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const manifest = read(root + '/archive-audit.json')
for (const item of manifest.files) {
  if (hash(fs.readFileSync(root + '/' + item.file)) !== item.sha256 || hash(fs.readFileSync(item.source)) !== item.sha256) throw new Error('Existing evidence changed: ' + item.file)
}
const names = [
  'post-trial-backend-final.log', 'post-trial-build-final.log', 'post-trial-tool-tests-final.log',
  'post-trial-port-ranges-final.log', 'post-trial-desktop-final.log',
  'post-trial-desktop-timeout-context.md', 'post-trial-desktop-diagnostic.log',
  'memory-desktop-baseline-debug.log',
]
for (const name of [...names, 'paired-capacity-archive-finalize.mjs']) {
  const source = base + '/' + name
  const file = (name.endsWith('.mjs') ? 'offline/' : 'validation/') + name
  const bytes = fs.readFileSync(source)
  const item = { source, file, bytes: bytes.length, sha256: hash(bytes) }
  const previous = manifest.files.find(entry => entry.file === file)
  if (previous && previous.sha256 !== item.sha256) throw new Error('Existing entry changed: ' + file)
  fs.mkdirSync(path.dirname(root + '/' + file), { recursive: true })
  if (!fs.existsSync(root + '/' + file)) fs.copyFileSync(source, root + '/' + file, fs.constants.COPYFILE_EXCL)
  if (hash(fs.readFileSync(root + '/' + file)) !== item.sha256) throw new Error('Copy mismatch: ' + file)
  if (!previous) manifest.files.push(item)
}
const validation = read(root + '/validation/summary.json')
validation.postTrial = {
  realModelCallsAdded: 0,
  productGenerationSha256: '294693d887a8a1c6128fd1328c522e5163f7e21fe0e6694c6cbcf295e4a0c51d',
  focusedBackend: { passed: 104, failed: 0, log: '../post-trial-compatibility/evidence/quote-visible-scope-green.log' },
  typecheck: { passed: true, log: '../post-trial-compatibility/evidence/quote-visible-scope-typecheck.log' },
  backend: { passed: 687, failed: 1, unhandledErrors: 1, log: 'post-trial-backend-final.log', portEvidence: 'post-trial-port-ranges-final.log' },
  tools: { passed: 36, failed: 0, log: 'post-trial-tool-tests-final.log' },
  build: { passed: true, log: 'post-trial-build-final.log' },
  desktop: {
    firstAttempt: { failed: 1, timeoutMs: 60000, log: 'post-trial-desktop-final.log', exactCauseEstablished: false },
    diagnosticRetry: { passed: 1, totalSeconds: 9.5, testSeconds: 8.2, normalUserExecution: true, log: 'post-trial-desktop-diagnostic.log' },
    earlierSameCodeStartupFailure: { code: '0x80000003', message: 'Electron sandboxed process cannot read its runtime assets', log: 'memory-desktop-baseline-debug.log' },
  },
}
fs.writeFileSync(root + '/validation/summary.json', JSON.stringify(validation, null, 2) + '\n')
manifest.postTrial.finalValidationLogs = names.map(name => 'validation/' + name)
manifest.copiedFiles = manifest.files.length
manifest.copiedBytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0)
fs.writeFileSync(root + '/archive-audit.json', JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ copiedFiles: manifest.copiedFiles, copiedBytes: manifest.copiedBytes, added: names.length + 1, realModelCallsAdded: 0 }))
