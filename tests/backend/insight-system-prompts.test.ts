import { afterEach, expect, test } from 'vitest'
import { openStore } from '../../electron/data/db/open'
import { createSettingsRepository } from '../../electron/data/settings/repository'
import { temporaryStore } from './helpers'
import { defaultPrompts, maxPromptLength } from '../../src/shared/system-prompts'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).reverse().forEach(close => close()))

test('迁移过长的旧洞察偏好时保留完整字符，重启后仍能编辑保存', async () => {
  const temp = temporaryStore(), store = openStore(temp.path)
  cleanup.push(() => { store.close(); temp.cleanup() })
  const write = async <T,>(operation: () => T | Promise<T>): Promise<T> => operation()
  const settings = createSettingsRepository(store, write)
  await settings.initialize()
  const reading = '字'.repeat(maxPromptLength - 3)
  store.writer.prepare('INSERT OR REPLACE INTO app_settings(key,data) VALUES(?,?)').run('systemPrompts',
    JSON.stringify({ insightReading: reading, insightChecking: '  ', insightWriting: '🙂保留日期' }))
  store.close()
  const reopened = openStore(temp.path)
  cleanup.push(() => reopened.close())
  const restored = createSettingsRepository(reopened, write)
  await restored.initialize()
  const migrated = restored.getPrompts().insight
  expect(migrated).toBe(reading + '\n\n')
  await expect(restored.savePrompt('insight', migrated)).resolves.toEqual({ ...defaultPrompts, insight: migrated })
})
