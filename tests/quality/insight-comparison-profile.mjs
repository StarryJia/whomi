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
