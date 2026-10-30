import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import { defaultProcessing, type SettingsApi, type SettingsSnapshot } from '../../shared/settings-contract'
import { ModelServices } from './model-services'

const model = { id: 'm1', providerId: 'p1', label: '示例模型', model: 'alpha', baseUrl: 'http://localhost:1234/v1', enabled: true, hasCredential: true, contextWindow: 128000, maxTokens: 16384, version: 1 }
function setup(withModel = true) {
  let data: SettingsSnapshot = { providers: [{ id: 'p1', name: '示例服务', baseUrl: 'http://localhost:1234/v1', enabled: true, hasCredential: true }], models: withModel ? [model] : [], processing: defaultProcessing, selectedModels: {}, debug: false }
  const api = {
    get: async () => structuredClone(data),
    saveProvider: vi.fn(async input => { const { apiKey: _key, ...safe } = input; const saved = { ...safe, id: input.id ?? 'p2', hasCredential: true }; data = { ...data, providers: [...data.providers.filter(p => p.id !== saved.id), saved] }; return saved }),
    removeProvider: vi.fn(async () => {}), stopModelTasks: vi.fn(async () => {}),
    saveModel: vi.fn(async input => { const saved = { ...model, ...input, id: input.id ?? `m-${input.model}` }; data = { ...data, models: [...data.models.filter(m => m.id !== saved.id), saved] }; return saved }),
    removeModel: vi.fn(async id => { data = { ...data, models: data.models.filter(m => m.id !== id) } }),
    syncModels: vi.fn(async () => [{ id: 'alpha', label: '示例模型', contextWindow: 128000, maxTokens: 16384 }, { id: 'beta', label: '目录模型', contextWindow: 200000, maxTokens: 32768 }]),
    testModel: vi.fn(async () => {}),
  } as unknown as SettingsApi
  function Host() { const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(data); return snapshot && <ModelServices api={api} snapshot={snapshot} setSnapshot={setSnapshot} onChanged={() => {}} registerGuard={() => {}} onBusy={() => {}} /> }
  render(<Host />)
  return { api, user: userEvent.setup() }
}
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})

