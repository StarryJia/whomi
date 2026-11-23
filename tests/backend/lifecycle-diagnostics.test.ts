import { randomUUID } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import { BoundaryError } from '../../src/shared/desktop-validation'
import { createConversationRecorder, recordSetting } from '../../electron/main/lifecycle-diagnostics'

function recorder() {
  return { begin: vi.fn(() => randomUUID()), event: vi.fn(), end: vi.fn() }
}

test('a failed settings save preserves its error and records only its category and public code', async () => {
  const store = recorder(), error = new BoundaryError('INVALID_ARGUMENT', '私人提示词示例')
  await expect(recordSetting(store, 'savePrompt', async () => { throw error })).rejects.toBe(error)
  const id = store.begin.mock.results[0].value
  expect(store.event.mock.calls).toEqual([[id, 'settingsSave', { category: 'prompt' }]])
  expect(store.end.mock.calls).toEqual([[id, 'failed', { code: 'INVALID_ARGUMENT' }]])
  await recordSetting(store, 'openErrorLogDirectory', async () => true)
  expect(store.begin).toHaveBeenCalledTimes(1)
})

test('a reader can report that reading succeeded but displaying the target failed', () => {
  const store = recorder(), tracker = createConversationRecorder(store), id = randomUUID()
  tracker.receive({ kind: 'start', id, action: 'locate' })
  tracker.receive({ kind: 'step', id, stage: 'read', count: 4, text: '私人正文' })
  tracker.receive({ kind: 'step', id, stage: 'display', found: false })
  tracker.receive({ kind: 'end', id, outcome: 'failed' })
  tracker.receive({ kind: 'end', id, outcome: 'success' })
  expect(store.event).toHaveBeenCalledWith(expect.any(String), 'read', expect.objectContaining({ count: 4 }))
  expect(store.event).toHaveBeenCalledWith(expect.any(String), 'display', expect.objectContaining({ found: false }))
  expect(JSON.stringify(store.event.mock.calls)).not.toContain('私人正文')
  expect(store.end).toHaveBeenCalledTimes(1)
  expect(store.end).toHaveBeenCalledWith(store.begin.mock.results[0].value, 'failed', expect.anything())
})
