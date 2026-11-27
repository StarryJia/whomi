import type { Database } from 'better-sqlite3'
import { defaultPrompts, maxPromptLength, validatePrompt, type PromptValues } from '../../../src/shared/system-prompts'
import { legacyInsightPromptIds, legacyPrompts, priorInsightDefaults, type LegacyInsightPrompts } from './legacy-prompts'

export type StoredPromptOverrides = Partial<PromptValues & LegacyInsightPrompts>

export function readPromptValues(db: Database): PromptValues {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_settings'").get()) return { ...defaultPrompts }
  const row = db.prepare("SELECT data FROM app_settings WHERE key='systemPrompts'").get() as { data: string } | undefined
  const saved: StoredPromptOverrides = row ? JSON.parse(row.data) : {}
  const result = { ...defaultPrompts }
  if (saved.dialogue !== undefined) {
    validatePrompt('dialogue', saved.dialogue)
    result.dialogue = saved.dialogue
  }
  if (typeof saved.insight === 'string') {
    validatePrompt('insight', saved.insight)
    result.insight = saved.insight
  } else {
    const customized: string[] = []
    for (const id of legacyInsightPromptIds) {
      const text = saved[id]
      if (typeof text === 'string' && text.trim() && text !== priorInsightDefaults[id] && text !== legacyPrompts[id]) customized.push(text)
    }
    if (customized.length) {
      // 截断时保留完整字符，例如占两个编码单元的表情。
      result.insight = customized.join('\n\n').slice(0, maxPromptLength).replace(/[\uD800-\uDBFF]$/, '')
    }
  }
  return result
}
