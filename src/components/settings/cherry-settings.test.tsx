import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import { defaultProcessing, type Provider, type SettingsApi, type SettingsModel, type SettingsSnapshot } from '../../shared/settings-contract'
import { ModelServices } from './model-services'

const model = { id: 'm1', providerId: 'p1', label: '示例模型', model: 'alpha', baseUrl: 'http://localhost:1234/v1', enabled: true, hasCredential: true, contextWindow: 128000, maxTokens: 16384, version: 1 }
const legacyProvider = (id: string, name: string, baseUrl = 'https://example.invalid'): Provider =>
  ({ id: 'cherry:' + id, name, baseUrl, enabled: false, hasCredential: false })
const grokAccount = legacyProvider('grok-cli', 'Grok CLI')
const copilotAccount = legacyProvider('copilot', 'GitHub Copilot')
function setup(withModel: boolean | SettingsModel = true, accountApi: Partial<SettingsApi> = {}, storedProviders: Provider[] = []) {
  let data: SettingsSnapshot = { providers: [{ id: 'p1', name: '示例服务', baseUrl: 'http://localhost:1234/v1', enabled: true, hasCredential: true }, ...storedProviders], models: withModel ? [withModel === true ? model : withModel] : [], processing: defaultProcessing, selectedModels: {}, debug: false }
  const api = {
    get: async () => structuredClone(data),
    getCodexQuota: async () => ({ state: 'disconnected' }),
    getAccountUsage: async () => ({requests:0,inputTokens:null,outputTokens:null,partial:false}),
    saveProvider: vi.fn(async input => { const { apiKey: _key, ...safe } = input; const saved = { ...safe, id: input.id ?? 'p2', hasCredential: true }; data = { ...data, providers: [...data.providers.filter(p => p.id !== saved.id), saved] }; return saved }),
    removeProvider: vi.fn(async () => {}), stopModelTasks: vi.fn(async () => {}),
    saveModel: vi.fn(async input => { const saved = { ...model, ...data.models.find(m => m.id === input.id), ...input, id: input.id ?? `m-${input.model}` }; data = { ...data, models: [...data.models.filter(m => m.id !== saved.id), saved] }; return saved }),
    removeModel: vi.fn(async id => { data = { ...data, models: data.models.filter(m => m.id !== id) } }),
    syncModels: vi.fn(async () => [{ id: 'alpha', label: '示例模型', contextWindow: 128000, maxTokens: 16384 }, { id: 'beta', label: '目录模型', contextWindow: 200000, maxTokens: 32768 }]),
    testModel: vi.fn(async () => {}), ...accountApi,
  } as unknown as SettingsApi
  function Host() { const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(data); return snapshot && <ModelServices api={api} snapshot={snapshot} setSnapshot={setSnapshot} onChanged={() => {}} registerGuard={() => {}} onBusy={() => {}} /> }
  render(<Host />)
  function delayCatalog(synced: SettingsModel) {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.mocked(api.syncModels).mockImplementationOnce(async () => {
      await gate
      data = { ...data, models: data.models.map(model => model.id === synced.id ? synced : model) }
      return [{ id: synced.model, contextWindow: synced.contextWindow ?? undefined, maxInputTokens: synced.maxInputTokens ?? undefined }]
    })
    return () => act(async () => { release() })
  }
  return { api, user: userEvent.setup(), delayCatalog }
}
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})

test('切换 New API 协议时更新预置路径，保留用户修改的服务器地址', async () => {
  const { user, api } = setup(true, {}, [legacyProvider('new-api', 'New API', 'http://localhost:3000/v1')])
  await user.click(screen.getByRole('button', { name: 'New API更多操作' }))
  await user.click(screen.getByRole('menuitem', { name: '编辑' }))
  const form = within(screen.getByRole('dialog'))
  const address = form.getByLabelText('接口地址')
  expect(address).toHaveValue('http://localhost:3000/v1')
  await user.click(form.getByLabelText('连接协议'))
  await user.click(await screen.findByRole('option', { name: 'Google Generate Content' }))
  expect(address).toHaveValue('http://localhost:3000/v1beta')
  fireEvent.change(address, { target: { value: 'http://localhost:9112/custom' } })
  await user.click(form.getByLabelText('连接协议'))
  await user.click(await screen.findByRole('option', { name: 'OpenAI Responses' }))
  expect(address).toHaveValue('http://localhost:9112/custom')
  expect(api.saveProvider).not.toHaveBeenCalled()
})

