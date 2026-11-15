import { build } from 'vite'
import electron from 'electron'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { comparisonOutputLimit, comparisonPackingLimit, comparisonPhases, insightComparisonCases, trialRequestLimit } from '../tests/quality/insight-comparison-material.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const verification = args[0] === '--verification'
const comparison = args[0] === '--comparison'
const output = join(root, 'release', 'conversation-insights-20261115', comparison ? 'comparison' : verification ? 'verification' : 'quality')
const runtime = join(dirname(output), comparison ? '.comparison-runtime' : '.quality-runtime')
const validCases = ['later-counterexample', 'distant-reply']
const validVariants = ['baseline', 'insight']
const verificationVariants = ['probe-original', 'probe-current', 'flow-original', 'flow-current']
const dryRun = args.length === 1 && args[0] === '--dry-run' || verification && args.length === 2 && args[1] === '--dry-run'
const verificationRun = verification && (args.length === 3 || args.length === 4 && args[2]?.startsWith('probe-') && /^--run=[12]$/.test(args[3]))
  && /^[a-z][a-z0-9-]{0,60}$/.test(args[1]) && verificationVariants.includes(args[2])
const regression = args.length === 3 && args[0] === 'distant-reply' && args[1] === 'insight' && ['--regression', '--writing-regression'].includes(args[2])
const comparisonDryRun = comparison && args.length === 2 && args[1] === '--dry-run'
const comparisonRun = comparison && args.length === 3 && Object.hasOwn(insightComparisonCases, args[1]) && comparisonPhases.includes(args[2])
if (!dryRun && !verificationRun && !comparisonDryRun && !comparisonRun && !regression
  && (args.length !== 2 || !validCases.includes(args[0]) || !validVariants.includes(args[1]))) {
  throw new Error('Usage: node scripts/insight-quality.mjs --dry-run | <later-counterexample|distant-reply> <baseline|insight> | distant-reply insight [--regression|--writing-regression] | --verification <case> <probe-original|probe-current|flow-original|flow-current> [--run=1|--run=2] | --verification --dry-run | --comparison <shared-planning|conditional-permission> <reading|adaptive|direct|full> | --comparison --dry-run')
}
if (comparisonDryRun) {
  console.log(JSON.stringify({
    state: 'planned', modelCalls: 0, phases: comparisonPhases, totalRequestLimit: trialRequestLimit,
    syntheticPackingInputEstimateLimit: comparisonPackingLimit, perRequestOutputLimit: comparisonOutputLimit,
    cases: Object.entries(insightComparisonCases).map(([caseName, sample]) => ({
      caseName, messageCount: sample.messages.length, scope: sample.scope, messageIds: sample.messages.map(message => message.id),
    })),
  }))
  process.exit(0)
}
if (!process.env.WHOMI_QUALITY_DB || !process.env.WHOMI_QUALITY_PROVIDER_ID || !process.env.WHOMI_QUALITY_MODEL_ID) {
  throw new Error('Set WHOMI_QUALITY_DB, WHOMI_QUALITY_PROVIDER_ID and WHOMI_QUALITY_MODEL_ID to the approved configuration.')
}
await stat(process.env.WHOMI_QUALITY_DB)
await mkdir(runtime, { recursive: true })
await build({
  configFile: false,
  root,
  logLevel: 'error',
  build: {
    ssr: join(root, 'tests', 'quality', 'insight-quality.ts'),
    outDir: runtime,
    emptyOutDir: false,
    minify: false,
    rollupOptions: { external: ['electron', 'better-sqlite3'], output: { format: 'es', entryFileNames: 'insight-quality.mjs' } },
  },
})
const scratch = resolve(await mkdtemp(join(tmpdir(), 'whomi-insight-quality-')))
try {
  if (process.platform !== 'win32') throw new Error('This trial uses the approved Windows app credential.')
  const localState = JSON.parse(await readFile(join(dirname(resolve(process.env.WHOMI_QUALITY_DB)), 'Local State'), 'utf8'))
  const encryptedKey = localState.os_crypt?.encrypted_key
  if (typeof encryptedKey !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encryptedKey)) {
    throw new Error('The Windows application encryption metadata is unavailable.')
  }
  // Initialize the isolated profile with the existing Windows-wrapped key only.
  await writeFile(join(scratch, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: encryptedKey } }), { flag: 'wx' })
  const env = { ...process.env, WHOMI_QUALITY_OUTPUT: output, WHOMI_QUALITY_SCRATCH: scratch }
  delete env.ELECTRON_RUN_AS_NODE
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(runtime, 'insight-quality.mjs'), ...args], { cwd: root, env, stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
  process.exitCode = code
} finally {
  if (dirname(scratch) === resolve(tmpdir())) await rm(scratch, { recursive: true, force: true })
}
