import { useState } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import type { ChatgptStatus } from '../../shared/chatgpt-plan'
import { defaultProcessing, type SettingsApi, type SettingsModel, type SettingsSnapshot } from '../../shared/settings-contract'
import { ModelServices } from './model-services'

const providerId = 'cherry:openai-codex'
const accountA: ChatgptStatus = { state: 'connected', accountId: 'fixture-a', email: 'a@example.invalid' }
const accountB: ChatgptStatus = { state: 'connected', accountId: 'fixture-b', email: 'b@example.invalid' }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function setup(initial: ChatgptStatus = accountA) {
  let status = initial
  let data: SettingsSnapshot = {
    providers: [{ id: providerId, name: 'OpenAI Codex', baseUrl: 'https://api.openai.com/v1', protocol: 'openai-responses', enabled: true, hasCredential: false, planAccount: 'fixture-a' }],
    models: ['甲模型', '乙模型'].map((label, index): SettingsModel => ({ id: 'fixture-model-' + index, providerId, label, model: 'fixture-' + index, baseUrl: 'https://api.openai.com/v1', protocol: 'openai-responses', enabled: index === 0, hasCredential: false, version: 1, planAccount: 'fixture-a', planProvider: 'openai-codex', contextWindow: 8000, maxTokens: 1000 })),
    processing: defaultProcessing, selectedModels: {}, debug: false,
  }
  function bind(next: ChatgptStatus, enabled = true) {
    status = next
    data = { ...data, providers: data.providers.map(provider => ({ ...provider, enabled: next.state === 'connected' && enabled, planAccount: next.state === 'connected' ? next.accountId : undefined })),
      models: data.models.map(model => next.state === 'connected' ? { ...model, planAccount: next.accountId } : model) }
  }
  const api = {
    get: vi.fn(async () => structuredClone(data)), getAccountStatus: vi.fn(async () => status),
    signInAccount: vi.fn(async (_id: string, newAccount: boolean) => { bind(newAccount ? accountB : accountA); return status }),
    signOutAccount: vi.fn(async () => { bind({ state: 'disconnected' }) }), cancelAccountSignIn: vi.fn(async () => { status = { state: 'disconnected' } }),
    setAccountEnabled: vi.fn(async (_id: string, enabled: boolean) => { bind(status, enabled) }),
    getCodexQuota: vi.fn(async () => ({ state: 'disconnected' })), getAccountUsage: vi.fn(async () => ({ requests: 0, inputTokens: 0, outputTokens: 0, partial: false })),
    testModel: vi.fn(async () => {}), syncModels: vi.fn(async () => [{ id: 'fixture-new', label: '目录示例模型' }]),
    saveModel: vi.fn(async input => { const previous = data.models.find(model => model.id === input.id)!; const result = { ...previous, ...input }; data = { ...data, models: data.models.map(model => model.id === result.id ? result : model) }; return result }),
  } as unknown as SettingsApi
  let publish!: (value: SettingsSnapshot) => void
  function Host() {
    const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(data)
    publish = setSnapshot
    return snapshot && <ModelServices api={api} snapshot={snapshot} setSnapshot={setSnapshot} onChanged={() => {}} registerGuard={() => {}} onBusy={() => {}} />
  }
  const view = render(<Host />)
  return { api, bind, publish: (value: SettingsSnapshot) => publish(value), snapshot: () => structuredClone(data), user: userEvent.setup(), ...view }
}
beforeEach(() => {
  localStorage.setItem('whomi:chatgpt-plan-welcome', '1')
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
function expectEmptyModels() {
  expect(screen.queryByRole('heading', { name: '模型 0' })).toBeVisible()
  expect(screen.getByText('尚未添加模型')).toBeVisible()
  expect(screen.queryByRole('textbox', { name: '搜索已添加模型' })).not.toBeInTheDocument()
  expect(screen.queryByText('甲模型')).not.toBeInTheDocument()
  expect(screen.queryByText('乙模型')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '编辑甲模型' })).not.toBeInTheDocument()
  expect(screen.queryByRole('switch', { name: '启用甲模型' })).not.toBeInTheDocument()
  for (const name of ['手动添加', '同步模型', '添加模型']) expect(screen.getByRole('button', { name })).toBeDisabled()
}
async function logout(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: '退出登录' }))
  await user.click(screen.getByRole('button', { name: '确认退出' }))
}

