import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultProcessing, type SettingsApi, type SettingsSnapshot } from '../../shared/settings-contract'
import { SettingsPage } from './settings-page'

function setup(withProvider = true, withModel = false) {
  let state: SettingsSnapshot = { providers: withProvider ? [{ id: 'p1', name: '本地服务', baseUrl: 'http://127.0.0.1:1234/v1', enabled: true, hasCredential: true }] : [], models: withModel ? [{ id: 'm1', providerId: 'p1', label: '测试模型', model: 'alpha', baseUrl: 'http://127.0.0.1:1234/v1', enabled: true, hasCredential: true, contextWindow: 8192, maxTokens: 1024, version: 1 }] : [], processing: structuredClone(defaultProcessing), selectedModels: {}, debug: false }
  const api: SettingsApi = {
    get: vi.fn(async () => structuredClone(state)),
    saveProvider: vi.fn(async input => { const saved = { ...input, id: input.id ?? 'p2', hasCredential: input.apiKey === null ? false : true }; state.providers = [...state.providers.filter(p => p.id !== saved.id), saved]; return saved }),
    removeProvider: vi.fn(async id => { state.providers = state.providers.filter(p => p.id !== id) }),
    saveModel: vi.fn(async input => { const saved = { ...input, id: input.id ?? `m-${input.model}`, baseUrl: 'http://127.0.0.1:1234/v1', hasCredential: true, version: 1 }; state.models = [...state.models.filter(m => m.id !== saved.id), saved]; return saved }),
    removeModel: vi.fn(async id => { state.models = state.models.filter(m => m.id !== id) }),
    syncModels: vi.fn(async () => [{ id: 'alpha' }, { id: 'beta' }, { id: 'gamma' }]), testModel: vi.fn(async () => {}), stopModelTasks: vi.fn(async () => {}),
    saveProcessing: vi.fn(async input => { state = { ...state, processing: input }; return input }),
    selectModel: vi.fn(async () => {}), setDebug: vi.fn(async () => {}), getDiagnostics: vi.fn(async () => ({ version: '0.1.2', platform: 'win32', entries: [] })),
    getStorage: vi.fn(async () => ({ path: 'D:\\Whomi', defaultPath: 'D:\\Whomi', restartRequired: false })),
    chooseStorage: vi.fn(async () => ({ token: 'choice', path: 'D:\\新的目录' })),
    relocateStorage: vi.fn(async () => ({ path: 'D:\\新的目录', defaultPath: 'D:\\Whomi', restartRequired: true })), restart: vi.fn(async () => {}),
  }
  const onClose = vi.fn()
  render(<SettingsPage api={api} onClose={onClose} />)
  return { api, onClose, user: userEvent.setup() }
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})

