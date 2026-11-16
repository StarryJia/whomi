import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

function invalidProfile() {
  throw Object.assign(new Error('试验配置与已保存轮次不一致，请使用原参数或新的 --run-id。'), { code: 'INVALID_COMPARISON_RUN_PROFILE' })
}

function readProfile(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return invalidProfile() }
}

function materialHash({ scope, messages, excluded }) {
  return createHash('sha256').update(JSON.stringify({ scope, messages, excluded })).digest('hex')
}

/**
 * @param {string} output
 * @param {NonNullable<ReturnType<typeof import('./insight-comparison-profile.mjs').comparisonArguments>['profile']>} profile
 */
export function ensureComparisonRunProfile(output, profile) {
  const frozen = {
    version: 1, experiment: profile.experiment, runId: profile.runId ?? null,
    perTaskLimits: profile.perTaskLimits, totalRequestLimit: profile.requestLimit,
    syntheticPackingInputEstimateLimit: profile.packingLimit, perRequestOutputLimit: profile.outputLimit,
    phases: profile.phases, taskIdStart: profile.taskIdStart,
    materialHashes: Object.fromEntries(Object.entries(profile.cases).map(([name, material]) => [name, materialHash(material)])),
  }
  mkdirSync(output, { recursive: true })
  const file = join(output, 'run-profile.json')
  if (existsSync(file)) {
    if (!isDeepStrictEqual(readProfile(file), frozen)) return invalidProfile()
    return
  }

  // 遗留轮次先核对全部阶段，防止从另一案例悄悄改用新的预算。
  for (const directory of readdirSync(output, { withFileTypes: true }).filter(item => item.isDirectory())) {
    const folder = join(output, directory.name)
    const inputFile = join(folder, 'input.json')
    if (!existsSync(inputFile)) {
      if (readdirSync(folder).some(name => /^(?:attempts\.jsonl|checkpoint\.json|result\.json|snapshot\.json|report\.json|request-\d+\.json)$/.test(name))) return invalidProfile()
      continue
    }
    const input = readProfile(inputFile)
    const single = ['direct', 'direct-rich', 'full'].includes(input.variant)
    const limits = { ...profile.perTaskLimits, ...(single ? { maxCalls: 1, maxOutputTokens: profile.outputLimit } : {}) }
    const packing = input.variant === 'full' ? undefined : Math.min(profile.packingLimit, input.configuredCapacity?.maxInputTokens ?? Infinity)
    if (!Object.hasOwn(profile.cases, input.caseName) || !profile.phases.includes(input.variant)
      || input.experiment !== frozen.experiment || (input.runId ?? null) !== frozen.runId
      || !isDeepStrictEqual(input.limits, limits) || input.totalRequestLimit !== frozen.totalRequestLimit
      || input.syntheticPackingInputEstimateLimit !== packing || input.perRequestOutputLimit !== frozen.perRequestOutputLimit
      || materialHash(input) !== frozen.materialHashes[input.caseName]) return invalidProfile()
  }

  try { writeFileSync(file, JSON.stringify(frozen, null, 2) + '\n', { flag: 'wx' }) }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error
    if (!isDeepStrictEqual(readProfile(file), frozen)) return invalidProfile()
  }
}
