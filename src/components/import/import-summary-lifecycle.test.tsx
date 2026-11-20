import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { FileImport } from '../file-import'
import { ExceptionNoticeProvider } from '../ui/exception-notices'
import { candidate, fakeImportApi, saved, snapshot } from '../../test/import-api'

function setup(result: ReturnType<typeof saved>) {
  const { api, emit } = fakeImportApi()
  const start = vi.mocked(api.startImport).getMockImplementation()!
  vi.mocked(api.startImport).mockImplementation(async request => {
    if (request.kind === 'stage') return start(request)
    emit(snapshot({ status: 'completed', candidates: [candidate()], results: [result], inserted: 500 }))
    return 'job'
  })
  vi.mocked(api.cancelImport).mockImplementation(async () => {
    emit(snapshot({ status: 'cancelled' }))
  })
  const diagnostics = { report: vi.fn(async () => {}), open: vi.fn(async () => {}) }
  const onSaved = vi.fn(), onCancelled = vi.fn()
  render(<ExceptionNoticeProvider>
    <FileImport api={{ ...api, importDiagnostics: diagnostics }} onSaved={onSaved} onCancelled={onCancelled} />
  </ExceptionNoticeProvider>)
  return { api, diagnostics, onSaved, onCancelled, user: userEvent.setup() }
}

test.each([
  { title: '会话统计更新失败', phase: 'statistics', code: 'STATISTICS_FAILED', patch: { summaryFailed: true } },
  { title: '无法确认保存结果', phase: 'confirm', code: 'SAVE_CONFIRMATION_MISSING', patch: { committedAt: null } },
] as const)('$title 时记录对应日志，取消后还可发起新任务', async ({ title, phase, code, patch }) => {
  const { api, diagnostics, onSaved, onCancelled, user } = setup(saved('a', '7', patch))
  await user.click(screen.getByRole('button', { name: '选择文件' }))

  expect(await screen.findByRole('heading', { name: title })).toBeVisible()
  const workspace = within(screen.getByRole('region', { name: '文件导入' }))
  expect(workspace.getAllByRole('button').map(button => button.textContent)).toEqual(['查看错误日志', '取消导入'])
  expect(workspace.queryByText('导入完成')).not.toBeInTheDocument()
  expect(onSaved).not.toHaveBeenCalled()
  if (phase === 'statistics') {
    await user.click(screen.getByRole('button', { name: '展开详情' }))
    expect(screen.getByText('消息数、成员数和起止时间未能保存。请查看错误日志。')).toBeVisible()
  }
  await user.click(workspace.getByRole('button', { name: '查看错误日志' }))
  expect(diagnostics.report).toHaveBeenCalledExactlyOnceWith({ phase, code, jobId: 'job' })
  expect(diagnostics.open).toHaveBeenCalledExactlyOnceWith('job')
  expect(diagnostics.report.mock.invocationCallOrder[0]).toBeLessThan(diagnostics.open.mock.invocationCallOrder[0])

  await user.click(workspace.getByRole('button', { name: '取消导入' }))
  expect(await screen.findByRole('button', { name: '选择文件' })).toHaveFocus()
  expect(api.cancelImport).toHaveBeenCalledExactlyOnceWith('job')
  expect(onCancelled).toHaveBeenCalledOnce()
})

test('日志无法打开时更新同一张异常卡片，仍可取消导入', async () => {
  const { diagnostics, user } = setup(saved('a', '7', { summaryFailed: true }))
  diagnostics.open.mockRejectedValueOnce({ code: 'IMPORT_LOG_NOT_FOUND', action: '找不到本次错误日志。' })
  await user.click(screen.getByRole('button', { name: '选择文件' }))
  await user.click(await screen.findByRole('button', { name: '展开详情' }))
  await user.click(screen.getByRole('button', { name: '查看错误日志' }))
  expect(await screen.findByText(/找不到本次错误日志/)).toBeVisible()
  expect(screen.getAllByRole('alert')).toHaveLength(1)
  expect(screen.getByRole('button', { name: '取消导入' })).toBeEnabled()
})

