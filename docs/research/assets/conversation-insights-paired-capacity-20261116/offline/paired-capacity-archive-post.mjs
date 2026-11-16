import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
const base = 'release/conversation-insights-20261115'
const root = 'docs/research/assets/conversation-insights-paired-capacity-20261116'
const postRoot = base + '/post-trial-compatibility'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const manifest = read(root + '/archive-audit.json'), post = read(postRoot + '/manifest.json')
for (const item of manifest.files) if (hash(fs.readFileSync(root + '/' + item.file)) !== item.sha256 || hash(fs.readFileSync(item.source)) !== item.sha256) throw new Error('Existing original or copy differs: ' + item.file)
for (const item of [...post.sourceFiles, ...post.evidenceFiles]) if (hash(fs.readFileSync(postRoot + '/' + item.path)) !== item.sha256) throw new Error('Post-trial snapshot differs: ' + item.path)
if (hash(fs.readFileSync(postRoot + '/README.md')) !== post.readmeSha256 || hash(fs.readFileSync(root + '/implementations/paired-capacity-v2-frozen/current/source/electron/main/insight-generation.ts')) !== post.frozenModelControl.sha256) throw new Error('Post-trial disclosure or model control differs')
const selected = new Map()
function visit(source, target) {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Unexpected symlink')
    const file = path.join(source, entry.name), destination = path.posix.join(target, entry.name)
    if (entry.isDirectory()) visit(file, destination)
    else selected.set(destination, file)
  }
}
visit(postRoot, 'post-trial-compatibility')
for (const file of ['paired-capacity-archive-post.mjs', 'paired-capacity-archive-verify.mjs']) selected.set('offline/' + file, base + '/' + file)
const validationFiles = process.argv.find(argument => argument.startsWith('--validation-files='))?.slice('--validation-files='.length).split(',') ?? []
for (const file of validationFiles) {
  if (!/^[a-z0-9.-]+\.log$/.test(file)) throw new Error('Expected a release log filename')
  selected.set('post-trial-compatibility/validation/' + file, base + '/' + file)
}
const sensitive = [
  /\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})/i,
  /\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{16,}/,
  /"(?:apiKey|api_key|accessToken|access_token|refreshToken|refresh_token|clientSecret|client_secret|credential|authorization)"\s*:\s*"(?!\[redacted\])[^\"]+"/i,
  /-----BEGIN (?:(?:RSA|EC|OPENSSH|DSA) )?PRIVATE KEY-----/,
  /C:\x5c{1,2}Users|AppData.*[\\/]Roaming.*[\\/]whomi|whomi\.db/i,
]
const additions = [...selected].map(([file, source]) => {
  if (!/\.(?:json|log|md|mjs|ts|diff)$/.test(file)) throw new Error('Unexpected extension: ' + file)
  const bytes = fs.readFileSync(source)
  if (sensitive.some(pattern => pattern.test(bytes.toString('utf8')))) throw new Error('Sensitive pattern: ' + file)
  return { source: source.split(path.sep).join('/'), file, bytes: bytes.length, sha256: hash(bytes) }
})
for (const item of additions) {
  const target = root + '/' + item.file, previous = manifest.files.find(file => file.file === item.file)
  if (previous && previous.sha256 !== item.sha256) throw new Error('Existing archive entry differs')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (!fs.existsSync(target)) fs.copyFileSync(item.source, target, fs.constants.COPYFILE_EXCL)
  if (hash(fs.readFileSync(target)) !== item.sha256 || hash(fs.readFileSync(item.source)) !== item.sha256) throw new Error('Post-trial original or copy differs')
  if (!previous) manifest.files.push(item)
}
manifest.postTrialOfflineEvidenceIncluded = true
manifest.postTrial = { manifest: 'post-trial-compatibility/manifest.json', manifestSha256: hash(fs.readFileSync(postRoot + '/manifest.json')), realModelCallsAdded: post.realModelCallsAdded, trialsRecovered: post.trialsRecovered, targetedTestsPassed: post.localVerification.targetedTestsPassed, copiedValidationLogs: manifest.files.filter(file => file.file.startsWith('post-trial-compatibility/validation/')).map(file => file.file) }
manifest.copiedFiles = manifest.files.length
manifest.copiedBytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0)
fs.writeFileSync(root + '/archive-audit.json', JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ copiedFiles: manifest.copiedFiles, copiedBytes: manifest.copiedBytes, sensitivePatternMatches: 0, postTrial: manifest.postTrial }, null, 2))