test('按英文标识搜索可配置预置，已移出的专用认证平台不出现在目录', async () => {
  const { user, api } = setup()
  const search = screen.getByRole('textbox', { name: '搜索服务商' })
  await user.type(search, 'aws-bedrock')
  expect(screen.getByText('未找到服务商')).toBeVisible()
  await user.clear(search)
  await user.type(search, 'zhipu')
  await user.click(screen.getByRole('button', { name: '智谱开放平台' }))
  const details = screen.getByRole('region', { name: '预置服务商详情' })
  expect(within(details).getByRole('button', { name: '配置服务商' })).toBeVisible()
  expect(api.saveProvider).not.toHaveBeenCalled()
  expect(api.syncModels).not.toHaveBeenCalled()
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

test('详情切换协议立即保存，清除旧连接检测并用新配置重新读取目录', async () => {
  const { api, user } = setup()
  await user.click(screen.getByRole('button', { name: '检测示例模型' }))
  await screen.findByText('连接成功')
  await user.click(screen.getByRole('combobox', { name: '连接协议' }))
  await user.click(screen.getByRole('option', { name: 'OpenAI Responses' }))
  await waitFor(() => expect(api.saveProvider).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1', protocol: 'openai-responses' })))
  await waitFor(() => expect(screen.queryByText('连接成功')).not.toBeInTheDocument())
  expect(screen.getByRole('combobox', { name: '连接协议' })).toHaveTextContent('OpenAI Responses')
  await user.click(screen.getByRole('button', { name: '添加模型' }))
  await waitFor(() => expect(api.syncModels).toHaveBeenCalledWith('p1'))
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
  await waitFor(() => expect(api.saveModel).toHaveBeenCalledWith(expect.objectContaining({ maxInputTokens: 128000 })))
  expect((await api.get()).models[0]).toMatchObject({ contextWindow: 128000, maxInputTokens: 128000, maxTokens: 16384 })
  expect(within(drawer).queryByRole('alert')).not.toBeInTheDocument()
})

test('同步后在同一设置页改名，重新打开仍显示目录补齐的上下文长度', async () => {
  const { user, api } = setup({ ...model, contextWindow: null })
  vi.mocked(api.syncModels).mockImplementationOnce(async () => {
    await api.saveModel({ ...model, contextWindow: 128000 })
    return [{ id: model.model, contextWindow: 128000 }]
  })
  await user.click(screen.getByRole('button', { name: '同步模型' }))
  const picker = within(screen.getByRole('dialog'))
  await picker.findByRole('button', { name: /移除/ })
  await user.click(picker.getByRole('button', { name: '取消' }))
  await user.click(screen.getByRole('button', { name: '编辑示例模型' }))
  const editor = within(screen.getByRole('dialog'))
  expect(editor.getByLabelText('上下文长度')).toHaveValue(128000)
  const label = editor.getByLabelText('显示名称')
  await user.clear(label)
  await user.type(label, '改名示例')
  await user.click(editor.getByRole('button', { name: '关闭编辑模型' }))
  await user.click(await screen.findByRole('button', { name: '编辑改名示例' }))
  expect(within(screen.getByRole('dialog')).getByLabelText('上下文长度')).toHaveValue(128000)
})

test('迟到的目录补全打开中的容量，保留手动输入，空字段失焦不提交清空', async () => {
  const { api, user, delayCatalog } = setup({ ...model, contextWindow: null })
  const finish = delayCatalog({ ...model, maxInputTokens: 100000, version: 2 })
  await user.click(screen.getByRole('button', { name: '同步模型' }))
  await user.click(screen.getByRole('button', { name: '取消' }))
  await user.click(screen.getByRole('button', { name: '编辑示例模型' }))
  const editor = within(screen.getByRole('dialog'))
  const input = editor.getByLabelText('最大输入长度')
  await user.click(input)
  await user.tab()
  expect(api.saveModel).not.toHaveBeenCalled()
  fireEvent.change(editor.getByLabelText('最大输出长度'), { target: { value: '3000' } })
  await finish()
  expect(input).toHaveValue(100000)
  expect(editor.getByLabelText('上下文长度')).toHaveValue(128000)
  expect(editor.getByLabelText('最大输出长度')).toHaveValue(3000)
  await user.click(input)
  await user.tab()
  await user.click(editor.getByRole('button', { name: '关闭编辑模型' }))
  const writes = vi.mocked(api.saveModel).mock.calls
  expect(writes.at(-1)?.[0]).toMatchObject({ maxTokens: 3000 })
  expect(writes.at(-1)?.[0]).not.toHaveProperty('maxInputTokens')
  expect((await api.get()).models[0]).toMatchObject({ contextWindow: 128000, maxInputTokens: 100000, maxTokens: 3000 })
})

test('迟到的改名回执不能覆盖目录随后保存的容量', async () => {
  const { api, user, delayCatalog } = setup({ ...model, contextWindow: null })
  let completeSave!: (saved: SettingsModel) => void
  const save = new Promise<SettingsModel>(resolve => { completeSave = resolve })
  vi.mocked(api.saveModel).mockReturnValueOnce(save)
  const renamed = { ...model, label: '改名', contextWindow: null, version: 2 }
  const finish = delayCatalog({ ...renamed, contextWindow: 128000, maxInputTokens: 100000, version: 3 })
  await user.click(screen.getByRole('button', { name: '同步模型' }))
  await user.click(screen.getByRole('button', { name: '取消' }))
  await user.click(screen.getByRole('button', { name: '编辑示例模型' }))
  const editor = within(screen.getByRole('dialog'))
  fireEvent.change(editor.getByLabelText('显示名称'), { target: { value: '改名' } })
  fireEvent.blur(editor.getByLabelText('显示名称'))
  await finish()
  await act(async () => { completeSave(renamed) })
  expect(editor.getByLabelText('上下文长度')).toHaveValue(128000)
  await user.click(editor.getByRole('button', { name: '关闭编辑模型' }))
  await user.click(screen.getByRole('button', { name: '编辑改名' }))
  expect(screen.getByLabelText('最大输入长度')).toHaveValue(100000)
})

test('清空容量保存后，仍在编辑的名称不遮盖下一次目录补全', async () => {
  const { api, user, delayCatalog } = setup()
  let confirmClear!: (saved: SettingsModel) => void
  vi.mocked(api.saveModel).mockReturnValueOnce(new Promise(resolve => { confirmClear = resolve }))
  const finish = delayCatalog({ ...model, contextWindow: 200000, version: 3 })
  await user.click(screen.getByRole('button', { name: '同步模型' }))
  await user.click(screen.getByRole('button', { name: '取消' }))
  await user.click(screen.getByRole('button', { name: '编辑示例模型' }))
  const editor = within(screen.getByRole('dialog'))
  const context = editor.getByLabelText('上下文长度')
  await user.clear(context)
  await user.click(editor.getByLabelText('显示名称'))
  expect(vi.mocked(api.saveModel).mock.calls[0][0].contextWindow).toBeNull()
  fireEvent.change(editor.getByLabelText('显示名称'), { target: { value: '新名称' } })
  await act(async () => { confirmClear({ ...model, contextWindow: null, version: 2 }) })
  await finish()
  expect(context).toHaveValue(200000)
  expect(editor.getByLabelText('显示名称')).toHaveValue('新名称')
  await user.click(editor.getByRole('button', { name: '关闭编辑模型' }))
  expect(vi.mocked(api.saveModel).mock.calls.at(-1)?.[0]).not.toHaveProperty('contextWindow')
})

test('切到其他服务商后仍能刷新原服务商容量并保留列表顺序', async () => {
  const { user, delayCatalog } = setup({ ...model, contextWindow: null }, {}, [
    { id: 'p2', name: '第二服务商', baseUrl: model.baseUrl, enabled: true, hasCredential: true },
  ])
  const list = within(screen.getByLabelText('服务商列表'))
  const providerOrder = () => list.getAllByRole('button', { name: /^(示例服务|第二服务商)$/ }).map(row => row.getAttribute('aria-label'))
  const finish = delayCatalog({ ...model, maxInputTokens: 100000, version: 2 })
  await user.click(screen.getByRole('button', { name: '同步模型' }))
  await user.click(screen.getByRole('button', { name: '取消' }))
  await user.click(list.getByRole('button', { name: '第二服务商' }))
  await finish()
  await user.click(list.getByRole('button', { name: '示例服务' }))
  await user.click(screen.getByRole('button', { name: '编辑示例模型' }))
  expect(screen.getByLabelText('上下文长度')).toHaveValue(128000)
  await user.click(screen.getByRole('button', { name: '关闭编辑模型' }))
  await user.click(screen.getByRole('button', { name: '同步模型' }))
  await within(screen.getByRole('dialog')).findByRole('button', { name: /移除/ })
  await user.click(screen.getByRole('button', { name: '取消' }))
  expect(providerOrder()).toEqual(['示例服务', '第二服务商'])
})

test('目录勾选后确认添加并保留元数据，常驻加号可再次进入目录', async () => {
  const { api, user } = setup()
  const opener = screen.getByRole('button', { name: '添加模型' })
  await user.click(opener)
  const drawer = await screen.findByRole('dialog', { name: '示例服务 模型' })
  await user.click(await within(drawer).findByRole('checkbox', { name: '选择目录模型' }))
  expect(api.saveModel).not.toHaveBeenCalled()
  await user.click(within(drawer).getByRole('button', { name: '添加 1 项' }))
  await waitFor(() => expect(api.saveModel).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'p1', model: 'beta', label: '目录模型', contextWindow: 200000, maxTokens: 32768 })))
  await waitFor(() => expect(drawer).not.toBeInTheDocument())
  expect(opener).toHaveFocus()
  await user.click(opener)
  const reopened = screen.getByRole('dialog', { name: '示例服务 模型' })
  await user.click(await within(reopened).findByRole('button', { name: '移除目录模型' }))
  await waitFor(() => expect(api.removeModel).toHaveBeenCalledWith('m-beta'))
  expect(within(reopened).getByRole('checkbox', { name: '选择目录模型' })).not.toBeChecked()
})