test('首次账户核对完成前不显示缓存模型', () => {
  setup()
  expectEmptyModels()
})

test('退出后恢复未登录空界面，同账号重登恢复偏好并清除搜索和检测', async () => {
  const { user } = setup()
  await user.click(await screen.findByRole('button', { name: '检测甲模型' }))
  await screen.findByText('连接成功')
  await user.type(screen.getByRole('textbox', { name: '搜索已添加模型' }), '甲')
  await logout(user)
  await screen.findByRole('button', { name: '使用 ChatGPT 登录' })
  expectEmptyModels()
  expect(screen.queryByText('a@example.invalid')).not.toBeInTheDocument()
  expect(screen.queryByRole('region', { name: '剩余额度' })).not.toBeInTheDocument()
  expect(screen.queryByText('本机使用记录')).not.toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: '使用 ChatGPT 登录' }))
  await screen.findByText('a@example.invalid')
  expect(screen.getByRole('heading', { name: '模型 2' })).toBeVisible()
  expect(screen.getByRole('textbox', { name: '搜索已添加模型' })).toHaveValue('')
  expect(screen.getByRole('switch', { name: '启用甲模型' })).toBeChecked()
  expect(screen.getByRole('switch', { name: '启用乙模型' })).not.toBeChecked()
  expect(screen.queryByText('连接成功')).not.toBeInTheDocument()
})

test('切换账号等待新设置期间不显示旧模型，完成后显示当前绑定', async () => {
  const { api, user, snapshot } = setup()
  await logout(user)
  await screen.findByRole('button', { name: '使用其他账号登录' })
  const pending = deferred<SettingsSnapshot>()
  vi.mocked(api.get).mockReturnValueOnce(pending.promise)
  await user.click(screen.getByRole('button', { name: '使用其他账号登录' }))
  expectEmptyModels()
  expect(screen.queryByText('a@example.invalid')).not.toBeInTheDocument()
  await act(async () => { pending.resolve(snapshot()) })
  expect(await screen.findByText('b@example.invalid')).toBeVisible()
  expect(screen.getByRole('heading', { name: '模型 2' })).toBeVisible()
  expect(api.syncModels).not.toHaveBeenCalled()
})

