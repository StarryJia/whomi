import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
const root = 'docs/research/assets/conversation-insights-paired-capacity-20261116'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const manifest = read(root + '/archive-audit.json')
const issues = [], paths = []
function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) issues.push({ file, kind: 'symlink' })
    else if (entry.isDirectory()) visit(file)
    else paths.push(file)
  }
}
visit(root)
for (const item of manifest.files) {
  const copy = fs.readFileSync(path.join(root, item.file)), original = fs.readFileSync(item.source)
  if (copy.length !== item.bytes || hash(copy) !== item.sha256 || hash(original) !== item.sha256) issues.push({ file: item.file, kind: 'hash-or-size' })
}
const sensitive = [
  /\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})/i,
  /\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{16,}/,
  /"(?:apiKey|api_key|accessToken|access_token|refreshToken|refresh_token|clientSecret|client_secret|credential|authorization)"\s*:\s*"(?!\[redacted\])[^\"]+"/i,
  /-----BEGIN (?:(?:RSA|EC|OPENSSH|DSA) )?PRIVATE KEY-----/,
  /C:\x5c{1,2}Users|AppData.*[\\/]Roaming.*[\\/]whomi|whomi\.db/i,
]
for (const file of paths) {
  const text = fs.readFileSync(file, 'utf8')
  for (const [index, pattern] of sensitive.entries()) if (pattern.test(text)) issues.push({ file, kind: 'sensitive-pattern', pattern: index })
}
const readme = fs.readFileSync(root + '/README.md', 'utf8')
for (const match of readme.matchAll(/\]\(([^)]+)\)/g)) if (!/^https?:/.test(match[1]) && !fs.existsSync(path.resolve(root, match[1].split('#')[0]))) issues.push({ file: 'README.md', kind: 'broken-link', target: match[1] })
const generated = ['README.md', 'archive-audit.json', 'validation/summary.json', 'reviews/revealed-summary.json']
const accounted = new Set([...manifest.files.map(file => file.file), ...generated])
for (const file of paths) { const relative = path.relative(root, file).split(path.sep).join('/'); if (!accounted.has(relative)) issues.push({ file: relative, kind: 'unlisted-file' }) }
const { insightLongComparisonCases: materials } = await import(pathToFileURL(path.resolve(root, 'implementations/paired-capacity-v2-frozen/current/source/tests/quality/insight-long-comparison-material.mjs')))
const materialsVerified = []
for (const [name, prefix] of [['shared-workload', 'workload'], ['conditional-reschedule', 'reschedule']]) {
  const source = read(root + '/reviews/' + prefix + '-sources.json')
  if (JSON.stringify(source.messages) !== JSON.stringify(materials[name].messages) || source.timezone !== materials[name].scope.timezone) issues.push({ file: prefix + '-sources.json', kind: 'review-originals-differ' })
  materialsVerified.push({ caseName: name, messages: source.messages.length, sha256: hash(JSON.stringify(source.messages)) })
}
let postTrialVerified = null
if (manifest.postTrialOfflineEvidenceIncluded) {
  const postRoot = root + '/post-trial-compatibility', post = read(postRoot + '/manifest.json')
  for (const item of [...post.sourceFiles, ...post.evidenceFiles]) if (hash(fs.readFileSync(postRoot + '/' + item.path)) !== item.sha256) issues.push({ file: item.path, kind: 'post-trial-manifest-mismatch' })
  if (hash(fs.readFileSync(postRoot + '/README.md')) !== post.readmeSha256) issues.push({ file: 'post-trial-compatibility/README.md', kind: 'post-trial-readme-mismatch' })
  if (hash(fs.readFileSync(root + '/implementations/paired-capacity-v2-frozen/current/source/electron/main/insight-generation.ts')) !== post.frozenModelControl.sha256) issues.push({ file: 'post-trial-compatibility/manifest.json', kind: 'post-trial-frozen-control-mismatch' })
  const replay = read(postRoot + '/evidence/quote-visible-scope-replay.json')
  if (post.realModelCallsAdded !== 0 || post.trialsRecovered !== 0 || replay.networkCalls !== 0 || replay.trialRecoveryPerformed || replay.modelResampled) issues.push({ file: 'post-trial-compatibility/manifest.json', kind: 'post-trial-boundary-mismatch' })
  for (const [name, digest] of Object.entries(replay.originalSourceHashes)) if (hash(fs.readFileSync(root + '/runs/memory-capacity-baseline-20261116/conditional-reschedule-reading/' + name)) !== digest) issues.push({ file: name, kind: 'post-trial-original-mismatch' })
  for (const item of post.sourceFiles) if (replay.productHashes[item.original] !== item.sha256) issues.push({ file: item.original, kind: 'post-trial-replay-source-mismatch' })
  postTrialVerified = { realModelCallsAdded: post.realModelCallsAdded, trialsRecovered: post.trialsRecovered, sourceFiles: post.sourceFiles.length, evidenceFiles: post.evidenceFiles.length, targetedTestsPassed: post.localVerification.targetedTestsPassed }
}
console.log(JSON.stringify({ directory: root, originalFilesChecked: manifest.files.length, allArchiveFilesScanned: paths.length, allBytes: paths.reduce((sum, file) => sum + fs.statSync(file).size, 0), postTrialIncluded: manifest.postTrialOfflineEvidenceIncluded, materialsVerified, postTrialVerified, issues }, null, 2))
if (issues.length) process.exitCode = 1
