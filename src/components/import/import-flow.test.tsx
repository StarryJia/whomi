import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { FileImport } from '../file-import'
import { ExceptionNoticeProvider } from '../ui/exception-notices'
import { candidate, deferred, fakeImportApi, saved, snapshot } from '../../test/import-api'

it('单入口自动解析保存，无需目标、别名或预览，完成可打开和继续导入', async () => {
  const { api } = fakeImportApi(), onOpen = vi.fn(), onSaved = vi.fn()
  render(<FileImport api={api} onOpenConversation={onOpen} onSaved={onSaved} />)
  await userEvent.click(screen.getByRole('button', { name: '选择文件' }))
  expect(await screen.findByText('已保存 500 条消息。')).toBeVisible()
  expect(api.startImport).toHaveBeenNthCalledWith(1, { kind: 'stage', jobId: 'job', entryIds: ['entry'] })
  expect(api.startImport).toHaveBeenNthCalledWith(2, { kind: 'commit', plan: { jobId: 'job', decisions: [] } })
  expect(screen.queryByLabelText('导入目标')).not.toBeInTheDocument()
  expect(screen.queryByText('确认账号别名')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '预览消息' })).not.toBeInTheDocument()
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(['7']))
  await userEvent.click(screen.getByRole('button', { name: '打开会话' }))
  expect(onOpen).toHaveBeenCalledWith('7')
  await userEvent.click(screen.getByRole('button', { name: '继续导入' }))
  expect(screen.getByRole('button', { name: '选择文件' })).toBeVisible()
})
it('恢复多项结果时逐项显示实际匹配名称，缺少匹配记录的结果使用导出标题', async () => {
  const { api, emit } = fakeImportApi(), onOpen = vi.fn()
  const matched = {
    ...saved('a', '7', { status: 'duplicate', inserted: 0, duplicates: 100 }),
    matchedConversationTitle: '示例联系人',
  }
  const warning = { code: 'UNKNOWN_TYPE', candidateId: 'b', severity: 'warning' as const, action: '第 1 条消息保留为文本。' }
  emit(snapshot({
    status: 'completed',
    candidates: [{ ...candidate('a'), title: '示例导出标题' }, { ...candidate('b'), status: 'saved', title: '示例新会话' }, candidate('c')],
    results: [
      matched,
      saved('b', '8', { inserted: 2, duplicates: 1, issues: [warning] }),
      saved('c', '9', { inserted: 1, matchedConversationTitle: '' }),
    ],
    inserted: 3,
    duplicates: 101,
  }))
  localStorage.setItem('whomi:import-job', 'job')
  render(<FileImport api={api} onOpenConversation={onOpen} />)

  const trigger = await screen.findByRole('button', { name: '查看导入结果' })
  expect(screen.getByText('新增 3 条 · 跳过重复 101 条')).toBeVisible()
  expect(screen.queryByRole('heading', { name: '发现已有会话：示例联系人' })).not.toBeInTheDocument()
  await userEvent.click(trigger)
  expect(screen.getByRole('dialog', { name: '导入结果' })).toBeVisible()
  expect(screen.getByRole('heading', { name: '发现已有会话：示例联系人' })).toBeVisible()
  expect(screen.queryByRole('heading', { name: '示例导出标题' })).not.toBeInTheDocument()
  expect(screen.getByRole('heading', { name: '示例新会话' })).toBeVisible()
  expect(screen.getByRole('heading', { name: '发现已有会话：未命名会话' })).toBeVisible()
  expect(screen.getByText('新增 0 条 · 跳过重复 100 条')).toBeVisible()
  expect(screen.getByText('新增 2 条 · 跳过重复 1 条')).toBeVisible()
  expect(screen.getByText('新增 1 条 · 跳过重复 0 条')).toBeVisible()
  expect(screen.queryByText(warning.action)).not.toBeInTheDocument()
  await userEvent.click(screen.getAllByRole('button', { name: '打开会话' })[0])
  expect(onOpen).toHaveBeenCalledWith('7')
  await userEvent.click(screen.getByRole('button', { name: '继续导入' }))
  expect(screen.getByRole('button', { name: '选择文件' })).toBeVisible()
})
it('单个导出中的两段会话可以分别勾选，隐藏未识别文件', async () => {
  const { api, emit } = fakeImportApi()
  const original = vi.mocked(api.startImport).getMockImplementation()!
  vi.mocked(api.startImport).mockImplementation(async request => {
    if (request.kind === 'commit') return original(request)
    emit(snapshot({ status: 'awaiting_commit', candidates: [
      { ...candidate('friends'), title: '朋友记录' }, { ...candidate('family'), title: '家人记录' },
    ] }))
    return 'job'
  })
  render(<FileImport api={api} />)
  await userEvent.click(screen.getByRole('button', { name: '选择文件夹' }))
  expect(await screen.findByRole('heading', { name: '选择要导入的会话' })).toBeVisible()
  const submit = screen.getByRole('button', { name: '导入所选会话' })
  expect(submit).toBeDisabled()
  await userEvent.click(screen.getByRole('checkbox', { name: '家人记录' }))
  expect(screen.queryByText('图片.jpg')).not.toBeInTheDocument()
  expect(screen.queryByText('chatlab-jsonl')).not.toBeInTheDocument()
  await userEvent.click(submit)
  expect(api.startImport).toHaveBeenNthCalledWith(1, { kind: 'stage', jobId: 'job', entryIds: ['entry'] })
  expect(api.startImport).toHaveBeenNthCalledWith(2, { kind: 'commit', plan: { jobId: 'job', candidateIds: ['family'], decisions: [] } })
})
it('在明细窗中等到批次完成后可以直接读结果，关闭返回同批次的结果入口', async () => {
  const { api, emit } = fakeImportApi()
  const candidates = ['a', 'b'].map(candidate)
  const results = [saved('a', '7', { inserted: 120, duplicates: 4 }), saved('b', '7', { inserted: 80, duplicates: 3 })]
  emit(snapshot({ status: 'committing', candidates,
    results: results.map(result => ({ ...result, status: 'staged', committedAt: null, conversationId: null, inserted: 0 })) }))
  localStorage.setItem('whomi:import-job', 'job')
  render(<FileImport api={api} />)
  await userEvent.click(await screen.findByRole('button', { name: '查看导入状态' }))
  const status = screen.getByRole('dialog', { name: '会话状态' })
  expect(within(status).getByText('2 个导入项')).toBeVisible()
  expect(within(status).getAllByRole('listitem')).toHaveLength(2)
  act(() => emit(snapshot({ status: 'completed', candidates, results, inserted: 200, duplicates: 7 })))
  expect(screen.getByRole('dialog', { name: '导入结果' })).toBe(status)
  expect(within(status).getAllByRole('listitem')).toHaveLength(1)
  expect(within(status).getByText('新增 200 条 · 跳过重复 7 条')).toBeVisible()
  expect(within(status).getByText('1 个会话')).toBeVisible()
  await userEvent.click(within(status).getByRole('button', { name: '关闭' }))
  expect(screen.getByRole('button', { name: '查看导入结果' })).toHaveFocus()
  expect(screen.getByText('1 个会话')).toBeVisible()
})
it.each([
  { titles: ['项目组', ' 项目组 '], matchedConversationTitle: undefined },
  { titles: ['每周讨论', '出行计划'], matchedConversationTitle: '改名后的项目组' },
])('用来源区分在结果中同名的目标，并各自打开对应会话：$titles', async ({ titles, matchedConversationTitle }) => {
  const { api, emit } = fakeImportApi(), open = vi.fn()
  const entries = ['十月', '十一月'].map(month => ({ entryId: month, displayName: month + '/result.json', formatId: 'telegram' }))
  const candidates = entries.map((entry, index) => ({
    ...candidate(entry.entryId), entryId: entry.entryId, title: titles[index],
  }))
  emit(snapshot({ status: 'completed', discovery: { entries, unrecognized: [], issues: [] }, candidates,
    results: [saved('十月', '7', { matchedConversationTitle }), saved('十一月', '8', { matchedConversationTitle })], inserted: 1000 }))
  localStorage.setItem('whomi:import-job', 'job')
  render(<FileImport api={api} onOpenConversation={open} />)
  for (const [index, entry] of entries.entries()) {
    await userEvent.click(await screen.findByRole('button', { name: '查看导入结果' }))
    const rows = within(screen.getByRole('dialog')).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[index]).getByText(entry.displayName)).toBeVisible()
    await userEvent.click(within(rows[index]).getByRole('button', { name: '打开会话' }))
    expect(open).toHaveBeenLastCalledWith(index === 0 ? '7' : '8')
  }
})
it('会话标题相同时显示来源，同一来源的同名会话也可以区分', async () => {
  const { api, emit } = fakeImportApi()
  emit(snapshot({ status: 'awaiting_commit', discovery: { entries: [
    { entryId: 'first', displayName: '十月/result.json', formatId: 'chatlab' },
    { entryId: 'second', displayName: '十一月/result.json', formatId: 'chatlab' },
  ], unrecognized: [{ displayName: '普通资料.txt' }], issues: [] }, candidates: [
    { ...candidate('a'), title: '聊天', entryId: 'first' }, { ...candidate('b'), title: '聊天', entryId: 'first' },
    { ...candidate('c'), title: '聊天', entryId: 'second' }, { ...candidate('d'), title: '独立标题', entryId: 'second' },
  ] }))
  localStorage.setItem('whomi:import-job', 'job')
  render(<FileImport api={api} />)

  expect(await screen.findByRole('checkbox', { name: '聊天 十月/result.json · 1 / 2' })).toBeVisible()
  expect(screen.getByRole('checkbox', { name: '聊天 十月/result.json · 2 / 2' })).toBeVisible()
  const november = screen.getByRole('checkbox', { name: '聊天 十一月/result.json' })
  expect(screen.getByRole('checkbox', { name: '独立标题' })).toBeVisible()
  expect(screen.queryByText('普通资料.txt')).not.toBeInTheDocument()
  await userEvent.click(november)
  await userEvent.click(screen.getByRole('button', { name: '导入所选会话' }))
  expect(api.startImport).toHaveBeenCalledWith({ kind: 'commit', plan: { jobId: 'job', candidateIds: ['c'], decisions: [] } })
})
it('仅选择同一来源的第二、第三个同名会话时，保存与完成明细沿用选择时的序号', async () => {
  const { api, emit } = fakeImportApi(), open = vi.fn()
  const batch = snapshot({
    status: 'awaiting_commit',
    discovery: { entries: [{ entryId: 'entry', displayName: '导出.json', formatId: 'telegram' }], unrecognized: [], issues: [] },
    candidates: [
      { ...candidate('blocked'), status: 'blocked', title: '项目组' },
      ...['a', 'b', 'c'].map(id => ({ ...candidate(id), title: '项目组' })),
    ],
  })
  const results = [saved('b', '8'), saved('c', '9')]
  vi.mocked(api.startImport).mockImplementation(async () => {
    emit({ ...batch, status: 'committing', results: results.map(result => ({
      ...result, conversationId: null, status: 'staged', committedAt: null, inserted: 0,
    })) })
    return batch.jobId
  })
  emit(batch)
  localStorage.setItem('whomi:import-job', batch.jobId)
  render(<FileImport api={api} onOpenConversation={open} />)
  await userEvent.click(await screen.findByRole('checkbox', { name: '项目组 导出.json · 2 / 3' }))
  await userEvent.click(screen.getByRole('checkbox', { name: '项目组 导出.json · 3 / 3' }))
  await userEvent.click(screen.getByRole('button', { name: '导入所选会话' }))
  await userEvent.click(await screen.findByRole('button', { name: '查看导入状态' }))
  const rows = () => within(screen.getByRole('dialog')).getAllByRole('listitem')
  expect(rows().map(row => row.textContent)).toEqual(['项目组导出.json · 2 / 3待处理', '项目组导出.json · 3 / 3待处理'])
  act(() => emit({ ...batch, status: 'completed', inserted: 1000,
    results: [results[0], { ...results[1], matchedConversationTitle: '改名后的项目组' }] }))
  const completed = rows()
  expect(completed).toHaveLength(2)
  expect(within(completed[0]).getByText('导出.json · 2 / 3')).toBeVisible()
  expect(within(completed[1]).getByText('导出.json · 3 / 3')).toBeVisible()
  expect(within(completed[1]).getByRole('heading', { name: '发现已有会话：改名后的项目组' })).toBeVisible()
  await userEvent.click(within(completed[1]).getByRole('button', { name: '打开会话' }))
  expect(open).toHaveBeenCalledWith('9')
})
it.each([
  { button: '选择文件', kind: 'file', displayName: '聊天.json' },
  { button: '选择文件夹', kind: 'directory', displayName: '聊天目录' },
] as const)('$button 等待任务编号时禁用入口，解析时可以取消', async ({ button, kind, displayName }) => {
  const { api, emit } = fakeImportApi(), preparation = deferred<string>(), pending = deferred<string>()
  vi.mocked(api.chooseSources).mockResolvedValue([{ token: 'source', kind, displayName }])
  vi.mocked(api.prepareImport).mockReturnValue(preparation.promise)
  vi.mocked(api.startImport).mockImplementation(async () => { emit(snapshot({ status: 'staging', counts: { seen: 12, validRecords: 11, invalidRecords: 1 } })); return pending.promise })
  render(<FileImport api={api} />)
  await userEvent.click(screen.getByRole('button', { name: button }))
  await waitFor(() => expect(api.prepareImport).toHaveBeenCalledOnce())
  expect(screen.getByRole('button', { name: '选择文件' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '选择文件夹' })).toBeDisabled()
  expect(screen.queryByText('正在处理…')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '取消导入' })).not.toBeInTheDocument()
  await act(async () => { preparation.resolve('job') })
  expect(await screen.findByRole('progressbar')).not.toHaveAttribute('value')
  expect(screen.getByText(/已检查 12 条记录/)).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: '取消导入' }))
  expect(await screen.findByRole('button', { name: '选择文件' })).toBeVisible()
  expect(api.cancelImport).toHaveBeenCalledWith('job')
  await act(async () => { pending.resolve('job') })
  expect(screen.queryByText('已取消导入')).not.toBeInTheDocument()
})
it('保存失败结束进度，只保留查看日志和取消导入', async () => {
  const { api } = fakeImportApi(), original = vi.mocked(api.startImport).getMockImplementation()!
  vi.mocked(api.startImport).mockImplementationOnce(original).mockRejectedValueOnce({ code: 'WRITE_FAILED', action: '请释放磁盘空间后重试。' })
  render(<FileImport api={api} />)
  await userEvent.click(screen.getByRole('button', { name: '选择文件' }))
  expect(await screen.findByRole('heading', { name: '保存失败' })).toBeVisible()
  const workspace = within(screen.getByRole('region', { name: '文件导入' }))
  expect(workspace.getAllByRole('button').map(button => button.textContent)).toEqual(['查看错误日志', '取消导入'])
  expect(workspace.queryByRole('progressbar')).not.toBeInTheDocument()
  await userEvent.click(workspace.getByRole('button', { name: '取消导入' }))
  expect(await screen.findByRole('button', { name: '选择文件' })).toBeVisible()
})
it('批量保存时只在明细窗显示所选会话的状态，关闭后可取消该批次', async () => {
  const { api, emit } = fakeImportApi(), onSaved = vi.fn(), onOpen = vi.fn(), onCancelled = vi.fn()
  vi.mocked(api.startImport).mockResolvedValue('job')
  vi.mocked(api.cancelImport).mockImplementation(async () => { emit(snapshot({ status: 'cancelled' })) })
  render(<FileImport api={api} onSaved={onSaved} onOpenConversation={onOpen} onCancelled={onCancelled} />)
  await userEvent.click(screen.getByRole('button', { name: '选择文件' }))
  const partial = snapshot({ status: 'committing', candidates: ['a', 'b', 'c', '未选'].map(candidate), results: [
    saved('a', '7', { status: 'processed', committedAt: null, inserted: 320 }),
    saved('b', '8', { status: 'committing', committedAt: null, inserted: 0 }),
    saved('c', '9', { status: 'staged', committedAt: null, inserted: 0 }),
  ] })
  act(() => emit(partial)); act(() => emit({ ...partial }))
  expect(screen.queryByText('会话 a')).not.toBeInTheDocument()
  const trigger = screen.getByRole('button', { name: '查看导入状态' })
  await userEvent.click(trigger)
  const dialog = within(screen.getByRole('dialog', { name: '会话状态' }))
  expect(dialog.getAllByRole('listitem').map(row => row.textContent)).toEqual(['会话 a已处理', '会话 b处理中', '会话 c待处理'])
  expect(screen.queryByRole('button', { name: '打开会话' })).not.toBeInTheDocument()
  await userEvent.click(dialog.getByRole('button', { name: '关闭' }))
  expect(trigger).toHaveFocus()
  await userEvent.click(screen.getByRole('button', { name: '取消导入' }))
  expect(await screen.findByRole('button', { name: '选择文件' })).toHaveFocus()
  expect(onSaved).not.toHaveBeenCalled()
  expect(onCancelled).toHaveBeenCalledTimes(1)
})
it('缺少持久提交时间不能显示成功或打开入口', async () => {
  const { api, emit } = fakeImportApi(), onSaved = vi.fn()
  vi.mocked(api.startImport).mockResolvedValue('job')
  render(<FileImport api={api} onSaved={onSaved} />)
  await userEvent.click(screen.getByRole('button', { name: '选择文件' }))
  act(() => emit(snapshot({ status: 'completed', candidates: [candidate()], results: [saved('a', '7', { committedAt: null })] })))
  expect(await screen.findByRole('heading', { name: '无法确认保存结果' })).toBeVisible()
  expect(onSaved).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '打开会话' })).not.toBeInTheDocument()
})
it('结束升级前的部分完成记录，回到选择起点且不宣告撤回历史会话', async () => {
  const { api, emit } = fakeImportApi(), onCancelled = vi.fn()
  emit(snapshot({ status: 'partially_completed', candidates: [candidate()], results: [saved('a', '7')] }))
  vi.mocked(api.cancelImport).mockResolvedValue(undefined)
  localStorage.setItem('whomi:import-job', 'job')
  render(<FileImport api={api} onCancelled={onCancelled} />)

  await userEvent.click(await screen.findByRole('button', { name: '取消导入' }))
  expect(await screen.findByRole('button', { name: '选择文件' })).toHaveFocus()
  expect(localStorage.getItem('whomi:import-job')).toBeNull()
  expect(onCancelled).not.toHaveBeenCalled()
})
it('升级前部分完成任务的唯一已保存会话被删除后，仍可退出旧结果', async () => {
  const { api, emit } = fakeImportApi()
  emit(snapshot({ status: 'partially_completed', candidates: [candidate('a'), candidate('b')],
    results: [saved('b', '8', { status: 'failed', conversationId: null, committedAt: null, inserted: 0 })] }))
  // 旧版终态不参与整批回滚。
  vi.mocked(api.cancelImport).mockResolvedValue(undefined)
  localStorage.setItem('whomi:import-job', 'job')
  render(<FileImport api={api} />)
  await userEvent.click(await screen.findByRole('button', { name: '取消导入' }))
  expect(await screen.findByRole('button', { name: '选择文件' })).toHaveFocus()
  expect(localStorage.getItem('whomi:import-job')).toBeNull()
  expect(api.deleteConversation).not.toHaveBeenCalled()
})