test('全选只暂存未添加模型，逐项取消后退出不会保存，重新打开清空选择', async () => {
  const { api, user } = setup(false)
  const opener = screen.getByRole('button', { name: '同步模型' })
  await user.click(opener)
  const drawer = screen.getByRole('dialog', { name: '示例服务 模型' })
  await within(drawer).findByRole('checkbox', { name: '选择目录模型' })
  await user.click(within(drawer).getByRole('button', { name: '全选' }))
  expect(within(drawer).getByRole('checkbox', { name: '选择示例模型' })).toBeChecked()
  expect(within(drawer).getByRole('checkbox', { name: '选择目录模型' })).toBeChecked()
  expect(api.saveModel).not.toHaveBeenCalled()
  expect(api.removeModel).not.toHaveBeenCalled()
  await user.click(within(drawer).getByRole('checkbox', { name: '选择目录模型' }))
  expect(within(drawer).getByRole('button', { name: '添加 1 项' })).toBeEnabled()
  await user.click(within(drawer).getByRole('button', { name: '取消' }))
  expect(api.saveModel).not.toHaveBeenCalled()
  expect(opener).toHaveFocus()
  await user.click(opener)
  const reopened = screen.getByRole('dialog', { name: '示例服务 模型' })
  expect(await within(reopened).findByRole('checkbox', { name: '选择示例模型' })).not.toBeChecked()
  expect(within(reopened).getByRole('checkbox', { name: '选择目录模型' })).not.toBeChecked()
  expect(within(reopened).getByRole('button', { name: '添加' })).toBeDisabled()
})

