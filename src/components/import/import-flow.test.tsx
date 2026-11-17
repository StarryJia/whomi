import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { FileImport } from '../file-import'
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
    candidates: [{ ...candidate('a'), title: '示例导出标题' }, { ...candidate('b'), title: '示例新会话' }, candidate('c')],
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

  expect(await screen.findByRole('heading', { name: '发现已有会话：示例联系人 已更新' })).toBeVisible()
  expect(screen.queryByRole('heading', { name: '示例导出标题' })).not.toBeInTheDocument()
  expect(screen.getByRole('heading', { name: '示例新会话' })).toBeVisible()
  expect(screen.getByRole('heading', { name: '发现已有会话：未命名会话 已更新' })).toBeVisible()
  expect(screen.getByText('新增 0 条消息，重复 100 条。')).toBeVisible()
  expect(screen.getByText('已保存 2 条消息。')).toBeVisible()
  expect(screen.getByText('跳过重复 1 条。')).toBeVisible()
  expect(screen.queryByText(warning.action)).not.toBeInTheDocument()
  await userEvent.click(screen.getAllByRole('button', { name: '打开会话' })[0])
  expect(onOpen).toHaveBeenCalledWith('7')
  await userEvent.click(screen.getByRole('button', { name: '继续导入' }))
  expect(screen.getByRole('button', { name: '选择文件' })).toBeVisible()
})
it('多入口保留选择且不显示技术格式名', async () => {
  const { api } = fakeImportApi()
  vi.mocked(api.prepareImport).mockResolvedValue('job')
  vi.mocked(api.getImport).mockResolvedValue(snapshot({ discovery: { entries: [
    { entryId: 'one', displayName: '朋友记录.json', formatId: 'chatlab' },
    { entryId: 'two', displayName: '家人记录.json', formatId: 'chatlab-jsonl' },
  ], unrecognized: [], issues: [] } }))
  render(<FileImport api={api} />)
  await userEvent.click(screen.getByRole('button', { name: '选择文件夹' }))
  await userEvent.click(await screen.findByRole('checkbox', { name: '家人记录.json' }))
  expect(screen.queryByText('chatlab-jsonl')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '解析所选入口' }))
  await waitFor(() => expect(api.startImport).toHaveBeenCalledWith({ kind: 'stage', jobId: 'job', entryIds: ['two'] }))
})
it('等待解析显示不定进度和真实计数，取消立即恢复起点', async () => {
  const { api, emit } = fakeImportApi(), pending = deferred<string>()
  vi.mocked(api.startImport).mockImplementation(async () => { emit(snapshot({ status: 'staging', counts: { seen: 12, validRecords: 11, invalidRecords: 1 } })); return pending.promise })
  render(<FileImport api={api} />)
  await userEvent.click(screen.getByRole('button', { name: '选择文件' }))
  expect(await screen.findByRole('progressbar')).not.toHaveAttribute('value')
  expect(screen.getByText(/已检查 12 条记录/)).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: '取消导入' }))
  expect(await screen.findByRole('button', { name: '选择文件' })).toBeVisible()
  expect(api.cancelImport).toHaveBeenCalledWith('job')
  await act(async () => { pending.resolve('job') })
  expect(screen.queryByText('已取消导入')).not.toBeInTheDocument()
})
it('保存失败保留恢复入口并可重试', async () => {
  const { api } = fakeImportApi(), original = vi.mocked(api.startImport).getMockImplementation()!
  vi.mocked(api.startImport).mockImplementationOnce(original).mockRejectedValueOnce({ code: 'WRITE_FAILED', action: '请释放磁盘空间后重试。' })
  render(<FileImport api={api} />)
  await userEvent.click(screen.getByRole('button', { name: '选择文件' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('请释放磁盘空间后重试。')
  expect(screen.queryByRole('button', { name: '打开会话' })).not.toBeInTheDocument()
  vi.mocked(api.startImport).mockImplementation(original)
  await userEvent.click(screen.getByRole('button', { name: '重试保存' }))
  expect(await screen.findByText('已保存 500 条消息。')).toBeVisible()
})
it('部分成功后取消保留真实成果，重复通知不重复回报', async () => {
  const { api, emit } = fakeImportApi(), onSaved = vi.fn(), onOpen = vi.fn()
  vi.mocked(api.startImport).mockResolvedValue('job')
  render(<FileImport api={api} onSaved={onSaved} onOpenConversation={onOpen} />)
  await userEvent.click(screen.getByRole('button', { name: '选择文件' }))
  const partial = snapshot({ status: 'committing', candidates: [candidate('a'), candidate('b')], results: [saved('a', '7', { inserted: 320 }), saved('b', '8', { status: 'cancelled', committedAt: null, inserted: 0 })] })
  act(() => emit(partial)); act(() => emit({ ...partial }))
  await userEvent.click(screen.getByRole('button', { name: '取消导入' }))
  expect(await screen.findByText('已取消剩余导入')).toBeVisible()
  expect(screen.getByText('已保存 320 条消息。')).toBeVisible()
  expect(onSaved).toHaveBeenCalledTimes(1)
  await userEvent.click(screen.getByRole('button', { name: '打开会话' }))
  expect(onOpen).toHaveBeenCalledWith('7')
})
it('缺少持久提交时间不能显示成功或打开入口', async () => {
  const { api, emit } = fakeImportApi(), onSaved = vi.fn()
  vi.mocked(api.startImport).mockResolvedValue('job')
  render(<FileImport api={api} onSaved={onSaved} />)
  await userEvent.click(screen.getByRole('button', { name: '选择文件' }))
  act(() => emit(snapshot({ status: 'partially_completed', candidates: [candidate()], results: [saved('a', '7', { committedAt: null })] })))
  expect(await screen.findByText('请重新查询保存结果。')).toBeVisible()
  expect(onSaved).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '打开会话' })).not.toBeInTheDocument()
})
it('保存进度显示真实处理数但不把未提交记录视为已保存', async () => {
  const { api, emit } = fakeImportApi()
  vi.mocked(api.startImport).mockResolvedValue('job')
  render(<FileImport api={api} />)
  await userEvent.click(screen.getByRole('button', { name: '选择文件' }))
  act(()=>emit(snapshot({status:'committing',progress:{processed:12,total:100}})))
  expect(await screen.findByRole('progressbar')).toHaveAttribute('value','12')
  expect(screen.getByRole('progressbar')).toHaveAttribute('max','100')
  expect(screen.getByText('已处理 12 / 100 条记录 · 已保存 0 条')).toBeVisible()
  expect(screen.queryByRole('button',{name:'打开会话'})).not.toBeInTheDocument()
})
it('解析失败只就近展示具体问题，不重复同一操作提示',async()=>{
  const {api,emit}=fakeImportApi()
  vi.mocked(api.startImport).mockResolvedValue('job')
  render(<FileImport api={api}/>);await userEvent.click(screen.getByRole('button',{name:'选择文件'}))
  const issues=[{code:'INVALID_RECORD',candidateId:'a',severity:'blocking' as const,ordinal:0,action:'第 1 条记录：请检查导出文件后重试。'},
    {code:'INCOMPLETE_PARSE',candidateId:'a',severity:'blocking' as const,action:'请检查导出文件后重试。'}]
  act(()=>emit(snapshot({status:'failed',candidates:[candidate()],issues,results:[saved('a','7',{status:'blocked',inserted:0,committedAt:null,issues})]})))
  expect(await screen.findByText('第 1 条记录：请检查导出文件后重试。')).toBeVisible()
  expect(screen.queryByText('请检查导出文件后重试。',{exact:true})).not.toBeInTheDocument()
})
it('保存过程和结果省略解析提示，保留真实条数与失败操作', async () => {
  const { api, emit } = fakeImportApi()
  const firstWarning = { code: 'unknown-type', candidateId: 'a', severity: 'warning' as const, ordinal: 1, action: '第 2 条记录：消息类型无法识别，请核对保留的原文。' }
  const nextWarning = { ...firstWarning, ordinal: 3, action: '第 4 条记录：消息类型无法识别，请核对来源文件。' }
  const duplicateWarning = { ...firstWarning, candidateId: 'b' }
  const failedWarning = { ...firstWarning, candidateId: 'c' }
  const mixedWarning = { ...firstWarning, candidateId: 'd' }
  const failure = { code: 'COMMIT_FAILED', candidateId: 'c', severity: 'blocking' as const, action: '保存失败，请重新导入。' }
  const typeWarning = /消息类型无法识别/

  vi.mocked(api.startImport).mockResolvedValue('job')
  render(<FileImport api={api} />)
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
  const [savedItem, duplicateItem, failedItem, mixedItem] = screen.getAllByRole('listitem')
  expect(within(savedItem).getByText('已保存 3 条消息。')).toBeVisible()
  expect(within(duplicateItem).getByText('新增 0 条消息，重复 3 条。')).toBeVisible()
  expect(within(mixedItem).getByText('跳过重复 1 条。')).toBeVisible()
  expect(within(failedItem).getByText(failure.action)).toHaveClass('import-error')
  expect(screen.getByRole('button', { name: '重新选择失败的来源' })).toBeVisible()
  expect(screen.queryByText(typeWarning)).not.toBeInTheDocument()
})
it('没有入口时提供具体文件和重新选择操作', async () => {
  const { api } = fakeImportApi()
  vi.mocked(api.prepareImport).mockResolvedValue('job')
  vi.mocked(api.getImport).mockResolvedValue(snapshot({ discovery: { entries: [], unrecognized: [{ displayName: 'invalid.json' }], issues: [] } }))
  render(<FileImport api={api} />)
  await userEvent.click(screen.getByRole('button', { name: '选择文件' }))
  expect(await screen.findByText('invalid.json')).toBeVisible()
  expect(screen.getByRole('button', { name: '重新选择文件' })).toBeVisible()
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
