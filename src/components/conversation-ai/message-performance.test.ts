import { expect, test } from 'vitest'
import { messagePerformance } from './message-performance'

test('missing first output timing leaves model generation speed unknown', () => {
  const result = messagePerformance({ outputTokens: 100, durationMs: 10000 })
  expect(result.modelTokensPerSecond).toBeUndefined()
  expect(result.endToEndTokensPerSecond).toBe(10)
})

test('generation time excludes the first output wait without producing infinite rates', () => {
  expect(messagePerformance({ outputTokens: 100, durationMs: 10000, firstTokenMs: 9000 }).modelTokensPerSecond).toBe(100)
  expect(messagePerformance({ outputTokens: 100, durationMs: 10000, firstTokenMs: 10000 }).modelTokensPerSecond).toBeUndefined()
})
