import { afterEach, expect, test } from 'vitest'
import { openStore } from '../../electron/data/db/open'
import { createSettingsRepository } from '../../electron/data/settings/repository'
import { temporaryStore } from './helpers'
import type { PromptId } from '../../src/shared/system-prompts'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).reverse().forEach(close => close()))

test('洞察三类提示词独立保存，重启后保留设置', async () => {
  const temp = temporaryStore(), store = openStore(temp.path)
  cleanup.push(() => { store.close(); temp.cleanup() })
  const write = async <T,>(operation: () => T | Promise<T>): Promise<T> => operation()
  const settings = createSettingsRepository(store, write)
  await settings.initialize()
  for (const [id, value] of [
    ['insightReading', '保留日期和未结束事项'],
    ['insightChecking', '核对反例和替代解释'],
    ['insightWriting', '把经历写入关于你和你们的相处'],
  ]) await settings.savePrompt(id as PromptId, value)
  store.close()
  const reopened = openStore(temp.path)
  cleanup.push(() => reopened.close())
  const restored = createSettingsRepository(reopened, write)
  await restored.initialize()
  expect(restored.getPrompts()).toMatchObject({
    insightReading: '保留日期和未结束事项',
    insightChecking: '核对反例和替代解释', insightWriting: '把经历写入关于你和你们的相处',
  })
})
