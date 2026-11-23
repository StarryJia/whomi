import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { release } from 'node:os'

const require = createRequire(import.meta.url)
const started = new Date()
const directory = resolve('artifacts', 'issue-35', started.toISOString().replace(/[:.]/g, '-'))
mkdirSync(directory, { recursive: true })
const targets = process.argv.slice(2)
const args = [require.resolve('@playwright/test/cli'), 'test', ...(targets.length ? targets : ['tests/desktop/pi-insights.spec.mjs']),
  '--workers=1', '--reporter=list,json', '--timeout=60000', '--trace=retain-on-failure', '--output=' + join(directory, 'results')]
const env = { ...process.env, DEBUG: 'pw:browser*', ELECTRON_ENABLE_LOGGING: '1', ELECTRON_ENABLE_STACK_DUMPING: '1',
  PLAYWRIGHT_JSON_OUTPUT_FILE: join(directory, 'report.json') }
delete env.NO_COLOR
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trimEnd()
const hash = path => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null
const bundlePaths = ['out/main/index.cjs', 'out/main/data/entry.cjs', 'out/main/agent/entry.cjs', 'out/preload/index.cjs', 'out/renderer/index.html']
const sources = [...new Set([...git('diff', '--name-only', '-z', 'HEAD').split('\0'), ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0')])].filter(Boolean)
const info = { started: started.toISOString(), finished: null, exitCode: null, signal: null, branch: git('branch', '--show-current'), commit: git('rev-parse', 'HEAD'),
  changedSources: Object.fromEntries(sources.map(p => [p, hash(p)])), bundles: Object.fromEntries(bundlePaths.map(p => [p, hash(p)])),
  cwd: process.cwd(), os: process.platform + ' ' + release(), node: process.version, electron: require('electron/package.json').version,
  command: [process.execPath, ...args], debug: env.DEBUG }
const metadata = () => writeFileSync(join(directory, 'run.json'), JSON.stringify(info, null, 2))
metadata()
console.log(relative(process.cwd(), directory))
const stdout = openSync(join(directory, 'stdout.log'), 'w')
const stderr = openSync(join(directory, 'stderr.log'), 'w')
try {
  const result = spawnSync(process.execPath, args, { env, stdio: ['ignore', stdout, stderr], windowsHide: true })
  info.exitCode = result.status
  info.signal = result.signal
  if (result.error) info.error = String(result.error)
} finally {
  closeSync(stdout)
  closeSync(stderr)
  info.finished = new Date().toISOString()
  metadata()
}
console.log(readFileSync(join(directory, 'stdout.log'), 'utf8').split('\n').slice(-12).join('\n'))
process.exitCode = info.exitCode ?? 1
