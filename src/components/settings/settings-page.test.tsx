import { render, screen, waitFor, within } from '@testing-library/react'
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
  it('服务商编辑选择文本协议并随名称保存', async () => {
    const { user, api } = setup()
    await user.click(await screen.findByRole('button', { name: '本地服务更多操作' }))
    await user.click(screen.getByRole('menuitem', { name: '编辑' }))
    const editor = screen.getByRole('dialog', { name: '编辑服务商' })
    await user.click(within(editor).getByRole('combobox', { name: '连接协议' }))
    expect(screen.getAllByRole('option')).toHaveLength(4)
    await user.click(screen.getByRole('option', { name: 'Anthropic Messages' }))
    await user.type(within(editor).getByLabelText('服务商名称'), ' 更新')
    await user.click(within(editor).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(api.saveProvider).toHaveBeenCalledWith(expect.objectContaining({ name: '本地服务 更新', protocol: 'anthropic-messages' })))
  })

  it('关闭同步抽屉保留服务商配置和已保存模型', async () => {
    const { api, user } = setup(true, true)
    await user.click(await screen.findByRole('button', { name: '同步模型' }))
    const catalog = screen.getByRole('dialog', { name: '本地服务 模型' })
    await within(catalog).findByRole('checkbox', { name: '选择beta' })
    await user.click(within(catalog).getByRole('button', { name: '关闭本地服务 模型' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByLabelText('接口地址')).toHaveValue('http://127.0.0.1:1234/v1')
    expect(screen.getByText('测试模型', { exact: true })).toBeInTheDocument()
    expect(api.saveModel).not.toHaveBeenCalled()
  })

  it('修改连接失焦保存后重新同步使用最新配置', async () => {
    const { api, user } = setup()
    const address = await screen.findByLabelText('接口地址')
    await user.type(address, '/changed')
    expect(screen.getByRole('button', { name: '同步模型' })).toBeDisabled()
    await user.tab()
    await waitFor(() => expect(screen.getByRole('button', { name: '同步模型' })).toBeEnabled())
    expect(api.saveProvider).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'http://127.0.0.1:1234/v1/changed' }))
    await user.click(screen.getByRole('button', { name: '同步模型' }))
    await waitFor(() => expect(api.syncModels).toHaveBeenCalledWith('p1'))
  })

  it('已有密钥不填回输入，离开连接配置时自动保存替换密钥', async () => {
    const { api, user } = setup()
    const key = await screen.findByLabelText('替换密钥')
    expect(key).toHaveValue('')
    await user.type(key, 'synthetic-replacement')
    await user.click(screen.getByRole('button', { name: '消息处理' }))
    await screen.findByRole('switch', { name: '数据清洗' })
    expect(api.saveProvider).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'synthetic-replacement' }))
    expect(screen.queryByRole('dialog', { name: '保存修改？' })).not.toBeInTheDocument()
  })

  it('清除密钥立即保存，失败后可重试原操作', async () => {
    const { api, user } = setup()
    vi.mocked(api.saveProvider).mockRejectedValueOnce(new Error('保存失败，请重试。'))
    await user.click(await screen.findByRole('button', { name: '清除密钥' }))
    await user.click(await screen.findByRole('button', { name: '重试保存' }))
    await waitFor(() => expect(api.saveProvider).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.saveProvider).mock.lastCall?.[0]).toMatchObject({ id: 'p1', apiKey: null })
    await waitFor(() => expect(screen.getByLabelText('密钥')).toBeInTheDocument())
  })

  it('搜索结果全选后确认添加，未提供容量保留未知', async () => {
    const { api, user } = setup()
    await user.click(await screen.findByRole('button', { name: '同步模型' }))
    const catalog = screen.getByRole('dialog', { name: '本地服务 模型' })
    await within(catalog).findByRole('checkbox', { name: '选择alpha' })
    await user.type(within(catalog).getByRole('textbox', { name: '搜索模型' }), 'beta')
    await user.click(within(catalog).getByRole('button', { name: '全选' }))
    expect(api.saveModel).not.toHaveBeenCalled()
    await user.click(within(catalog).getByRole('button', { name: '添加 1 项' }))
    await waitFor(() => expect(api.saveModel).toHaveBeenCalledTimes(1))
    expect(api.saveModel).toHaveBeenCalledWith(expect.objectContaining({ model: 'beta', contextWindow: null, maxTokens: null }))
    await waitFor(() => expect(catalog).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: '添加模型' }))
    expect(await screen.findByRole('checkbox', { name: '选择alpha' })).toBeInTheDocument()
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
    const catalog = screen.getByRole('dialog', { name: '本地服务 模型' })
    await within(catalog).findByRole('checkbox', { name: '选择alpha' })
    await user.click(within(catalog).getByRole('button', { name: '全选' }))
    await user.click(within(catalog).getByRole('button', { name: '添加 3 项' }))
    await within(catalog).findByText('已添加 1 项。添加失败，请重试。')
    expect(within(catalog).getByRole('button', { name: '移除alpha' })).toBeInTheDocument()
    expect(within(catalog).getByRole('checkbox', { name: '选择beta' })).toBeChecked()
    expect(within(catalog).getByRole('checkbox', { name: '选择gamma' })).toBeChecked()
    expect(within(catalog).getByRole('button', { name: '添加 2 项' })).toBeEnabled()
    await user.click(within(catalog).getByRole('button', { name: '重试剩余模型' }))
    await waitFor(() => expect(vi.mocked(api.saveModel).mock.calls.map(call => call[0].model)).toEqual(['alpha', 'beta', 'beta', 'gamma']))
    await waitFor(() => expect(catalog).not.toBeInTheDocument())
  })

  it('部分添加失败后取消剩余选择，关闭保留已保存模型', async () => {
    const { api, user } = setup()
    const originalSave = vi.mocked(api.saveModel).getMockImplementation()!
    vi.mocked(api.saveModel).mockImplementationOnce(originalSave).mockRejectedValueOnce(new Error('添加失败，请重试。'))
    await user.click(await screen.findByRole('button', { name: '添加模型' }))
    const catalog = screen.getByRole('dialog', { name: '本地服务 模型' })
    await within(catalog).findByRole('checkbox', { name: '选择alpha' })
    await user.click(within(catalog).getByRole('button', { name: '全选' }))
    await user.click(within(catalog).getByRole('button', { name: '添加 3 项' }))
    await within(catalog).findByText('已添加 1 项。添加失败，请重试。')
    await user.click(within(catalog).getByRole('button', { name: '取消' }))
    expect(vi.mocked(api.saveModel).mock.calls.map(([input]) => input.model)).toEqual(['alpha', 'beta'])
    expect(api.removeModel).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '添加模型' }))
    const reopened = screen.getByRole('dialog', { name: '本地服务 模型' })
    expect(await within(reopened).findByRole('button', { name: '移除alpha' })).toBeInTheDocument()
    expect(within(reopened).getByRole('checkbox', { name: '选择beta' })).not.toBeChecked()
    expect(within(reopened).getByRole('checkbox', { name: '选择gamma' })).not.toBeChecked()
  })

  it('部分添加失败后可取消一个余项，重试采用当前选择', async () => {
    const { api, user } = setup()
    const originalSave = vi.mocked(api.saveModel).getMockImplementation()!
    vi.mocked(api.saveModel).mockImplementationOnce(originalSave).mockRejectedValueOnce(new Error('添加失败，请重试。'))
    await user.click(await screen.findByRole('button', { name: '添加模型' }))
    const catalog = screen.getByRole('dialog', { name: '本地服务 模型' })
    await within(catalog).findByRole('checkbox', { name: '选择alpha' })
    await user.click(within(catalog).getByRole('button', { name: '全选' }))
    await user.click(within(catalog).getByRole('button', { name: '添加 3 项' }))
    await within(catalog).findByText('已添加 1 项。添加失败，请重试。')
    await user.click(within(catalog).getByRole('checkbox', { name: '选择beta' }))
    await user.click(within(catalog).getByRole('button', { name: '重试剩余模型' }))
    await waitFor(() => expect(catalog).not.toBeInTheDocument())
    expect(vi.mocked(api.saveModel).mock.calls.map(([input]) => input.model)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('手动模型可保留未知容量，取消新建不保存且恢复焦点', async () => {
    const { api, user } = setup()
    const opener = await screen.findByRole('button', { name: '手动添加' })
    await user.click(opener)
    const editor = screen.getByRole('dialog', { name: '手动添加模型' })
    await user.type(within(editor).getByRole('textbox', { name: '模型标识' }), 'manual')
    await user.type(within(editor).getByRole('textbox', { name: '显示名称' }), '手动模型')
    expect(within(editor).getByRole('spinbutton', { name: '上下文长度' })).toHaveValue(null)
    await user.click(within(editor).getByRole('button', { name: '取消' }))
    expect(api.saveModel).not.toHaveBeenCalled()
    expect(opener).toHaveFocus()
    await user.click(opener)
    const next = screen.getByRole('dialog', { name: '手动添加模型' })
    await user.type(within(next).getByRole('textbox', { name: '模型标识' }), 'manual')
    await user.type(within(next).getByRole('textbox', { name: '显示名称' }), '手动模型')
    await user.click(within(next).getByRole('button', { name: '添加模型' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.saveModel).toHaveBeenCalledWith(expect.objectContaining({ model: 'manual', contextWindow: null, maxTokens: null }))
  })

  it('检测失败可重试，运行中模型移除需明确停止', async () => {
    const { api, user } = setup(true, true)
    vi.mocked(api.testModel).mockRejectedValueOnce(new Error('请检查模型标识后重试。'))
    await user.click(await screen.findByRole('button', { name: '检测测试模型' }))
    await screen.findByText('请检查模型标识后重试。')
    await user.click(screen.getByRole('button', { name: '检测测试模型' }))
    await screen.findByText('连接成功')
    vi.mocked(api.removeModel).mockRejectedValueOnce(Object.assign(new Error('任务运行中'), { code: 'MODEL_BUSY' }))
    await user.click(screen.getByRole('button', { name: '同步模型' }))
    const catalog = screen.getByRole('dialog', { name: '本地服务 模型' })
    await user.click(await within(catalog).findByRole('button', { name: '移除alpha' }))
    const retry = await within(catalog).findByRole('button', { name: '停止任务并重试' })
    expect(api.stopModelTasks).not.toHaveBeenCalled()
    await user.click(retry)
    await waitFor(() => expect(api.removeModel).toHaveBeenCalledTimes(2))
    expect(api.stopModelTasks).toHaveBeenCalledWith(['m1'])
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

  it('服务商编辑图片失败保留表单，正确图片随显式保存提交', async () => {
    const { api, user } = setup()
    await user.click(await screen.findByRole('button', { name: '本地服务更多操作' }))
    await user.click(screen.getByRole('menuitem', { name: '编辑' }))
    const editor = screen.getByRole('dialog', { name: '编辑服务商' })
    const image = within(editor).getByLabelText(/服务商图片/)
    await user.upload(image, new File([new Uint8Array(1024 * 1024 + 1)], 'large.png', { type: 'image/png' }))
    await within(editor).findByText('请选择不超过 1 MB 的图片。')
    expect(api.saveProvider).not.toHaveBeenCalled()
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII='), character => character.charCodeAt(0))
    await user.upload(image, new File([png], 'example.png', { type: 'image/png' }))
    await within(editor).findByAltText('已选服务商图片')
    await user.click(within(editor).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(api.saveProvider).toHaveBeenCalledWith(expect.objectContaining({ image: expect.stringMatching(/^data:image\/png;base64,/) })))
  })
})
