import { comparisonOutputLimit, comparisonPackingLimit, comparisonPhases, insightComparisonCases, trialRequestLimit } from './insight-comparison-material.mjs'
import { insightLongComparisonCases } from './insight-long-comparison-material.mjs'

export const shortComparisonLimits = {
  maxChecks: 2, maxRoundsPerCheck: 4, maxCalls: 8, maxInputTokens: 120_000, maxOutputTokens: 12_000, maxElapsedMs: 300_000,
}

export function comparisonProfile(option) {
  if (option === '--comparison') {
    return {
      outputDirectory: 'comparison', runtimeDirectory: '.comparison-runtime', experiment: 'candidate-comparison',
      cases: insightComparisonCases, phases: comparisonPhases, requestLimit: trialRequestLimit,
      perTaskLimits: shortComparisonLimits, packingLimit: comparisonPackingLimit, outputLimit: comparisonOutputLimit,
      taskIdStart: 101,
    }
  }
  if (option === '--long-comparison') {
    return {
      outputDirectory: 'long-comparison', runtimeDirectory: '.long-comparison-runtime', experiment: 'long-candidate-comparison',
      cases: insightLongComparisonCases, phases: ['reading', 'adaptive', 'direct', 'direct-rich'], requestLimit: 64,
      perTaskLimits: { maxChecks: 8, maxRoundsPerCheck: 4, maxCalls: 28, maxInputTokens: 400_000, maxOutputTokens: 40_000, maxElapsedMs: 1_200_000 },
      packingLimit: comparisonPackingLimit, outputLimit: comparisonOutputLimit, taskIdStart: 201,
    }
  }
}

/** @param {string[]} input */
export function comparisonArguments(input) {
  const profile = comparisonProfile(input[0])
  const runOptions = input.filter(argument => argument.startsWith('--run-id'))
  const callOptions = input.filter(argument => argument.startsWith('--task-call-limit'))
  let taskCallLimit
  if (callOptions.length) {
    const limit = callOptions[0].match(/^--task-call-limit=([1-9]\d*)$/)
    if (input[0] !== '--long-comparison' || runOptions.length !== 1 || callOptions.length !== 1
      || input.at(-2) !== callOptions[0] || input.at(-1) !== runOptions[0] || !limit || Number(limit[1]) > 50) {
      throw Object.assign(new Error('请在长试验的 --run-id 前填写一次 --task-call-limit，取值为 1 至 50。'), { code: 'INVALID_COMPARISON_TASK_CALL_LIMIT' })
    }
    taskCallLimit = Number(limit[1])
  }
  if (!runOptions.length) return { args: input, profile: profile && { ...profile, runId: undefined } }
  const match = runOptions[0].match(/^--run-id=([a-z][a-z0-9-]{0,47})$/)
  if (input[0] !== '--long-comparison' || !profile || runOptions.length !== 1 || input.at(-1) !== runOptions[0] || !match) {
    throw Object.assign(new Error('请在长试验命令末尾填写一次 --run-id，名称使用小写字母开头的 1 至 48 个字母、数字或连字符。'), { code: 'INVALID_COMPARISON_RUN_ID' })
  }
  const runId = match[1]
  return {
    args: input.slice(0, taskCallLimit === undefined ? -1 : -2),
    profile: {
      ...profile, runId,
      ...(taskCallLimit === undefined ? {} : {
        perTaskLimits: { ...profile.perTaskLimits, maxCalls: taskCallLimit },
        requestLimit: Math.max(profile.requestLimit, Object.keys(profile.cases).length * (taskCallLimit + 2)),
      }),
      outputDirectory: 'long-comparison-runs/' + runId, runtimeDirectory: '.' + runId + '-runtime',
    },
  }
}

/** @param {string | undefined} option */
export function readingResumeOrdinal(option) {
  if (!option?.startsWith('--resume-reading')) return 0
  if (option === '--resume-reading' || option === '--resume-reading=1') return 1
  if (option === '--resume-reading=2') return 2
  throw Object.assign(new Error('请使用 --resume-reading 或 --resume-reading=2 恢复对应的阅读阶段。'), { code: 'INVALID_COMPARISON_READING_RESUME' })
}
