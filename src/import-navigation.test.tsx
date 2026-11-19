import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import App from './App'
import { candidate, deferred, fakeImportApi, saved, snapshot } from './test/import-api'

it('选择窗口失败后切页仍保留提醒、日志和取消入口', async () => {
  const user = userEvent.setup()
  const { api } = fakeImportApi()
  api.importDiagnostics = { report: vi.fn(async () => {}), open: vi.fn(async () => {}) }
  vi.mocked(api.chooseSources).mockRejectedValueOnce(new Error('picker unavailable'))
  render(<App importApi={api} />)
  await user.click(screen.getByRole('button', { name: '导入会话' }))
  await user.click(screen.getByRole('button', { name: '选择文件' }))
  await screen.findByRole('heading', { name: '无法打开选择窗口' })
  await user.click(screen.getByRole('button', { name: '个人总览' }))
  expect(screen.getByRole('region', { name: '异常提醒' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: '导入会话' }))
  await user.click(await screen.findByRole('button', { name: '查看错误日志' }))
  expect(api.importDiagnostics.open).toHaveBeenCalledExactlyOnceWith(null)
  expect(api.importDiagnostics.report).toHaveBeenCalledTimes(1)
  await user.click(screen.getByRole('button', { name: '取消导入' }))
  expect(await screen.findByRole('button', { name: '选择文件' })).toBeEnabled()
  expect(screen.queryByRole('region', { name: '异常提醒' })).toBeNull()
})

it('重新进入导入页沿用尚未返回的文件选择，并接收首次确认', async () => {
  const user = userEvent.setup()
  const { api } = fakeImportApi()
  const picker = deferred<Awaited<ReturnType<typeof api.chooseSources>>>()
  vi.mocked(api.chooseSources).mockReturnValue(picker.promise)
  render(<App importApi={api} />)
  const openImport = () => user.click(screen.getByRole('button', { name: '导入会话' }))
  await openImport()
  await user.click(screen.getByRole('button', { name: '选择文件' }))
  await user.click(screen.getByRole('button', { name: '个人总览' }))
  await openImport()
  await user.click(screen.getByRole('button', { name: '选择文件' }))
  expect(api.chooseSources).toHaveBeenCalledTimes(1)
  const handles = [{ token: 'first', displayName: 'result.json', kind: 'file' as const }]
  await act(async () => picker.resolve(handles))
  expect(await screen.findByText('导入完成')).toBeVisible()
  expect(api.prepareImport).toHaveBeenCalledExactlyOnceWith(handles)
})

it('重启直接在首页看到中断提醒，处理并取消后清除', async () => {
  const user = userEvent.setup()
  const { api, emit } = fakeImportApi()
  localStorage.setItem('whomi:import-job', 'job')
  emit(snapshot({ status: 'failed', failurePhase: 'parse', issues: [
    { code: 'INTERRUPTED', action: '请重新导入。', severity: 'blocking', candidateId: '' },
  ] }))
  render(<App importApi={api} />)
  const notices = await screen.findByRole('region', { name: '异常提醒' })
  await user.click(within(notices).getByRole('button', { name: '展开详情' }))
  expect(within(notices).getByText('请重新导入。')).toBeVisible()
  await user.click(screen.getByRole('button', { name: '导入会话' }))
  await user.click(await screen.findByRole('button', { name: '取消导入' }))
  expect(await screen.findByRole('button', { name: '选择文件' })).toBeEnabled()
  expect(screen.queryByRole('region', { name: '异常提醒' })).toBeNull()
})

it('文件选择窗口在总览上确认，自动解析并保存唯一会话', async () => {
  const user = userEvent.setup()
  const { api } = fakeImportApi()
  const picker = deferred<Awaited<ReturnType<typeof api.chooseSources>>>()
  vi.mocked(api.chooseSources).mockReturnValue(picker.promise)
  render(<App importApi={api} />)
  await user.click(screen.getByRole('button', { name: '导入会话' }))
  await user.click(screen.getByRole('button', { name: '选择文件' }))
  await user.click(screen.getByRole('button', { name: '个人总览' }))
  await act(async () => picker.resolve([{ token: 'file', displayName: '记录.json', kind: 'file' }]))
  await waitFor(() => expect(api.startImport).toHaveBeenCalledTimes(2))
  expect(vi.mocked(api.startImport).mock.calls.map(([request]) => request.kind)).toEqual(['stage', 'commit'])
})

it('恢复存储不可写时，侧栏导入仍保留当前待确认会话', async () => {
  const user = userEvent.setup()
  const { api, emit } = fakeImportApi()
  const setItem = Storage.prototype.setItem
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key === 'whomi:import-job') throw new Error('storage unavailable')
    setItem.call(this, key, value)
  })
  vi.mocked(api.startImport).mockImplementation(async () => {
    emit(snapshot({ status: 'awaiting_commit', candidates: [candidate(), candidate('b')] }))
    return 'job'
  })
  render(<App importApi={api} />)
  const openImport = () => user.click(screen.getByRole('button', { name: '导入会话' }))
  await openImport()
  await user.click(screen.getByRole('button', { name: '选择文件' }))
  await screen.findByRole('checkbox', { name: '会话 a' })
  await user.click(screen.getByRole('button', { name: '个人总览' }))
  await openImport()
  expect(await screen.findByRole('checkbox', { name: '会话 b' })).toBeVisible()
  expect(api.prepareImport).toHaveBeenCalledTimes(1)
})

