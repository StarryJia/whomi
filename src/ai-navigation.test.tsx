import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import App from './App'
import { createPreviewClient } from './data/preview-client'
import { fakeImportApi } from './test/import-api'
import type { AiApi } from './shared/ai-contract'

test('正式会话从桌面后台读取可用模型，保留开发适配器独立性', async () => {
  const query = window.matchMedia('')
  vi.spyOn(window, 'matchMedia').mockImplementation(media => ({ ...query, media, matches: media === '(prefers-reduced-motion: reduce)' }))
  const client = createPreviewClient([{ id: '1', title: '已保存会话', messages: [{ id: '1', sender: '成员', text: '已保存的原文' }] }])
  const ai = { listModels: async () => [{ id: 'configured', label: '已配置模型', enabled: true }], listSkills: async () => [], openThread: async () => ({ id: '1', conversationId: '1', turns: [] }), getThread: async () => ({ id: '1', conversationId: '1', turns: [] }), listAnalyses: async () => [], onEvent: () => () => {} } as unknown as AiApi
  render(<App client={client} importApi={{ ...fakeImportApi().api, ai }} />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '展开会话列表' }))
  await user.click(await screen.findByRole('button', { name: '已保存会话' }))
  const model = await screen.findByRole('combobox', { name: '对话模型' })
  expect(model).toHaveTextContent('已配置模型')
  await user.click(model)
  await user.click(screen.getByRole('option', { name: '已配置模型' }))
  await user.type(screen.getByRole('textbox'), '我的问题')
  expect(screen.getByRole('button', { name: '发送给 AI' })).toBeEnabled()
})