test('新账号设置刷新失败时隐藏旧配置并允许重新核对', async () => {
  const { api, user } = setup()
  await logout(user)
  await screen.findByRole('button', { name: '使用其他账号登录' })
  vi.mocked(api.get).mockRejectedValue(new Error('账户设置读取失败，请重试。'))
  await user.click(screen.getByRole('button', { name: '使用其他账号登录' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('账户设置读取失败，请重试。')
  expectEmptyModels()
  expect(screen.getByRole('button', { name: '重试读取状态' })).toBeEnabled()
})

test('登录后的单次设置读取失败可重读恢复且不遗留登录错误', async () => {
  const { api, user } = setup()
  await logout(user)
  await screen.findByRole('button', { name: '使用 ChatGPT 登录' })
  vi.mocked(api.get).mockRejectedValueOnce(new Error('账户设置读取失败，请重试。'))
  await user.click(screen.getByRole('button', { name: '使用 ChatGPT 登录' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('账户设置读取失败，请重试。')
  expectEmptyModels()
  await user.click(screen.getByRole('button', { name: '重试读取状态' }))
  expect(await screen.findByText('a@example.invalid')).toBeVisible()
  expect(screen.getByRole('heading', { name: '模型 2' })).toBeVisible()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('首次登录刷新绑定不取消授权并保留套餐提示', async () => {
  const { api, user } = setup()
  await logout(user)
  await screen.findByRole('button', { name: '使用 ChatGPT 登录' })
  localStorage.removeItem('whomi:chatgpt-plan-welcome')
  await user.click(screen.getByRole('button', { name: '使用 ChatGPT 登录' }))
  expect(await screen.findByRole('dialog', { name: '已启用 ChatGPT 套餐' })).toBeVisible()
  expect(api.cancelAccountSignIn).not.toHaveBeenCalled()
})

test('退出失败按真实登录状态保留模型并可再次退出', async () => {
  const { api, user } = setup()
  vi.mocked(api.signOutAccount).mockRejectedValueOnce(new Error('退出失败，请重试。'))
  await logout(user)
  expect(await screen.findByRole('alert')).toHaveTextContent('退出失败，请重试。')
  expect(screen.getByText('a@example.invalid')).toBeVisible()
  expect(screen.getByRole('heading', { name: '模型 2' })).toBeVisible()
  expect(screen.getByRole('button', { name: '同步模型' })).toBeEnabled()
  await logout(user)
  await screen.findByRole('button', { name: '使用 ChatGPT 登录' })
  expectEmptyModels()
})

test('仅停用仍登录的服务商保留模型配置', async () => {
  const { user } = setup()
  await screen.findByText('a@example.invalid')
  await user.click(screen.getByRole('switch', { name: '启用服务商' }))
  expect(screen.getByText('a@example.invalid')).toBeVisible()
  expect(screen.getByRole('heading', { name: '模型 2' })).toBeVisible()
  expect(screen.getByRole('button', { name: '同步模型' })).toBeDisabled()
})

test('退出等待期间关闭模型入口，退出失败后恢复真实模型', async () => {
  const { api, user } = setup()
  const pending = deferred<void>()
  vi.mocked(api.signOutAccount).mockReturnValueOnce(pending.promise)
  await logout(user)
  expectEmptyModels()
  await act(async () => { pending.reject(new Error('请先停止模型任务后重试。')) })
  expect(await screen.findByRole('alert')).toHaveTextContent('请先停止模型任务后重试。')
  expect(screen.getByRole('button', { name: '编辑甲模型' })).toBeEnabled()
})

test('已登录账户与缓存绑定不一致时不显示旧模型', async () => {
  setup(accountB)
  await screen.findByText('b@example.invalid')
  expectEmptyModels()
})

test.each(['编辑甲模型', '同步模型'])('账户绑定失效时清除%s抽屉及迟到目录结果', async opener => {
  const { api, user, publish, snapshot } = setup()
  await screen.findByText('a@example.invalid')
  const catalog = deferred<{ id: string; label: string }[]>()
  vi.mocked(api.syncModels).mockReturnValueOnce(catalog.promise)
  await user.click(screen.getByRole('button', { name: opener }))
  expect(screen.getByRole('dialog')).toBeVisible()
  const data = snapshot()
  act(() => publish({ ...data, providers: data.providers.map(provider => ({ ...provider, planAccount: undefined, enabled: false })) }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  await act(async () => { catalog.resolve([{ id: 'old-catalog', label: '旧账户目录' }]) })
  expectEmptyModels()
  expect(screen.queryByText('旧账户目录')).not.toBeInTheDocument()
  act(() => publish(data))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('退出期间关闭模型编辑入口，旧保存结果不能复活已退出模型', async () => {
  const { api, user } = setup()
  await screen.findByText('a@example.invalid')
  const pending = deferred<SettingsModel>()
  vi.mocked(api.saveModel).mockReturnValueOnce(pending.promise)
  await user.click(screen.getByRole('switch', { name: '启用甲模型' }))
  await logout(user)
  await screen.findByRole('button', { name: '使用 ChatGPT 登录' })
  await act(async () => { pending.resolve({ id: 'fixture-model-0', providerId, label: '旧保存回执', model: 'fixture-0', enabled: false, hasCredential: false, version: 2, planAccount: 'fixture-a', planProvider: 'openai-codex', baseUrl: 'https://api.openai.com/v1', contextWindow: 8000, maxTokens: 1000 }) })
  expectEmptyModels()
  expect(screen.queryByText('旧保存回执')).not.toBeInTheDocument()
})