test('服务商右键菜单包含编辑、备注和删除，备注保存后可搜索', async () => {
  const { user, api } = setup()
  fireEvent.contextMenu(screen.getByRole('button', { name: '示例服务' }), { clientX: 40, clientY: 80 })
  const menu = await screen.findByRole('menu')
  expect(within(menu).getByRole('menuitem', { name: '编辑' })).toBeInTheDocument()
  expect(within(menu).getByRole('menuitem', { name: '删除' })).toBeInTheDocument()
  fireEvent.pointerUp(document.body, { button: 2, pointerType: 'mouse' })
  await user.click(within(menu).getByRole('menuitem', { name: '备注' }))
  const dialog = await screen.findByRole('dialog', { name: '备注' })
  await user.type(within(dialog).getByRole('textbox'), '仅用于示例项目')
  await user.click(within(dialog).getByRole('button', { name: '保存' }))
  await waitFor(() => expect(api.saveProvider).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1', notes: '仅用于示例项目' })))
  await user.type(screen.getByRole('textbox', { name: '搜索服务商' }), '示例 项目')
  expect(screen.getByRole('button', { name: '示例服务' })).toBeInTheDocument()
})

test('连接配置失焦自动保存，保存失败保留输入并可重试', async () => {
  const { api, user } = setup()
  vi.mocked(api.saveProvider).mockRejectedValueOnce(new Error('保存失败，请重试。'))
  const address = screen.getByLabelText('接口地址')
  await user.clear(address); await user.type(address, 'http://localhost:5678/v1'); await user.tab()
  expect(await screen.findByRole('alert')).toHaveTextContent('保存失败，请重试。')
  expect(address).toHaveValue('http://localhost:5678/v1')
  await user.click(screen.getByRole('button', { name: '重试保存' }))
  await waitFor(() => expect(api.saveProvider).toHaveBeenLastCalledWith(expect.objectContaining({ baseUrl: 'http://localhost:5678/v1' })))
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  expect(screen.queryByRole('button', { name: '保存服务商' })).not.toBeInTheDocument()
})

test('编辑抽屉的容量预设使用上游精确值并自动保存，关闭保留结果', async () => {
  const { user, api } = setup()
  await user.click(screen.getByRole('button', { name: '编辑示例模型' }))
  const drawer = await screen.findByRole('dialog', { name: '编辑模型' })
  await user.click(within(drawer).getByRole('button', { name: '上下文长度: 256K (262144)' }))
  await waitFor(() => expect(api.saveModel).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1', contextWindow: 262144 })))
  expect(within(drawer).getByLabelText('上下文长度')).toHaveValue(262144)
  expect(within(drawer).getByRole('button', { name: '最大输入长度: 256K (256000)' })).toBeInTheDocument()
  await user.click(within(drawer).getByRole('button', { name: '关闭编辑模型' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('最大输入预设等于上下文时保留独立输出上限，由请求分配剩余预算', async () => {
  const { user, api } = setup()
  await user.click(screen.getByRole('button', { name: '编辑示例模型' }))
  const drawer = await screen.findByRole('dialog', { name: '编辑模型' })
  await user.click(within(drawer).getByRole('button', { name: '最大输入长度: 128K (128000)' }))
  await waitFor(() => expect(api.saveModel).toHaveBeenCalledWith(expect.objectContaining({ contextWindow: 128000, maxInputTokens: 128000, maxTokens: 16384 })))
  expect(within(drawer).queryByRole('alert')).not.toBeInTheDocument()
})

test('同步抽屉直接添加目录模型并保留元数据，再移除时仅改变该服务商', async () => {
  const { api, user } = setup()
  await user.click(screen.getByRole('button', { name: '同步模型' }))
  const drawer = await screen.findByRole('dialog', { name: '示例服务 模型' })
  await user.click(await within(drawer).findByRole('button', { name: '添加目录模型' }))
  await waitFor(() => expect(api.saveModel).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'p1', model: 'beta', label: '目录模型', contextWindow: 200000, maxTokens: 32768 })))
  await user.click(await within(drawer).findByRole('button', { name: '移除目录模型' }))
  await waitFor(() => expect(api.removeModel).toHaveBeenCalledWith('m-beta'))
  expect(within(drawer).getByRole('button', { name: '添加目录模型' })).toBeInTheDocument()
})

test('连接保存排队期间保留新输入，较早回执不会覆盖下一次配置', async () => {
  const { api, user } = setup()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const original = vi.mocked(api.saveProvider).getMockImplementation()!
  vi.mocked(api.saveProvider).mockImplementationOnce(async input => { await gate; return original(input) })
  const address = screen.getByLabelText('接口地址')
  await user.clear(address); await user.type(address, 'http://localhost:1001/v1'); await user.tab()
  await user.clear(address); await user.type(address, 'http://localhost:1002/v1'); await user.tab()
  release()
  await waitFor(() => expect(api.saveProvider).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(screen.getByRole('button', { name: '同步模型' })).toBeEnabled())
  expect(address).toHaveValue('http://localhost:1002/v1')
  expect(vi.mocked(api.saveProvider).mock.lastCall?.[0].baseUrl).toBe('http://localhost:1002/v1')
})

test('模型容量校验失败时保留抽屉和输入，修正后允许关闭', async () => {
  const { api, user } = setup()
  await user.click(screen.getByRole('button', { name: '编辑示例模型' }))
  const drawer = screen.getByRole('dialog', { name: '编辑模型' })
  await user.click(within(drawer).getByRole('button', { name: '最大输出长度: 128K (128000)' }))
  expect(await within(drawer).findByRole('alert')).toHaveTextContent('请将最大输出长度设为小于上下文长度。')
  await user.click(within(drawer).getByRole('button', { name: '关闭编辑模型' }))
  expect(drawer).toBeInTheDocument()
  expect(api.saveModel).not.toHaveBeenCalled()
  await user.click(within(drawer).getByRole('button', { name: '最大输出长度: 32K (32768)' }))
  await waitFor(() => expect(api.saveModel).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 32768 })))
  await user.click(within(drawer).getByRole('button', { name: '关闭编辑模型' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('右键打开菜单时抬起右键不会误触编辑操作', async () => {
  setup()
  fireEvent.contextMenu(screen.getByRole('button', { name: '示例服务' }), { button: 2, clientX: 40, clientY: 80 })
  const menu = await screen.findByRole('menu')
  fireEvent.pointerUp(within(menu).getByRole('menuitem', { name: '编辑' }), { button: 2, pointerType: 'mouse' })
  expect(screen.queryByRole('dialog', { name: '编辑服务商' })).not.toBeInTheDocument()
  expect(menu).toBeInTheDocument()
})

test('手动添加时模型标识自动填写显示名称和分组', async () => {
  const { api, user } = setup(false)
  await user.click(screen.getByRole('button', { name: '手动添加' }))
  const drawer = screen.getByRole('dialog', { name: '手动添加模型' })
  await user.type(within(drawer).getByLabelText('模型标识'), 'example/chat-model')
  expect(within(drawer).getByLabelText('显示名称')).toHaveValue('example/chat-model')
  await user.click(within(drawer).getByRole('button', { name: '添加模型' }))
  await waitFor(() => expect(api.saveModel).toHaveBeenCalledWith(expect.objectContaining({ model: 'example/chat-model', label: 'example/chat-model' })))
})