test('写入错误日志失败后，可以通过查看入口再写入并打开', async () => {
  const { diagnostics, user } = setup(saved('a', '7', { summaryFailed: true }))
  diagnostics.report.mockRejectedValueOnce(new Error('disk unavailable'))
  await user.click(screen.getByRole('button', { name: '选择文件' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('错误日志不可用')

  await user.click(screen.getByRole('button', { name: '查看错误日志' }))
  expect(diagnostics.report).toHaveBeenCalledTimes(2)
  expect(diagnostics.open).toHaveBeenCalledExactlyOnceWith('job')
  expect(screen.getByRole('alert')).toHaveTextContent('导入遇到问题')
})

test('安装日志目录只读时可从任务打开已有记录，找不到时显示实际路径', async () => {
  const { diagnostics, user } = setup(saved('a', '7', { summaryFailed: true }))
  const action = '无法写入安装日志目录 C:\\Whomi\\logs。请检查目录写入权限后重试。'
  diagnostics.report.mockRejectedValue({ code: 'IMPORT_LOG_WRITE_FAILED', action })
  await user.click(screen.getByRole('button', { name: '选择文件' }))
  await screen.findByRole('heading', { name: '会话统计更新失败' })
  const open = screen.getByRole('button', { name: '查看错误日志' })
  await user.click(open)
  expect(diagnostics.open).toHaveBeenCalledExactlyOnceWith('job')
  diagnostics.open.mockRejectedValueOnce({ code: 'IMPORT_LOG_MISSING', action: '找不到错误日志。' })
  await user.click(open)
  await user.click(screen.getByRole('button', { name: '展开详情' }))
  expect(await screen.findByText(action, { exact: false })).toBeVisible()
})

test('取消导入失败保留任务和日志入口，再次取消确认后返回起点', async () => {
  const { api, diagnostics, user, onCancelled } = setup(saved('a', '7', { summaryFailed: true }))
  vi.mocked(api.cancelImport).mockRejectedValueOnce(new Error('storage write failed'))
  await user.click(screen.getByRole('button', { name: '选择文件' }))
  await screen.findByRole('heading', { name: '会话统计更新失败' })
  await user.click(screen.getByRole('button', { name: '取消导入' }))
  expect(await screen.findByRole('heading', { name: '取消导入失败' })).toBeVisible()
  expect(localStorage.getItem('whomi:import-job')).toBe('job')
  expect(onCancelled).not.toHaveBeenCalled()

  await user.click(screen.getByRole('button', { name: '查看错误日志' }))
  expect(diagnostics.open).toHaveBeenLastCalledWith('job')
  await user.click(screen.getByRole('button', { name: '取消导入' }))
  await waitFor(() => expect(onCancelled).toHaveBeenCalledOnce())
  expect(screen.getByRole('button', { name: '选择文件' })).toBeVisible()
})

test('来源窗口失败时打开本次无任务编号的日志，取消无需调用后台任务', async () => {
  const { api, diagnostics, user } = setup(saved('a', '7'))
  vi.mocked(api.chooseSources).mockRejectedValueOnce(new Error('raw path details'))
  await user.click(screen.getByRole('button', { name: '选择文件' }))
  expect(await screen.findByRole('heading', { name: '无法打开选择窗口' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: '查看错误日志' }))
  expect(diagnostics.report).toHaveBeenCalledExactlyOnceWith({ phase: 'source', code: 'PICKER_FAILED' })
  expect(diagnostics.open).toHaveBeenCalledExactlyOnceWith(null)
  expect(screen.queryByText(/raw path/)).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '取消导入' }))
  expect(screen.getByRole('button', { name: '选择文件' })).toHaveFocus()
  expect(api.cancelImport).not.toHaveBeenCalled()
})

test('取消有编号的失败任务后直接重新选择文件，选择窗口错误使用本次无编号日志', async () => {
  const { api, diagnostics, user, onCancelled } = setup(saved('a', '7', { summaryFailed: true }))
  await user.click(screen.getByRole('button', { name: '选择文件' }))
  await screen.findByRole('heading', { name: '会话统计更新失败' })
  expect(diagnostics.report).toHaveBeenCalledWith({ phase: 'statistics', code: 'STATISTICS_FAILED', jobId: 'job' })
  await user.click(screen.getByRole('button', { name: '取消导入' }))
  expect(onCancelled).toHaveBeenCalledOnce()
  vi.mocked(api.chooseSources).mockRejectedValueOnce(new Error('picker unavailable'))
  await user.click(await screen.findByRole('button', { name: '选择文件' }))
  expect(await screen.findByRole('heading', { name: '无法打开选择窗口' })).toBeVisible()

  expect(diagnostics.report).toHaveBeenLastCalledWith({ phase: 'source', code: 'PICKER_FAILED' })
  await user.click(screen.getByRole('button', { name: '查看错误日志' }))
  expect(diagnostics.open).toHaveBeenCalledExactlyOnceWith(null)
  await user.click(screen.getByRole('button', { name: '取消导入' }))
  expect(await screen.findByRole('button', { name: '选择文件' })).toHaveFocus()
  expect(api.cancelImport).toHaveBeenCalledExactlyOnceWith('job')
  expect(localStorage.getItem('whomi:import-job')).toBeNull()
})
