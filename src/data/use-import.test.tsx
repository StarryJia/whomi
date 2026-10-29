import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useImport } from './use-import'
import { candidate, deferred, fakeImportApi, saved, snapshot } from '../test/import-api'

describe('导入任务生命周期', () => {
  it('来源授权、发现、暂存和提交沿用同一个任务，提示本人不等于确认', async () => {
    const { api } = fakeImportApi()
    const { result } = renderHook(() => useImport(api))
    await act(() => result.current.choose('directory'))
    expect(result.current.snapshot?.discovery?.entries[0].entryId).toBe('entry')
    await act(() => result.current.stage(['entry']))
    expect(result.current.snapshot?.status).toBe('awaiting_commit')
    await act(() => result.current.commit([{ candidateId: 'a', target: { kind: 'new' }, confirmedAliases: [] }]))
    expect(api.startImport).toHaveBeenNthCalledWith(1, { kind: 'stage', jobId: 'job', entryIds: ['entry'] })
    expect(api.startImport).toHaveBeenNthCalledWith(2, { kind: 'commit', plan: { jobId: 'job', decisions: [{ candidateId: 'a', target: { kind: 'new' }, confirmedAliases: [] }] } })
    expect(result.current.snapshot?.results[0].conversationId).toBe('7')
    expect(localStorage.getItem('whomi:import-job')).toBe('job')
  })

  it('准备返回前的事件和查询期间的新事件均不被旧快照覆盖', async () => {
    const { api, emit } = fakeImportApi()
    const prepare = deferred<string>(), query = deferred<ReturnType<typeof snapshot>>()
    vi.mocked(api.prepareImport).mockImplementation(async () => { emit(snapshot({ status: 'staging' })); return prepare.promise })
    vi.mocked(api.getImport).mockReturnValue(query.promise)
    const { result } = renderHook(() => useImport(api))
    let pending!: Promise<void>
    act(() => { pending = result.current.choose('files') })
    await waitFor(() => expect(api.prepareImport).toHaveBeenCalled())
    await act(async () => { prepare.resolve('job'); await Promise.resolve() })
    act(() => emit(snapshot({ status: 'awaiting_commit', candidates: [candidate()] })))
    await act(async () => { query.resolve(snapshot()); await pending })
    expect(result.current.snapshot?.status).toBe('awaiting_commit')
  })

  it('新来源取消旧活动任务，忽略旧任务事件；卸载取消订阅', async () => {
    const { api, emit, listeners } = fakeImportApi()
    const { result, unmount } = renderHook(() => useImport(api))
    await act(() => result.current.choose('files'))
    vi.mocked(api.prepareImport).mockResolvedValue('job2')
    vi.mocked(api.getImport).mockResolvedValue(snapshot({ jobId: 'job2' }))
    await act(() => result.current.choose('directory'))
    expect(api.cancelImport).toHaveBeenCalledWith('job')
    act(() => emit(snapshot({ status: 'completed', results: [saved('a', '7')] })))
    expect(result.current.snapshot?.jobId).toBe('job2')
    unmount()
    expect(listeners.size).toBe(0)
  })

  it('新请求等待旧准备返回并取消旧任务，再创建新任务', async () => {
    const { api } = fakeImportApi()
    const prepare = deferred<string>()
    vi.mocked(api.prepareImport).mockReturnValueOnce(prepare.promise).mockResolvedValueOnce('job2')
    vi.mocked(api.getImport).mockResolvedValue(snapshot({ jobId: 'job2' }))
    const { result } = renderHook(() => useImport(api))
    let first!: Promise<void>, second!: Promise<void>
    act(() => { first = result.current.choose('files') })
    await waitFor(() => expect(api.prepareImport).toHaveBeenCalledTimes(1))
    act(() => { second = result.current.choose('directory') })
    await waitFor(() => expect(api.chooseSources).toHaveBeenCalledTimes(2))
    expect(api.prepareImport).toHaveBeenCalledTimes(1)
    await act(async () => { prepare.resolve('job'); await first; await second })
    expect(api.cancelImport).toHaveBeenCalledWith('job')
    expect(result.current.snapshot?.jobId).toBe('job2')
    expect(api.cancelImport).toHaveBeenCalledTimes(1)
  })

  it('卸载后的准备结果只取消后台任务，不写入恢复存储', async () => {
    const { api, listeners } = fakeImportApi()
    const prepare = deferred<string>()
    vi.mocked(api.prepareImport).mockReturnValue(prepare.promise)
    const { result, unmount } = renderHook(() => useImport(api))
    let pending!: Promise<void>
    act(() => { pending = result.current.choose('files') })
    await waitFor(() => expect(api.prepareImport).toHaveBeenCalled())
    unmount()
    await act(async () => { prepare.resolve('job'); await pending })
    expect(listeners.size).toBe(0)
    expect(localStorage.getItem('whomi:import-job')).toBeNull()
    expect(api.cancelImport).toHaveBeenCalledWith('job')
  })

  it('重启查询持久任务，旧预览给出重新选择来源操作', async () => {
    localStorage.setItem('whomi:import-job', 'job')
    const { api } = fakeImportApi()
    vi.mocked(api.getImport).mockResolvedValue(snapshot({ status: 'completed', results: [saved('a', '7')] }))
    vi.mocked(api.previewImport).mockRejectedValue({ code: 'PREVIEW_UNAVAILABLE', action: '请重新选择来源并解析。' })
    const { result } = renderHook(() => useImport(api))
    await waitFor(() => expect(result.current.snapshot?.results[0].conversationId).toBe('7'))
    await act(() => result.current.preview('a'))
    expect(result.current.error).toEqual({ code: 'PREVIEW_UNAVAILABLE', action: '请重新选择来源并解析。' })
  })

  it('查询无效持久任务清除编号，畸形错误不显示 message 或成功', async () => {
    localStorage.setItem('whomi:import-job', 'gone')
    const { api } = fakeImportApi()
    vi.mocked(api.getImport).mockRejectedValue({ code: 'UNKNOWN_JOB', action: '请重新选择来源。' })
    const { result } = renderHook(() => useImport(api))
    await waitFor(() => expect(localStorage.getItem('whomi:import-job')).toBeNull())
    vi.mocked(api.chooseSources).mockRejectedValue({ message: 'private path' })
    await act(() => result.current.choose('files'))
    expect(result.current.error?.action).not.toContain('private path')
    expect(result.current.snapshot).toBeNull()
  })

  it('取消保留已提交结果，摘要重试只请求持久会话', async () => {
    const { api, emit } = fakeImportApi()
    const { result } = renderHook(() => useImport(api))
    await act(() => result.current.choose('files'))
    act(() => emit(snapshot({ status: 'committing', results: [saved('a', '7', { summaryFailed: true })] })))
    await act(() => result.current.cancel())
    expect(result.current.snapshot?.results[0].status).toBe('saved')
    await act(() => result.current.retrySummary('7'))
    expect(api.retrySummary).toHaveBeenCalledWith('7')
  })
})