test('已有模型不参与全选，确认只添加仍勾选的模型', async () => {
  const { api, user } = setup()
  vi.mocked(api.syncModels).mockResolvedValue([{ id: 'alpha', label: '示例模型' }, { id: 'beta' }, { id: 'gamma' }])
  await user.click(screen.getByRole('button', { name: '同步模型' }))
  const drawer = screen.getByRole('dialog', { name: '示例服务 模型' })
  await within(drawer).findByRole('checkbox', { name: '选择beta' })
  await user.click(within(drawer).getByRole('button', { name: '全选' }))
  expect(within(drawer).getAllByRole('checkbox')).toHaveLength(2)
  await user.click(within(drawer).getByRole('checkbox', { name: '选择gamma' }))
  expect(api.saveModel).not.toHaveBeenCalled()
  await user.click(within(drawer).getByRole('button', { name: '添加 1 项' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(vi.mocked(api.saveModel).mock.calls.map(([input]) => input.model)).toEqual(['beta'])
  expect(api.removeModel).not.toHaveBeenCalled()
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


test('Codex 使用账户卡等待浏览器授权，可取消并返回登录起点', async () => {
  const signInAccount = vi.fn(() => new Promise<never>(() => {}))
  const cancelAccountSignIn = vi.fn(async () => {})
  const { user } = setup(false, { getAccountStatus: async () => ({ state: 'disconnected' }), signInAccount, cancelAccountSignIn })
  await user.click(screen.getByRole('button', { name: 'OpenAI Codex' }))
  const signIn = await screen.findByRole('button', { name: '使用 ChatGPT 登录' })
  await user.hover(screen.getByRole('button', { name: 'ChatGPT 登录说明' }))
  expect(await screen.findByRole('tooltip')).toHaveTextContent('将在浏览器中完成授权')
  expect(screen.getByText('登录后可同步账户模型。')).toBeVisible()
  expect(screen.queryByLabelText('接口地址')).toBeNull()
  expect(screen.getByRole('button', { name: '同步模型' })).toBeDisabled()
  await user.click(signIn)
  expect(signInAccount).toHaveBeenCalledWith('openai-codex', false)
  expect(screen.getByText('授权完成后可同步模型。')).toBeVisible()
  await user.click(screen.getByRole('button', { name: '取消登录' }))
  expect(cancelAccountSignIn).toHaveBeenCalledWith('openai-codex')
  expect(await screen.findByRole('button', { name: '使用 ChatGPT 登录' })).toBeEnabled()
})

test('Grok 展示主进程的恢复操作并支持换一个账号登录', async () => {
  const signInAccount = vi.fn().mockRejectedValue({ code: 'CLIENT_REQUIRED', action: '配置 Grok 客户端标识后重试。' })
  const signOutAccount = vi.fn(async () => { connected = false })
  let connected = true
  const { user } = setup(false, { getAccountStatus: async () => connected ? { state: 'connected', email: '合成账户' } : { state: 'disconnected' }, signInAccount, signOutAccount }, [grokAccount])
  await user.click(screen.getByRole('button', { name: 'Grok CLI' }))
  expect(await screen.findByText('合成账户')).toBeVisible()
  expect(screen.queryByRole('link', { name: '在 ChatGPT 查看套餐用量' })).toBeNull()
  await user.click(screen.getByRole('button', { name: '退出登录' }))
  await user.click(screen.getByRole('button', { name: '确认退出' }))
  await user.click(await screen.findByRole('button', { name: '使用其他账号登录' }))
  expect(signInAccount).toHaveBeenCalledWith('grok-cli', true)
  expect(await screen.findByRole('alert')).toHaveTextContent('配置 Grok 客户端标识后重试。')
})

test.each([
  ['https://github.com/login/device',true],
  ['https://github.com.invalid/login/device',false],
])('Copilot 授权期间展示设备码，只打开可信的 GitHub 验证地址 %s', async (verificationUrl, valid) => {
  const { user } = setup(false, { getAccountStatus: async () => ({ state: 'pending', userCode: 'ABCD-EFGH', verificationUrl }), cancelAccountSignIn: async () => {} }, [copilotAccount])
  await user.click(screen.getByRole('button', { name: 'GitHub Copilot' }))
  expect(await screen.findByText('ABCD-EFGH')).toBeVisible()
  const link = screen.queryByRole('link', { name: '打开 GitHub 验证页面' })
  if (valid) expect(link).toHaveAttribute('href', verificationUrl)
  else expect(link).toBeNull()
  expect(screen.queryByRole('button', { name: '同步模型' })).toBeDisabled()
})

test('迟到的 Grok 登录结果不会改动当前选中的 Copilot', async () => {
  let complete!: (value: { state: 'connected'; email: string }) => void
  const signInAccount = vi.fn(() => new Promise<{ state: 'connected'; email: string }>(resolve => { complete = resolve }))
  const { user } = setup(false, { getAccountStatus: async () => ({ state: 'disconnected' }), signInAccount, cancelAccountSignIn: async () => {} }, [grokAccount, copilotAccount])
  await user.click(screen.getByRole('button', { name: 'Grok CLI' }))
  await user.click(await screen.findByRole('button', { name: '使用 Grok 登录' }))
  await user.click(screen.getByRole('button', { name: 'GitHub Copilot' }))
  await act(async () => { complete({ state: 'connected', email: '原页面的 Grok 账户' }) })
  expect(await screen.findByRole('button', { name: '使用 GitHub 登录' })).toBeEnabled()
  expect(screen.queryByText('原页面的 Grok 账户')).toBeNull()
})

test('Copilot 在发起登录后从主进程读取设备码，取消后不保留验证码', async () => {
  let waiting = false
  const { user } = setup(false, {
    getAccountStatus: async () => waiting ? { state: 'pending', userCode: 'XYZ1-XYZ2', verificationUrl: 'https://github.com/login/device' } : { state: 'disconnected' },
    signInAccount: async () => { waiting = true; return new Promise<never>(() => {}) },
    cancelAccountSignIn: async () => { waiting = false },
  }, [copilotAccount])
  await user.click(screen.getByRole('button', { name: 'GitHub Copilot' }))
  await user.click(await screen.findByRole('button', { name: '使用 GitHub 登录' }))
  expect(await screen.findByText('XYZ1-XYZ2', {}, { timeout: 3000 })).toBeVisible()
  await user.click(screen.getByRole('button', { name: '取消登录' }))
  expect(await screen.findByRole('button', { name: '使用 GitHub 登录' })).toBeEnabled()
  expect(screen.queryByText('XYZ1-XYZ2')).toBeNull()
})

test('退出后按重新读取的状态展示，暂时读不到时允许重试', async () => {
  let first = true, unavailable = false
  const { user } = setup(false, {
    getAccountStatus: async () => {
      if (first) { first = false; return { state: 'connected', email: 'synthetic' } }
      if (unavailable) throw { code: 'TRANSIENT', action: '请重新读取账户状态。' }
      return { state: 'disconnected' }
    },
    signOutAccount: async () => { unavailable = true },
  })
  await user.click(screen.getByRole('button', { name: 'OpenAI Codex' }))
  await user.click(await screen.findByRole('button', { name: '退出登录' }))
  await user.click(screen.getByRole('button', { name: '确认退出' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('请重新读取账户状态。')
  expect(screen.queryByText('已连接 ChatGPT')).toBeNull()
  unavailable = false
  await user.click(screen.getByRole('button', { name: '重试读取状态' }))
  expect(await screen.findByRole('button', { name: '使用 ChatGPT 登录' })).toBeEnabled()
})

test('ChatGPT 仅首次连接提示套餐用量，退出失败仍保留真实账户', async () => {
  let connected = false, refuseLogout = true
  const status = () => connected ? { state: 'connected' as const, email: 'demo@example.invalid' } : { state: 'disconnected' as const }
  const { user } = setup(false, {
    getAccountStatus: async () => status(),
    signInAccount: async () => { connected = true; return status() },
    signOutAccount: async () => { if (refuseLogout) throw { code: 'REVOKE_FAILED', action: '请重试退出登录。' }; connected = false },
  })
  await user.click(screen.getByRole('button', { name: 'OpenAI Codex' }))
  await user.click(await screen.findByRole('button', { name: '使用 ChatGPT 登录' }))
  await user.click(await screen.findByRole('button', { name: '知道了' }))
  expect(screen.getByRole('link', { name: '在 ChatGPT 管理用量' })).toHaveAttribute('href', 'https://chatgpt.com/settings/usage')
  await user.click(screen.getByRole('button', { name: '退出登录' }))
  await user.click(screen.getByRole('button', { name: '确认退出' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('请重试退出登录。')
  expect(screen.getByText('demo@example.invalid')).toBeVisible()
  refuseLogout = false
  await user.click(screen.getByRole('button', { name: '退出登录' }))
  await user.click(screen.getByRole('button', { name: '确认退出' }))
  await user.click(await screen.findByRole('button', { name: '使用 ChatGPT 登录' }))
  expect(await screen.findByText('demo@example.invalid')).toBeVisible()
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('ChatGPT 识别已登录但尚缺套餐授权的账号，可在同一账号补授权', async () => {
  const signInAccount = vi.fn(async () => ({ state: 'connected' as const, email: 'fixture@example.invalid' }))
  const { user } = setup(false, { getAccountStatus: async () => ({ state: 'disconnected', email: 'fixture@example.invalid', accountId: 'fixture', planPermissionNeeded: true }), signInAccount })
  await user.click(screen.getByRole('button', { name: 'OpenAI Codex' }))
  expect(await screen.findByText('已登录 fixture@example.invalid，尚未授权使用套餐。')).toBeVisible()
  expect(screen.getByRole('button', { name: '同步模型' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: '授权使用 ChatGPT 套餐' }))
  expect(signInAccount).toHaveBeenCalledWith('openai-codex', false)
})

test('Codex displays only local counters returned for the active account and preserves zero and partial usage', async () => {
  const getAccountUsage = vi.fn().mockRejectedValueOnce(new Error('读取失败')).mockResolvedValue({requests:2,inputTokens:1234,outputTokens:0,partial:true})
  const { user } = setup(false, { getAccountUsage, getAccountStatus: async () => ({state:'connected', accountId:'a', email:'演示账号'}) })
  await user.click(screen.getByRole('button', {name:'OpenAI Codex'}))
  await user.click(await screen.findByText('本机使用记录', {exact:true}))
  await user.click(await screen.findByRole('button', {name:'重读本机用量'}))
  const region = screen.getByText('本机使用记录', {exact:true}).closest('details')!
  expect(await within(region).findByText('1,234')).toBeVisible()
  expect(within(region).getByText('0',{exact:true})).toBeVisible()
  expect(region).toHaveTextContent('部分请求未返回完整用量')
  expect(screen.getByRole('link',{name:'在 ChatGPT 管理用量'})).toHaveAttribute('href','https://chatgpt.com/settings/usage')
  expect(region).not.toHaveTextContent('%')
})

test('model detail search reveals a recovery action and restores the saved model', async () => {
  const { user } = setup()
  await user.type(screen.getByLabelText('搜索已添加模型'),'不存在')
  expect(await screen.findByText('没有匹配的已添加模型')).toBeVisible()
  await user.click(screen.getByRole('button',{name:'清除模型搜索'}))
  expect(screen.getByLabelText('搜索已添加模型')).toHaveValue('')
  expect(screen.getByLabelText('搜索已添加模型')).toHaveFocus()
  expect(screen.getByTitle('示例模型 · alpha')).toBeVisible()
})

test('empty added filter does not claim a remote catalog is empty', async () => {
  const { user } = setup(false)
  await user.click(screen.getByRole('button',{name:'同步模型'}))
  await screen.findByRole('checkbox',{name:/选择示例模型/})
  await user.click(screen.getByRole('button',{name:/已添加 0/}))
  expect(screen.getByText('还没有已添加的模型')).toBeVisible()
  await user.click(screen.getByRole('button',{name:'查看全部模型'}))
  expect(screen.getByRole('checkbox',{name:/选择示例模型/})).toBeVisible()
  expect(screen.getByLabelText('搜索模型', {exact:true})).toHaveFocus()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('region',{name:'同步模型列表'})).toBeNull()
})
