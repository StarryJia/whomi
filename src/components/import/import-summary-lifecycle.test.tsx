import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { FileImport } from '../file-import'
import { useImport } from '../../data/use-import'
import { candidate, fakeImportApi, saved, snapshot } from '../../test/import-api'

function setup() {
  const { api, emit } = fakeImportApi()
  const start = vi.mocked(api.startImport).getMockImplementation()!
  vi.mocked(api.startImport).mockImplementation(async request => {
    const jobId = await start(request)
    if (request.kind === 'commit') emit(snapshot({
      status: 'completed', candidates: [candidate()], inserted: 500,
      results: [saved('a', '7', { summaryFailed: true })],
    }))
    return jobId
  })
  render(<FileImport api={api} />)
  return { api, user: userEvent.setup() }
}

test('摘要重试失败在已保存结果旁显示恢复提示', async () => {
  const { api, user } = setup()
  vi.mocked(api.retrySummary).mockRejectedValue({ code: 'SUMMARY_FAILED', action: '摘要更新失败，请重试。' })
  await user.click(screen.getByRole('button', { name: '选择文件' }))
  await user.click(await screen.findByRole('button', { name: '重试摘要' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('摘要更新失败，请重试。')
  expect(screen.getByText('已保存 500 条消息。')).toBeVisible()
  expect(screen.getByRole('button', { name: '重试摘要' })).toBeEnabled()

  vi.mocked(api.retrySummary).mockResolvedValue(undefined)
  await user.click(screen.getByRole('button', { name: '重试摘要' }))
  expect(await screen.findByText('摘要已更新。')).toBeVisible()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('继续导入后忽略上一批摘要重试的迟到失败', async () => {
  const { api, user } = setup()
  let fail!: (reason: unknown) => void
  vi.mocked(api.retrySummary).mockReturnValue(new Promise<void>((_resolve, reject) => { fail = reject }))
  await user.click(screen.getByRole('button', { name: '选择文件' }))
  await user.click(await screen.findByRole('button', { name: '重试摘要' }))
  await user.click(screen.getByRole('button', { name: '继续导入' }))
  expect(screen.getByRole('button', { name: '选择文件' })).toBeVisible()

  await act(async () => { fail({ code: 'SUMMARY_FAILED', action: '上一批摘要更新失败，请重试。' }) })

  expect(screen.getByRole('button', { name: '选择文件' })).toBeEnabled()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('摘要更新中不重复提交，失败后恢复重试且继续导入始终可用', async () => {
  const { api, user } = setup()
  let fail!: (reason: unknown) => void
  vi.mocked(api.retrySummary).mockReturnValue(new Promise<void>((_resolve, reject) => { fail = reject }))
  await user.click(screen.getByRole('button', { name: '选择文件' }))
  await user.dblClick(await screen.findByRole('button', { name: '重试摘要' }))

  expect(api.retrySummary).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: '正在更新…' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '继续导入' })).toBeEnabled()
  await act(async () => { fail({ code: 'SUMMARY_FAILED', action: '摘要更新失败，请重试。' }) })
  expect(screen.getByRole('button', { name: '重试摘要' })).toBeEnabled()

  vi.mocked(api.retrySummary).mockResolvedValue(undefined)
  await user.click(screen.getByRole('button', { name: '重试摘要' }))
  expect(await screen.findByText('摘要已更新。')).toBeVisible()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('同一批事件内的重复摘要请求只执行一次', async () => {
  const { api, emit } = fakeImportApi()
  let finish!: () => void
  vi.mocked(api.retrySummary).mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
  const { result } = renderHook(() => useImport(api))
  await act(() => result.current.choose('files'))
  act(() => emit(snapshot({ status: 'completed', results: [saved('a', '7', { summaryFailed: true })] })))
  let pending!: Promise<void>
  act(() => {
    pending = result.current.retrySummary('7')
    void result.current.retrySummary('7')
  })

  expect(api.retrySummary).toHaveBeenCalledTimes(1)
  await act(async () => { finish(); await pending })
})

test('上一批摘要请求结束不解锁新批次同一会话的更新', async () => {
  const { api, user } = setup()
  const finishes: Array<() => void> = []
  vi.mocked(api.retrySummary).mockImplementation(() => new Promise<void>(resolve => { finishes.push(resolve) }))
  await user.click(screen.getByRole('button', { name: '选择文件' }))
  await user.click(await screen.findByRole('button', { name: '重试摘要' }))
  await user.click(screen.getByRole('button', { name: '继续导入' }))
  vi.mocked(api.prepareImport).mockResolvedValue('job-2')
  vi.mocked(api.getImport).mockResolvedValue(snapshot({
    jobId: 'job-2', status: 'completed', candidates: [candidate()],
    results: [saved('a', '7', { summaryFailed: true })],
  }))
  await user.click(screen.getByRole('button', { name: '选择文件' }))
  await user.click(await screen.findByRole('button', { name: '重试摘要' }))

  await act(async () => { finishes[0]() })

  expect(screen.getByRole('button', { name: '正在更新…' })).toBeDisabled()
  expect(screen.queryByText('摘要已更新。')).not.toBeInTheDocument()
  expect(api.retrySummary).toHaveBeenCalledTimes(2)
  await act(async () => { finishes[1]() })
  expect(await screen.findByText('摘要已更新。')).toBeVisible()
})

test('另一会话摘要更新成功不会清除尚未解决的失败', async () => {
  const { api, emit } = fakeImportApi()
  let fail!: (reason: unknown) => void, finish!: () => void
  vi.mocked(api.retrySummary).mockImplementation(id => id === '7'
    ? new Promise<void>((_resolve, reject) => { fail = reject })
    : new Promise<void>(resolve => { finish = resolve }))
  const { result } = renderHook(() => useImport(api))
  await act(() => result.current.choose('files'))
  act(() => emit(snapshot({ status: 'completed', results: [saved('a', '7'), saved('b', '8')] })))
  let first!: Promise<void>, second!: Promise<void>
  act(() => { first = result.current.retrySummary('7'); second = result.current.retrySummary('8') })
  await act(async () => { fail({ code: 'SUMMARY_FAILED', action: '会话甲摘要更新失败，请重试。' }); await first })
  await act(async () => { finish(); await second })

  expect(result.current.retriedSummaries.has('8')).toBe(true)
  expect(result.current.error?.action).toBe('会话甲摘要更新失败，请重试。')
})

test('接口更替释放旧摘要请求，迟到结束不解锁新请求', async () => {
  const first = fakeImportApi(), second = fakeImportApi()
  const complete = snapshot({ status: 'completed', results: [saved('a', '7', { summaryFailed: true })] })
  let finishOld!: () => void, finishNew!: () => void
  vi.mocked(first.api.retrySummary).mockReturnValue(new Promise<void>(resolve => { finishOld = resolve }))
  vi.mocked(second.api.retrySummary).mockReturnValue(new Promise<void>(resolve => { finishNew = resolve }))
  vi.mocked(second.api.getImport).mockResolvedValue(complete)
  const { result, rerender } = renderHook(({ api }) => useImport(api), { initialProps: { api: first.api } })
  await act(() => result.current.choose('files'))
  act(() => first.emit(complete))
  let oldRequest!: Promise<void>, newRequest!: Promise<void>
  act(() => { oldRequest = result.current.retrySummary('7') })
  rerender({ api: second.api })
  await waitFor(() => expect(result.current.busy).toBe(false))
  expect(result.current.retryingSummaries.size).toBe(0)
  act(() => { newRequest = result.current.retrySummary('7') })
  expect(second.api.retrySummary).toHaveBeenCalledOnce()
  await act(async () => { finishOld(); await oldRequest })
  expect(result.current.retryingSummaries.has('7')).toBe(true)
  expect(result.current.retriedSummaries.has('7')).toBe(false)
  await act(async () => { finishNew(); await newRequest })
  expect(result.current.retryingSummaries.size).toBe(0)
  expect(result.current.retriedSummaries.has('7')).toBe(true)
})
