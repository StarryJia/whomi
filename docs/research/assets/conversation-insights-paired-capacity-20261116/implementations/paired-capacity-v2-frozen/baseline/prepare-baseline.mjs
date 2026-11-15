import { build } from 'vite'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const output = dirname(fileURLToPath(import.meta.url))
const root = resolve(output, '../../..')
const baseCommit = 'fee2af45380cb379ab40009449f467d1c50c4a8b'
const baseline = resolve(output, 'source')
mkdirSync(baseline, { recursive: true })
const archive = resolve(output, 'source.tar')
writeFileSync(archive, execFileSync('git', ['-c', 'core.autocrlf=false', 'archive', '--format=tar', baseCommit, 'electron/main', 'electron/data/ai', 'src/shared'], { cwd: root, maxBuffer: 8 * 1024 * 1024 }))
execFileSync('tar', ['-xf', archive, '-C', baseline])
const sourceHashes = {}
const sha256 = value => createHash('sha256').update(value).digest('hex')
const repositoryPath = file => relative(root, file).split(sep).join('/')
const entry = resolve(output, 'baseline-entry.ts')
writeFileSync(entry, [
  `export { generateInsight } from ${JSON.stringify(resolve(baseline, 'electron/main/insight-generation.ts').split(sep).join('/'))}`,
  `export { defaultInsightPrompts, buildInsightPrompt } from ${JSON.stringify(resolve(baseline, 'electron/data/ai/insight-prompts.ts').split(sep).join('/'))}`,
].join('\n') + '\n')
const bundled = await build({
  root, configFile: false, logLevel: 'silent',
  plugins: [{ name: 'verify-baseline-commit', enforce: 'pre', transform(_code, id) {
    if (id === entry.split(sep).join('/') || id === entry || id.startsWith('\0')) return
    const file = realpathSync(id)
    const path = relative(baseline, file)
    if (!path || path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) throw new Error('BASELINE_DEPENDENCY_OUTSIDE_ARCHIVE: ' + id)
    const name = path.split(sep).join('/')
    const local = readFileSync(file)
    const committed = execFileSync('git', ['show', baseCommit + ':' + name], { cwd: root, maxBuffer: 8 * 1024 * 1024 })
    if (!local.equals(committed)) throw new Error('BASELINE_SOURCE_CHANGED: ' + name)
    sourceHashes[name] = sha256(local)
  } }],
  build: { ssr: entry, write: false, minify: false, rollupOptions: { output: { format: 'es', codeSplitting: false } } },
})
if (Array.isArray(bundled) || bundled.output.length !== 1 || bundled.output[0].type !== 'chunk') throw new Error('EXPECTED_ONE_BUNDLE')
const bundlePath = resolve(output, 'baseline.mjs')
writeFileSync(bundlePath, bundled.output[0].code)
const manifest = { version: 1, baseCommit, bundlePath: repositoryPath(bundlePath), bundleSha256: sha256(readFileSync(bundlePath)),
  sourceHashes: Object.fromEntries(Object.entries(sourceHashes).sort(([left], [right]) => left.localeCompare(right))) }
writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ manifestPath: repositoryPath(resolve(output, 'manifest.json')), ...manifest }))
