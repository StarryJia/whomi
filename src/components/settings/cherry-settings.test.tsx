import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import { defaultProcessing, type SettingsApi, type SettingsSnapshot } from '../../shared/settings-contract'
import { ModelServices } from './model-services'

const model = { id: 'm1', providerId: 'p1', label: '示例模型', model: 'alpha', baseUrl: 'http://localhost:1234/v1', enabled: true, hasCredential: true, contextWindow: 128000, maxTokens: 16384, version: 1 }
function setup(withModel = true, accountApi: Partial<SettingsApi> = {}) {
  let data: SettingsSnapshot = { providers: [{ id: 'p1', name: '示例服务', baseUrl: 'http://localhost:1234/v1', enabled: true, hasCredential: true }], models: withModel ? [model] : [], processing: defaultProcessing, selectedModels: {}, debug: false }
  const api = {
    get: async () => structuredClone(data),
    getCodexQuota: async () => ({ state: 'disconnected' }),
    getAccountUsage: async () => ({requests:0,inputTokens:null,outputTokens:null,partial:false}),
    saveProvider: vi.fn(async input => { const { apiKey: _key, ...safe } = input; const saved = { ...safe, id: input.id ?? 'p2', hasCredential: true }; data = { ...data, providers: [...data.providers.filter(p => p.id !== saved.id), saved] }; return saved }),
    removeProvider: vi.fn(async () => {}), stopModelTasks: vi.fn(async () => {}),
    saveModel: vi.fn(async input => { const saved = { ...model, ...input, id: input.id ?? `m-${input.model}` }; data = { ...data, models: [...data.models.filter(m => m.id !== saved.id), saved] }; return saved }),
    removeModel: vi.fn(async id => { data = { ...data, models: data.models.filter(m => m.id !== id) } }),
    syncModels: vi.fn(async () => [{ id: 'alpha', label: '示例模型', contextWindow: 128000, maxTokens: 16384 }, { id: 'beta', label: '目录模型', contextWindow: 200000, maxTokens: 32768 }]),
    testModel: vi.fn(async () => {}), ...accountApi,
  } as unknown as SettingsApi
  function Host() { const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(data); return snapshot && <ModelServices api={api} snapshot={snapshot} setSnapshot={setSnapshot} onChanged={() => {}} registerGuard={() => {}} onBusy={() => {}} /> }
  render(<Host />)
  return { api, user: userEvent.setup() }
}
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})

test('切换 New API 协议时更新预置路径，保留用户修改的服务器地址', async () => {
  const { user, api } = setup()
  await user.click(screen.getByRole('button', { name: 'New API' }))
  await user.click(screen.getByRole('button', { name: '配置服务商' }))
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

test('未配置目录可按平台英文标识搜索，专用认证平台不提供普通密钥配置入口', async () => {
  const { user, api } = setup()
  const search = screen.getByRole('textbox', { name: '搜索服务商' })
  await user.type(search, 'aws-bedrock')
  await user.click(screen.getByRole('button', { name: 'AWS Bedrock' }))
  const details = screen.getByRole('region', { name: '预置服务商详情' })
  expect(within(details).getByText(/AWS.*身份认证/)).toBeVisible()
  expect(within(details).queryByRole('button', { name: '配置服务商' })).toBeNull()
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
  await waitFor(() => expect(api.saveModel).toHaveBeenCalledWith(expect.objectContaining({ contextWindow: 128000, maxInputTokens: 128000, maxTokens: 16384 })))
  expect(within(drawer).queryByRole('alert')).not.toBeInTheDocument()
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
  expect(screen.getByText(/将在浏览器中完成授权/)).toBeVisible()
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
  const { user } = setup(false, { getAccountStatus: async () => connected ? { state: 'connected', email: '合成账户' } : { state: 'disconnected' }, signInAccount, signOutAccount })
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
  const { user } = setup(false, { getAccountStatus: async () => ({ state: 'pending', userCode: 'ABCD-EFGH', verificationUrl }), cancelAccountSignIn: async () => {} })
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
  const { user } = setup(false, { getAccountStatus: async () => ({ state: 'disconnected' }), signInAccount, cancelAccountSignIn: async () => {} })
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
  })
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