describe('正式设置', () => {
  it('已有密钥不填回输入；离开时继续编辑保留草稿，保存后才离开', async () => {
    const { api, user } = setup()
    const name = await screen.findByLabelText('服务商名称')
    expect(screen.queryByDisplayValue('已保存')).not.toBeInTheDocument()
    await user.clear(name); await user.type(name, '更新名称')
    await user.click(screen.getByRole('button', { name: '消息处理' }))
    await user.click(screen.getByRole('button', { name: '继续编辑' }))
    expect(name).toHaveValue('更新名称')
    await user.click(screen.getByRole('button', { name: '消息处理' }))
    await user.click(screen.getByRole('button', { name: '保存并离开' }))
    await screen.findByRole('heading', { name: '消息处理' })
    expect(api.saveProvider).toHaveBeenCalledWith(expect.objectContaining({ name: '更新名称' }))
    expect(vi.mocked(api.saveProvider).mock.calls[0][0]).not.toHaveProperty('apiKey')
  })

  it('清除密钥显式保存，失败保留输入且可重试', async () => {
    const { api, user } = setup()
    await screen.findByLabelText('服务商名称')
    vi.mocked(api.saveProvider).mockRejectedValueOnce(new Error('请停止正在运行的任务。'))
    await user.click(screen.getByRole('button', { name: '清除密钥' }))
    await user.click(screen.getByRole('button', { name: '保存服务商' }))
    await screen.findByText('请停止正在运行的任务。')
    await user.click(screen.getByRole('button', { name: '保存服务商' }))
    await waitFor(() => expect(api.saveProvider).toHaveBeenCalledTimes(2))
    expect(api.saveProvider).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: null }))
  })

  it('同步模型仅添加勾选项，搜索不丢失先前选择', async () => {
    const { api, user } = setup()
    await user.click(await screen.findByRole('button', { name: '同步模型' }))
    const modal = await screen.findByRole('dialog', { name: '选择模型' })
    await user.click(within(modal).getByRole('checkbox', { name: 'alpha' }))
    await user.type(within(modal).getByRole('textbox', { name: '搜索模型' }), 'beta')
    await user.click(within(modal).getByRole('checkbox', { name: '全选当前结果' }))
    await user.click(within(modal).getByRole('button', { name: '添加所选模型 (2)' }))
    expect(api.saveModel).not.toHaveBeenCalled()
    await user.type(within(modal).getByRole('spinbutton', { name: '上下文长度' }), '8192')
    await user.type(within(modal).getByRole('spinbutton', { name: '最大输出长度' }), '1024')
    await user.click(within(modal).getByRole('button', { name: '添加所选模型 (2)' }))
    await waitFor(() => expect(api.saveModel).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.saveModel).mock.calls.map(call => call[0].model)).toEqual(['alpha', 'beta'])
  })

  it('处理自动保存失败恢复原开关，重试提交原设置', async () => {
    const { api, user } = setup(false)
    await screen.findByRole('button', { name: '添加服务商' })
    await user.click(screen.getByRole('button', { name: '消息处理' }))
    vi.mocked(api.saveProcessing).mockRejectedValueOnce(new Error('保存失败，请重试。'))
    const toggle = screen.getByRole('switch', { name: '数据清洗' })
    await user.click(toggle)
    await screen.findByRole('button', { name: '重试保存' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await user.click(screen.getByRole('button', { name: '重试保存' }))
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
    expect(vi.mocked(api.saveProcessing).mock.calls[1][0]).toEqual({ ...defaultProcessing, clean: false })
  })

  it('取消迁移不移动文件；失败保留目标，重试成功后提供重启', async () => {
    const { api, user } = setup(false)
    await screen.findByRole('button', { name: '添加服务商' })
    await user.click(screen.getByRole('button', { name: '数据存储' }))
    await user.click(await screen.findByRole('button', { name: '选择保存目录' }))
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(api.relocateStorage).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '选择保存目录' }))
    vi.mocked(api.relocateStorage).mockRejectedValueOnce(new Error('目标目录不可写，请重新选择。'))
    await user.click(screen.getByRole('button', { name: '确认迁移' }))
    await screen.findByText('目标目录不可写，请重新选择。')
    await user.click(screen.getByRole('button', { name: '重试迁移' }))
    await screen.findByRole('button', { name: '立即重启' })
    expect(screen.getByRole('button', { name: '返回' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '模型服务' })).toBeDisabled()
    await user.click(await screen.findByRole('button', { name: '立即重启' }))
    expect(api.relocateStorage).toHaveBeenLastCalledWith('choice')
    expect(api.restart).toHaveBeenCalledTimes(1)
  })

  it('迁移失败且服务无法恢复时读取真实目录状态，关闭确认并提供重启', async () => {
    const { api, user } = setup(false)
    await screen.findByRole('button', { name: '添加服务商' })
    await user.click(screen.getByRole('button', { name: '数据存储' }))
    await user.click(await screen.findByRole('button', { name: '选择保存目录' }))
    vi.mocked(api.relocateStorage).mockRejectedValueOnce(Object.assign(new Error('保存目录未更改，请重新打开应用。'), { code: 'STORAGE_RESTORE_FAILED' }))
    vi.mocked(api.getStorage).mockResolvedValue({ path: 'D:\\Whomi', defaultPath: 'D:\\Whomi', restartRequired: true })
    await user.click(screen.getByRole('button', { name: '确认迁移' }))
    await screen.findByRole('button', { name: '立即重启' })
    expect(screen.queryByRole('dialog', { name: '迁移数据' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '当前保存目录' })).toBeInTheDocument()
    expect(screen.getByText('D:\\Whomi')).toBeInTheDocument()
    expect(screen.queryByText('数据已迁移，请重启 Whomi 继续使用。')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '返回' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '模型服务' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '立即重启' }))
    expect(api.restart).toHaveBeenCalledTimes(1)
  })

  it('部分模型已保存后失败，重试只添加剩余项', async () => {
    const { api, user } = setup()
    const originalSave = vi.mocked(api.saveModel).getMockImplementation()!
    vi.mocked(api.saveModel).mockImplementationOnce(originalSave).mockRejectedValueOnce(new Error('添加失败，请重试。'))
    await user.click(await screen.findByRole('button', { name: '同步模型' }))
    const modal = await screen.findByRole('dialog', { name: '选择模型' })
    await user.click(within(modal).getByRole('checkbox', { name: 'alpha' }))
    await user.click(within(modal).getByRole('checkbox', { name: 'beta' }))
    await user.click(within(modal).getByText('高级设置'))
    await user.type(within(modal).getByRole('spinbutton', { name: '上下文长度' }), '8192')
    await user.type(within(modal).getByRole('spinbutton', { name: '最大输出长度' }), '1024')
    await user.click(within(modal).getByRole('button', { name: '添加所选模型 (2)' }))
    await within(modal).findByText('已添加 1 项。添加失败，请重试。')
    expect(within(modal).getByRole('checkbox', { name: 'alpha' })).toBeDisabled()
    await user.click(within(modal).getByRole('button', { name: '添加所选模型 (1)' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(vi.mocked(api.saveModel).mock.calls.map(call => call[0].model)).toEqual(['alpha', 'beta', 'beta'])
  })

  it('未知模型参数必须填写；编辑取消可继续或放弃并恢复焦点', async () => {
    const { api, user } = setup()
    const opener = await screen.findByRole('button', { name: '手动添加' })
    await user.click(opener)
    const modal = screen.getByRole('dialog', { name: '手动添加模型' })
    await user.type(within(modal).getByRole('textbox', { name: '模型标识' }), 'manual')
    await user.type(within(modal).getByRole('textbox', { name: '显示名称' }), '手动模型')
    await user.click(within(modal).getByRole('button', { name: '添加模型' }))
    expect(api.saveModel).not.toHaveBeenCalled()
    expect(within(modal).getByRole('spinbutton', { name: '上下文长度' })).toHaveValue(null)
    await user.type(within(modal).getByRole('spinbutton', { name: '上下文长度' }), '8192')
    await user.type(within(modal).getByRole('spinbutton', { name: '最大输出长度' }), '1024')
    await user.click(within(modal).getByRole('button', { name: '取消' }))
    await user.click(screen.getByRole('button', { name: '继续编辑' }))
    expect(within(modal).getByRole('textbox', { name: '模型标识' })).toHaveValue('manual')
    await user.click(within(modal).getByRole('button', { name: '添加模型' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.saveModel).toHaveBeenCalledWith(expect.objectContaining({ model: 'manual', contextWindow: 8192, maxTokens: 1024 }))
    expect(opener).toHaveFocus()
    await user.click(screen.getByRole('button', { name: '编辑手动模型' }))
    const edit = screen.getByRole('dialog', { name: '编辑模型' })
    await user.type(within(edit).getByRole('textbox', { name: '显示名称' }), ' 草稿')
    fireEvent(edit, new Event('cancel', { bubbles: false, cancelable: true }))
    await user.click(screen.getByRole('button', { name: '放弃修改' }))
    expect(screen.queryByText('手动模型 草稿')).not.toBeInTheDocument()
    expect(api.saveModel).toHaveBeenCalledTimes(1)
  })

  it('运行中模型需明确停止后再移除；检测失败可重试', async () => {
    const { api, user } = setup(true, true)
    vi.mocked(api.testModel).mockRejectedValueOnce(new Error('请检查模型标识后重试。'))
    await user.click(await screen.findByRole('button', { name: '检测连接' }))
    await screen.findByText('请检查模型标识后重试。')
    await user.click(screen.getByRole('button', { name: '重试检测' }))
    await screen.findByText('连接成功')
    vi.mocked(api.removeModel).mockRejectedValueOnce(Object.assign(new Error('任务运行中'), { code: 'MODEL_BUSY' }))
    await user.click(screen.getByRole('button', { name: '移除测试模型' }))
    await user.click(screen.getByRole('button', { name: '确认移除' }))
    const retry = await screen.findByRole('button', { name: '停止任务并重试' })
    expect(api.stopModelTasks).not.toHaveBeenCalled()
    await user.click(retry)
    await waitFor(() => expect(screen.queryByText('测试模型')).not.toBeInTheDocument())
    expect(api.stopModelTasks).toHaveBeenCalledWith(['m1'])
    expect(api.removeModel).toHaveBeenCalledTimes(2)
  })

  it('处理默认八项规则，关闭保留子选项，恢复只改变规则', async () => {
    const { api, user } = setup(false)
    await screen.findByRole('button', { name: '添加服务商' })
    await user.click(screen.getByRole('button', { name: '消息处理' }))
    expect(screen.getByText('已选 8/10 项')).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: '合并时间窗口' })).toHaveValue(60)
    expect(screen.getByRole('switch', { name: '智能去噪' })).toHaveAttribute('aria-checked', 'false')
    await user.click(screen.getByRole('button', { name: '增加合并时间窗口 1 秒' }))
    await user.click(screen.getByRole('checkbox', { name: '中国大陆' }))
    expect(screen.getByText('已选 4/10 项')).toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: '数据脱敏' }))
    await user.click(screen.getByRole('switch', { name: '数据脱敏' }))
    expect(screen.getByText('已选 4/10 项')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '恢复默认规则' }))
    await user.click(screen.getByRole('button', { name: '确认恢复' }))
    expect(screen.getByText('已选 8/10 项')).toBeInTheDocument()
    expect(vi.mocked(api.saveProcessing).mock.lastCall?.[0]).toEqual({ ...defaultProcessing, mergeSeconds: 61 })
    const seconds = screen.getByRole('spinbutton', { name: '合并时间窗口' })
    await user.clear(seconds); await user.type(seconds, '601'); await user.tab()
    expect(screen.getByText('请输入 1～600 的整数秒数。')).toBeInTheDocument()
    expect(vi.mocked(api.saveProcessing).mock.lastCall?.[0].mergeSeconds).toBe(61)
  })

  it('调试默认关闭，开启后读取真实诊断并复制，声明来自项目文件', async () => {
    const { api, user } = setup(false)
    await screen.findByRole('button', { name: '添加服务商' })
    await user.click(screen.getByRole('button', { name: '关于whomi' }))
    expect(api.getDiagnostics).not.toHaveBeenCalled()
    await user.click(screen.getByRole('switch', { name: '调试模式' }))
    await screen.findByText('win32')
    const copy = vi.spyOn(navigator.clipboard, 'writeText')
    await user.click(screen.getByRole('button', { name: '复制诊断信息' }))
    expect(copy).toHaveBeenCalledWith(JSON.stringify({ version: '0.1.2', platform: 'win32', entries: [] }, null, 2))
    await user.click(screen.getByRole('button', { name: '第三方声明' }))
    const modal = screen.getByRole('dialog', { name: '第三方声明' })
    expect(within(modal).getByRole('heading', { name: 'ChatLab 会话解析模块' })).toBeInTheDocument()
    expect(within(modal).getByRole('link', { name: 'GSAP Standard License' })).toHaveAttribute('href', 'https://gsap.com/standard-license')
  })

  it('本地图片失败保留表单，成功仅随显式保存提交，密钥替换后输入清空', async () => {
    const { api, user } = setup()
    await screen.findByLabelText('服务商名称')
    const image = screen.getByLabelText(/服务商图片/)
    const tooLarge = new File([new Uint8Array(1024 * 1024 + 1)], 'large.png', { type: 'image/png' })
    await user.upload(image, tooLarge)
    await screen.findByText('请选择不超过 1 MB 的图片。')
    expect(api.saveProvider).not.toHaveBeenCalled()
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII='), character => character.charCodeAt(0))
    await user.upload(image, new File([png], 'example.png', { type: 'image/png' }))
    await screen.findByAltText('已选服务商图片')
    const key = screen.getByLabelText('替换密钥')
    await user.type(key, 'example-replacement')
    await user.click(screen.getByRole('button', { name: '保存服务商' }))
    await waitFor(() => expect(key).toHaveValue(''))
    expect(api.saveProvider).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'example-replacement', image: expect.stringMatching(/^data:image\/png;base64,/) }))
  })
})
