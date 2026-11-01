import type { Database } from 'better-sqlite3'
import { defaultPrompts, promptIds, validatePrompt, type PromptValues } from '../../../src/shared/system-prompts'

export function readPromptValues(db: Database): PromptValues {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_settings'").get()) return { ...defaultPrompts }
  const row = db.prepare("SELECT data FROM app_settings WHERE key='systemPrompts'").get() as { data: string } | undefined
  const saved = row ? JSON.parse(row.data) as Partial<PromptValues> : {}
  const result = { ...defaultPrompts }
  for (const id of promptIds) if (Object.hasOwn(saved, id)) { validatePrompt(id, saved[id]); result[id] = saved[id]! }
  return result
}
