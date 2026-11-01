export const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = typeof thinkingLevels[number]
export function isThinkingLevel(value: unknown): value is ThinkingLevel { return thinkingLevels.includes(value as ThinkingLevel) }
