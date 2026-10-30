import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { FileImport } from '../file-import'
import { candidate, fakeImportApi, saved, snapshot } from '../../test/import-api'

async function staged(api: ReturnType<typeof fakeImportApi>['api']) {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: '选择文件夹' }))
  expect(await screen.findByText('两层目录中的记录.json')).toBeVisible()
  await user.click(screen.getByRole('checkbox', { name: /两层目录中的记录/ }))
  await user.click(screen.getByRole('button', { name: '解析所选入口' }))
  await screen.findByRole('group', { name: '会话 a' })
  expect(api.chooseSources).toHaveBeenCalledWith('directory')
  return user
}

describe('真实导入界面合同', () => {
  it('目录发现后显式选择入口、预览、目标，持久保存后才能打开', async () => {
    const { api } = fakeImportApi(), onSaved = vi.fn(), onOpen = vi.fn()
    render(<FileImport api={api} onSaved={onSaved} onOpenConversation={onOpen} />)
    const user = await staged(api)
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.queryByText('已保存 500 条消息。')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '预览消息' }))
    expect(await screen.findByText('虚构预览正文')).toBeVisible()
    expect(screen.getByText('消息预览 · 尚未保存')).toBeVisible()
    await user.selectOptions(screen.getByLabelText('导入目标'), 'new')
    await user.click(screen.getByRole('button', { name: '确认保存' }))
    expect(await screen.findByText('已保存 500 条消息。')).toBeVisible()
    expect(onSaved).toHaveBeenCalledWith(['7'])
    expect(api.startImport).toHaveBeenLastCalledWith({ kind: 'commit', plan: { jobId: 'job', decisions: [{ candidateId: 'a', target: { kind: 'new' }, confirmedAliases: [] }] } })
    await user.click(screen.getByRole('button', { name: '打开会话' }))
    expect(onOpen).toHaveBeenCalledWith('7')
  })

  it('目标不凭同名默认选中，未确认目标不能保存', async () => {
    const { api } = fakeImportApi()
    render(<FileImport api={api} />)
    const user = await staged(api)
    expect(screen.getByLabelText('导入目标')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: '确认保存' }))
    expect(screen.getByRole('alert')).toHaveTextContent('请选择导入目标')
    expect(api.startImport).toHaveBeenCalledTimes(1)
    await user.selectOptions(screen.getByLabelText('导入目标'), 'existing:9')
    expect(screen.getByText('将保存到：已有会话')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '确认保存' }))
    expect(api.startImport).toHaveBeenLastCalledWith({ kind: 'commit', plan: { jobId: 'job', decisions: [{ candidateId: 'a', target: { kind: 'existing', conversationId: '9' }, confirmedAliases: [] }] } })
  })

  it('逐项展示保存、失败、重复，进度重发不重复通知；取消保留打开入口和摘要重试', async () => {
    const { api, emit } = fakeImportApi(), onSaved = vi.fn(), onOpen = vi.fn()
    render(<FileImport api={api} onSaved={onSaved} onOpenConversation={onOpen} />)
    const user = await staged(api)
    const value = snapshot({ status: 'committing', candidates: [candidate('a'), candidate('b'), candidate('c')], results: [
      saved('a', '7', { summaryFailed: true }),
      saved('b', '8', { status: 'failed', committedAt: null, inserted: 0, issues: [{ code: 'BROKEN', severity: 'blocking', candidateId: 'b', action: '请重新选择损坏的记录。' }] }),
      saved('c', '9', { status: 'duplicate', inserted: 0, duplicates: 12 }),
    ] })
    act(() => emit(value))
    expect(await screen.findByText('已保存 500 条消息。')).toBeVisible()
    expect(screen.getByText('新增 0 条消息，重复 12 条。')).toBeVisible()
    expect(screen.getByText('请重新选择损坏的记录。')).toBeVisible()
    expect(onSaved).toHaveBeenCalledWith(['7', '9'])
    expect(onSaved).not.toHaveBeenCalledWith(expect.arrayContaining(['8']))
    act(() => emit({ ...value }))
    expect(onSaved).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: '取消导入' }))
    expect(screen.getAllByRole('button', { name: '打开会话' })).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: '重试摘要' }))
    await waitFor(() => expect(api.retrySummary).toHaveBeenCalledWith('7'))
    expect(screen.getByText('摘要已更新。')).toBeVisible()
  })

  it('后缀不自动合并，显式映射随提交发送；预览按页替换而非无限增长', async () => {
    const { api } = fakeImportApi()
    vi.mocked(api.previewImport).mockResolvedValueOnce({ messages: [], nextOrdinal: 50 }).mockResolvedValueOnce({ messages: [], nextOrdinal: null })
    render(<FileImport api={api} />)
    const user = await staged(api)
    await user.click(screen.getByRole('button', { name: '预览消息' }))
    await user.click(await screen.findByRole('button', { name: '下一页预览' }))
    expect(api.previewImport).toHaveBeenLastCalledWith('job', 'a', { afterOrdinal: 50, limit: 50 })
    await user.click(screen.getByText('确认账号别名'))
    await user.type(screen.getByLabelText('来源账号'), 'owner_suffix')
    await user.type(screen.getByLabelText('对应账号'), 'owner')
    await user.selectOptions(screen.getByLabelText('导入目标'), 'new')
    await user.click(screen.getByRole('button', { name: '确认保存' }))
    expect(api.startImport).toHaveBeenLastCalledWith({ kind: 'commit', plan: { jobId: 'job', decisions: [{ candidateId: 'a', target: { kind: 'new' }, confirmedAliases: [{ platform: 'test', aliasKey: 'owner_suffix', accountKey: 'owner' }] }] } })
  })

  it('后端错误和不可用预览给出操作提示，不触发保存通知', async () => {
    const { api } = fakeImportApi(), onSaved = vi.fn()
    render(<FileImport api={api} onSaved={onSaved} />)
    const user = await staged(api)
    vi.mocked(api.previewImport).mockRejectedValue({ code: 'PREVIEW_UNAVAILABLE', action: '请重新选择来源并解析。' })
    await user.click(screen.getByRole('button', { name: '预览消息' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('请重新选择来源并解析')
    await user.selectOptions(screen.getByLabelText('导入目标'), 'new')
    vi.mocked(api.startImport).mockRejectedValue({ message: 'private path' })
    await user.click(screen.getByRole('button', { name: '确认保存' }))
    await waitFor(() => expect(screen.getByRole('alert')).not.toHaveTextContent('private path'))
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.queryByText('已保存 500 条消息。')).not.toBeInTheDocument()
  })

  it('拖放真实 File 数组并阻止窗口文件导航', async () => {
    const { api } = fakeImportApi()
    render(<FileImport api={api} />)
    const file = new File(['虚构'], '记录.json')
    fireEvent.drop(screen.getByRole('region', { name: '文件导入' }), { dataTransfer: { files: [file], types: ['Files'], items: [] } })
    await waitFor(() => expect(api.acceptDroppedFiles).toHaveBeenCalledWith([file]))
    const event = new Event('drop', { cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'] } })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('已有目标按游标分页，两个同名会话仍按编号显式选择', async () => {
    const { api } = fakeImportApi()
    const base = await api.listConversations({})
    vi.mocked(api.listConversations).mockClear().mockResolvedValueOnce({ ...base, nextCursor: 'next' })
      .mockResolvedValueOnce({ items: [{ ...base.items[0], id: '10' }], nextCursor: null })
    render(<FileImport api={api} />)
    const user = await staged(api)
    await user.click(await screen.findByRole('button', { name: '加载更多已有会话' }))
    await screen.findByRole('option', { name: '已有会话 · 编号 10' })
    expect(api.listConversations).toHaveBeenLastCalledWith({ cursor: 'next', limit: 200 })
    expect(screen.getByLabelText('导入目标')).toHaveValue('')
    await user.selectOptions(screen.getByLabelText('导入目标'), 'existing:10')
    expect(screen.getByText('将保存到：已有会话')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '确认保存' }))
    expect(api.startImport).toHaveBeenLastCalledWith({ kind: 'commit', plan: { jobId: 'job', decisions: [{ candidateId: 'a', target: { kind: 'existing', conversationId: '10' }, confirmedAliases: [] }] } })
  })

  it('后缀冲突和缺少持久提交时间的结果都不给保存通知或打开入口', async () => {
    const { api, emit } = fakeImportApi(), onSaved = vi.fn(), onOpen = vi.fn()
    render(<FileImport api={api} onSaved={onSaved} onOpenConversation={onOpen} />)
    await staged(api)
    act(() => emit(snapshot({ status: 'partially_completed', candidates: [candidate('a'), candidate('b')], results: [
      saved('a', '7', { status: 'blocked', inserted: 0, committedAt: null, issues: [{ code: 'SELF_CONFLICT', severity: 'blocking', candidateId: 'a', action: '请重新确认本人身份。' }] }),
      saved('b', '8', { committedAt: null }),
    ] })))
    expect(screen.getByText('请重新确认本人身份。')).toBeVisible()
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '打开会话' })).not.toBeInTheDocument()
    const results = screen.getByRole('region', { name: '导入进度与结果' })
    expect(within(results).queryByText(/^已保存/)).not.toBeInTheDocument()
  })

  it('保存前取消立即恢复初始文件选择区域，不遗留取消结果卡片', async () => {
    const { api, emit } = fakeImportApi()
    render(<FileImport api={api} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '选择文件夹' }))
    expect(await screen.findByText('两层目录中的记录.json')).toBeVisible()
    expect(screen.queryByRole('button', { name: '选择文件' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '取消导入' }))
    expect(api.cancelImport).toHaveBeenCalledWith('job')

    act(() => emit(snapshot({ status: 'cancelled', results: [] })))

    expect(await screen.findByRole('button', { name: '选择文件' })).toBeVisible()
    expect(screen.getByRole('button', { name: '选择文件夹' })).toBeVisible()
    expect(screen.queryByText('已取消导入。')).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '导入进度与结果' })).not.toBeInTheDocument()
  })

  it('部分保存后取消展示已保存成果与未完成状态，不把已保存表述为已撤销', async () => {
    const { api, emit } = fakeImportApi(), onOpen = vi.fn()
    render(<FileImport api={api} onOpenConversation={onOpen} />)
    await staged(api)

    act(() => emit(snapshot({
      status: 'cancelled',
      candidates: [candidate('a'), candidate('b')],
      results: [
        saved('a', '7', { status: 'saved', inserted: 320 }),
        saved('b', '8', { status: 'cancelled', committedAt: null, inserted: 0 }),
      ],
    })))

    expect(await screen.findByText('部分会话已保存，其余已取消。')).toBeVisible()
    expect(screen.getByText('已保存 320 条消息。')).toBeVisible()
    expect(screen.getByText('已取消')).toBeVisible()
    const openButton = screen.getByRole('button', { name: '打开会话' })
    expect(openButton).toBeVisible()
    await userEvent.click(openButton)
    expect(onOpen).toHaveBeenCalledWith('7')
  })

  it('发现 0 个文件时切换为未识别状态并提供重新选择路径', async () => {
    const { api, emit } = fakeImportApi()
    render(<FileImport api={api} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '选择文件' }))
    act(() => emit(snapshot({
      status: 'awaiting_confirmation',
      discovery: {
        entries: [],
        unrecognized: [{ displayName: 'invalid.json' }],
        issues: [],
      },
    })))
    expect(await screen.findByText('未识别到可导入的聊天记录')).toBeVisible()
    expect(screen.getByText('请选择其他文件。')).toBeVisible()
    expect(screen.getByText('invalid.json')).toBeVisible()
    expect(screen.queryByRole('button', { name: '解析所选入口' })).not.toBeInTheDocument()
    const rechooseButton = screen.getByRole('button', { name: '重新选择文件' })
    expect(rechooseButton).toBeVisible()
    await user.click(rechooseButton)
    expect(api.chooseSources).toHaveBeenCalledWith('files')
  })

  it('导入完成后提供继续导入，点击后返回初始选择起点', async () => {
    const { api, emit } = fakeImportApi()
    render(<FileImport api={api} />)
    await staged(api)
    act(() => emit(snapshot({
      status: 'completed',
      candidates: [candidate('a')],
      results: [saved('a', '7', { status: 'saved', inserted: 100 })],
    })))
    expect(await screen.findByText('已保存 100 条消息。')).toBeVisible()
    const continueButton = screen.getByRole('button', { name: '继续导入' })
    expect(continueButton).toBeVisible()
    await userEvent.click(continueButton)
    expect(await screen.findByRole('button', { name: '选择文件' })).toBeVisible()
    expect(screen.getByRole('button', { name: '选择文件夹' })).toBeVisible()
  })
})