it('恢复旧版空入口快照时把扫描器已经识别的错误写入日志', async () => {
  const { api, emit } = fakeImportApi()
  api.importDiagnostics = { report: vi.fn(async () => {}), open: vi.fn(async () => {}) }
  emit(snapshot({ status: 'awaiting_confirmation', discovery: { entries: [], unrecognized: [], issues: [
    { code: 'TAKEOUT_INCOMPLETE', action: '请重新导出完整记录。', severity: 'blocking', candidateId: '' },
  ] } }))
  localStorage.setItem('whomi:import-job', 'job')
  render(<FileImport api={api} />)
  await waitFor(() => expect(api.importDiagnostics!.report).toHaveBeenCalledExactlyOnceWith({
    jobId: 'job', phase: 'scan', code: 'TAKEOUT_INCOMPLETE',
  }))
})

it('恢复取消失败时展示本次清理错误，日志不复用先前的坏记录原因', async () => {
  const { api, emit } = fakeImportApi()
  api.importDiagnostics = { report: vi.fn(async () => {}), open: vi.fn(async () => {}) }
  const parseIssue = { code: 'invalid-record', severity: 'blocking' as const, candidateId: 'a', ordinal: 0, action: '请检查导出文件。' }
  const cancelIssue = { code: 'CANCEL_FAILED', severity: 'blocking' as const, candidateId: '', action: '请再次点击取消导入。' }
  emit(snapshot({ status: 'failed', failurePhase: 'cancel', issues: [cancelIssue],
    results: [saved('a', '7', { status: 'blocked', issues: [parseIssue], conversationId: null, committedAt: null })] }))
  localStorage.setItem('whomi:import-job', 'job')
  render(<ExceptionNoticeProvider><FileImport api={api} /></ExceptionNoticeProvider>)
  await screen.findByRole('heading', { name: '取消导入失败' })
  await userEvent.click(screen.getByRole('button', { name: '展开详情' }))
  expect(screen.getByText(cancelIssue.action)).toBeVisible()
  expect(screen.queryByText(parseIssue.action)).toBeNull()
  expect(api.importDiagnostics.report).toHaveBeenCalledExactlyOnceWith({ jobId: 'job', phase: 'cancel', code: cancelIssue.code })
})
it('保存进度显示真实处理数但不把未提交记录视为已保存', async () => {
  const { api, emit } = fakeImportApi()
  vi.mocked(api.startImport).mockResolvedValue('job')
  render(<FileImport api={api} />)
  await userEvent.click(screen.getByRole('button', { name: '选择文件' }))
  act(()=>emit(snapshot({status:'committing',progress:{processed:12,total:100}})))
  expect(await screen.findByRole('progressbar')).toHaveAttribute('value','12')
  expect(screen.getByRole('progressbar')).toHaveAttribute('max','100')
  expect(screen.getByText('已处理 12 / 100 条记录')).toBeVisible()
  expect(screen.queryByRole('button',{name:'打开会话'})).not.toBeInTheDocument()
})
it('解析失败只在异常卡片展示具体问题，正文不重复提示',async()=>{
  const {api,emit}=fakeImportApi()
  vi.mocked(api.startImport).mockResolvedValue('job')
  render(<ExceptionNoticeProvider><FileImport api={api}/></ExceptionNoticeProvider>)
  await userEvent.click(screen.getByRole('button',{name:'选择文件'}))
  const issues=[{code:'INVALID_RECORD',candidateId:'a',severity:'blocking' as const,ordinal:0,action:'第 1 条记录：请检查导出文件后重试。'},
    {code:'INCOMPLETE_PARSE',candidateId:'a',severity:'blocking' as const,action:'请检查导出文件后重试。'}]
  act(()=>emit(snapshot({status:'failed',candidates:[candidate()],issues,results:[saved('a','7',{status:'blocked',inserted:0,committedAt:null,issues})]})))
  await userEvent.click(await screen.findByRole('button', { name: '展开详情' }))
  expect(screen.getByText('第 1 条记录：请检查导出文件后重试。')).toBeVisible()
  expect(screen.queryByText('请检查导出文件后重试。',{exact:true})).not.toBeInTheDocument()
})
it('非阻断类型提示不进入异常卡片，同批失败隐藏临时保存结果', async () => {
  const { api, emit } = fakeImportApi()
  const firstWarning = { code: 'unknown-type', candidateId: 'a', severity: 'warning' as const, ordinal: 1, action: '第 2 条记录：消息类型无法识别，请核对保留的原文。' }
  const nextWarning = { ...firstWarning, ordinal: 3, action: '第 4 条记录：消息类型无法识别，请核对来源文件。' }
  const duplicateWarning = { ...firstWarning, candidateId: 'b' }
  const failedWarning = { ...firstWarning, candidateId: 'c' }
  const mixedWarning = { ...firstWarning, candidateId: 'd' }
  const failure = { code: 'COMMIT_FAILED', candidateId: 'c', severity: 'blocking' as const, action: '保存失败，请重新导入。' }
  const typeWarning = /消息类型无法识别/

  vi.mocked(api.startImport).mockResolvedValue('job')
  render(<ExceptionNoticeProvider><FileImport api={api} /></ExceptionNoticeProvider>)
  await userEvent.click(screen.getByRole('button', { name: '选择文件' }))
  act(() => emit(snapshot({
    status: 'committing',
    candidates: [candidate('a')],
    issues: [nextWarning],
    results: [saved('a', '7', { status: 'staged', inserted: 0, committedAt: null, issues: [firstWarning] })],
  })))
  expect(await screen.findByRole('progressbar')).toBeVisible()
  expect(screen.queryByText('已解析，尚未保存')).not.toBeInTheDocument()
  expect(screen.queryByRole('list')).not.toBeInTheDocument()
  expect(screen.queryByText(typeWarning)).not.toBeInTheDocument()

  act(() => emit(snapshot({
    status: 'partially_completed',
    candidates: ['a', 'b', 'c', 'd'].map(candidate),
    issues: [firstWarning, duplicateWarning, failedWarning, mixedWarning],
    results: [
      saved('a', '7', { inserted: 3, issues: [firstWarning, nextWarning] }),
      saved('b', '8', { status: 'duplicate', inserted: 0, duplicates: 3, issues: [duplicateWarning] }),
      saved('c', '9', { status: 'failed', inserted: 0, committedAt: null, issues: [failure] }),
      saved('d', '10', { inserted: 2, duplicates: 1, issues: [mixedWarning] }),
    ],
  })))
  await userEvent.click(await screen.findByRole('button', { name: '展开详情' }))
  expect(screen.getByText(failure.action)).toBeVisible()
  expect(screen.queryByRole('button', { name: '打开会话' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '重新选择失败的来源' })).not.toBeInTheDocument()
  expect(screen.queryByText(typeWarning)).not.toBeInTheDocument()
})
it('没有可导入会话时隐藏未识别文件并提供日志和取消操作', async () => {
  const { api } = fakeImportApi()
  vi.mocked(api.prepareImport).mockResolvedValue('job')
  vi.mocked(api.getImport).mockResolvedValue(snapshot({ discovery: { entries: [], unrecognized: [{ displayName: 'invalid.json' }], issues: [] } }))
  render(<FileImport api={api} />)
  await userEvent.click(screen.getByRole('button', { name: '选择文件' }))
  expect(await screen.findByRole('heading', { name: '没有可导入的会话' })).toBeVisible()
  expect(screen.queryByText('invalid.json')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '查看错误日志' })).toBeVisible()
  expect(screen.getByRole('button', { name: '取消导入' })).toBeVisible()
})
it('拖入真实文件自动开始，阻止窗口导航到文件', async () => {
  const { api } = fakeImportApi()
  render(<FileImport api={api} />)
  const file = new File(['虚构'], '记录.json')
  fireEvent.drop(screen.getByRole('region', { name: '文件导入' }), { dataTransfer: { files: [file], types: ['Files'], items: [] } })
  expect(await screen.findByText('已保存 500 条消息。')).toBeVisible()
  expect(api.acceptDroppedFiles).toHaveBeenCalledWith([file])
  const event = new Event('drop', { cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'] } }); window.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
})

it('选择窗口等待期间仍显示拖放反馈，晚到选择不会覆盖结果', async () => {
  const { api } = fakeImportApi()
  const picker = deferred<Awaited<ReturnType<typeof api.chooseSources>>>()
  vi.mocked(api.chooseSources).mockReturnValue(picker.promise)
  render(<FileImport api={api} />)
  await userEvent.click(screen.getByRole('button', { name: '选择文件' }))
  const region = screen.getByRole('region', { name: '文件导入' })
  const file = new File(['虚构'], '记录.json')
  const dataTransfer = { files: [file], types: ['Files'], items: [] }
  fireEvent.dragEnter(region, { dataTransfer })
  expect(screen.getByRole('button', { name: '松开以导入聊天记录' })).toBeVisible()
  fireEvent.drop(region, { dataTransfer })
  expect(await screen.findByText('已保存 500 条消息。')).toBeVisible()
  await act(async () => { picker.resolve([{ token: 'late', displayName: '后来选中的文件', kind: 'file' }]) })
  expect(api.prepareImport).toHaveBeenCalledExactlyOnceWith([{ token: 'drop', displayName: '记录.json', kind: 'file' }])
})