it.each([null, 'previous'])('窗口收到任务编号前退出，重启后从数据库恢复扫描中断（旧编号 %s）', async stored => {
  const user = userEvent.setup()
  const { api, emit } = fakeImportApi()
  if (stored) localStorage.setItem('whomi:import-job', stored)
  vi.mocked(api.getInterruptedImport).mockResolvedValue('interrupted')
  emit(snapshot({ jobId: 'interrupted', status: 'failed', failurePhase: 'scan', issues: [
    { code: 'INTERRUPTED', action: '请重新导入。', severity: 'blocking', candidateId: '' },
  ] }))
  render(<App importApi={api} />)
  expect(await screen.findByRole('region', { name: '异常提醒' })).toBeVisible()
  expect(api.getImport).toHaveBeenCalledExactlyOnceWith('interrupted')
  expect(localStorage.getItem('whomi:import-job')).toBe('interrupted')
  await user.click(screen.getByRole('button', { name: '导入会话' }))
  await user.click(await screen.findByRole('button', { name: '取消导入' }))
  expect(api.cancelImport).toHaveBeenCalledExactlyOnceWith('interrupted')
  expect(await screen.findByRole('button', { name: '选择文件' })).toBeEnabled()
  expect(localStorage.getItem('whomi:import-job')).toBeNull()
})

it('新的导入已结束时，重启不再显示缓存中更早的中断任务', async () => {
  const { api, emit } = fakeImportApi()
  localStorage.setItem('whomi:import-job', 'old')
  vi.mocked(api.getInterruptedImport).mockResolvedValue(null)
  emit(snapshot({ jobId: 'old', status: 'failed', failurePhase: 'scan', issues: [
    { code: 'INTERRUPTED', action: '请重新导入。', severity: 'blocking', candidateId: '' },
  ] }))
  render(<App importApi={api} />)
  await waitFor(() => expect(localStorage.getItem('whomi:import-job')).toBeNull())
  expect(screen.queryByRole('region', { name: '异常提醒' })).toBeNull()
})

it('保存过程中切到总览，提交后侧栏会话列表只刷新一次', async () => {
  const user = userEvent.setup()
  const { api, emit } = fakeImportApi()
  const saving = deferred<string>()
  vi.mocked(api.startImport).mockImplementation(async request => {
    if (request.kind === 'stage') { emit(snapshot({ status: 'awaiting_commit', candidates: [candidate()] })); return 'job' }
    emit(snapshot({ status: 'committing' }))
    return saving.promise
  })
  render(<App importApi={api} />)
  await user.click(screen.getByRole('button', { name: '导入会话' }))
  await user.click(screen.getByRole('button', { name: '选择文件' }))
  await waitFor(() => expect(api.startImport).toHaveBeenCalledTimes(2))
  await user.click(screen.getByRole('button', { name: '个人总览' }))
  await user.click(screen.getByRole('button', { name: '展开会话列表' }))
  const initialReads = vi.mocked(api.listConversations).mock.calls.length
  vi.mocked(api.listConversations).mockResolvedValue({ items: [{ id: '7', title: '刚导入的会话', kind: 'direct',
    messageCount: 500, memberCount: 2, firstSentAtMs: null, lastSentAtMs: null, summaryStatus: 'ready' }], nextCursor: null })
  const complete = snapshot({ status: 'completed', results: [saved('a', '7')] })
  await act(async () => { emit(complete); saving.resolve('job') })
  expect(await screen.findByRole('button', { name: /刚导入的会话/ })).toBeVisible()
  await act(async () => emit(complete))
  expect(api.listConversations).toHaveBeenCalledTimes(initialReads + 1)
})

it('导入页打开时删除已保存的唯一会话，过期的打开入口消失', async () => {
  const user = userEvent.setup()
  const { api } = fakeImportApi()
  let deleted!: (id: string) => void
  api.onConversationDeleted = listener => { deleted = listener; return () => {} }
  render(<App importApi={api} />)
  await user.click(screen.getByRole('button', { name: '导入会话' }))
  await user.click(screen.getByRole('button', { name: '选择文件' }))
  await screen.findByRole('button', { name: '打开会话' })
  vi.mocked(api.getImport).mockRejectedValue({ code: 'IMPORT_RESULT_REMOVED', action: '导入结果已删除。' })
  await act(async () => deleted('7'))
  expect(await screen.findByRole('button', { name: '选择文件' })).toBeEnabled()
  expect(screen.queryByRole('button', { name: '打开会话' })).toBeNull()
})
