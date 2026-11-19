import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useImport } from './use-import'
import { candidate, deferred, fakeImportApi, saved, snapshot } from '../test/import-api'

describe('导入任务生命周期', () => {
  it.each(['file', 'directory'] as const)('选择窗口待返回时接受拖入的 %s，忽略迟到的选择结果', async kind => {
    const { api } = fakeImportApi()
    const picker = deferred<Awaited<ReturnType<typeof api.chooseSources>>>()
    vi.mocked(api.chooseSources).mockReturnValue(picker.promise)
    const dropped = [{ token: 'drag', displayName: '示例聊天来源', kind }]
    vi.mocked(api.acceptDroppedFiles).mockResolvedValue(dropped)
    const { result } = renderHook(() => useImport(api))
    let selecting!: Promise<void>
    act(() => { selecting = result.current.choose('files') })
    expect(result.current.busy).toBe(false)

    await act(() => result.current.drop([new File([''], '示例聊天来源')]))
    expect(api.prepareImport).toHaveBeenCalledExactlyOnceWith(dropped)
    await act(async () => {
      picker.resolve([{ token: 'picker', displayName: '后来选中的文件', kind: 'file' }])
      await selecting
    })
    expect(api.prepareImport).toHaveBeenCalledExactlyOnceWith(dropped)
    expect(api.cancelImport).not.toHaveBeenCalled()
  })

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

  it.each(['startImport', 'getImport'] as const)('保存请求的 %s 暂时失败后，收到完整回执即恢复完成', async method => {
    const { api, emit } = fakeImportApi()
    const { result } = renderHook(() => useImport(api))
    await act(() => result.current.choose('files'))
    await act(() => result.current.stage(['entry']))
    vi.mocked(api.startImport).mockResolvedValue('job')
    vi.mocked(api[method]).mockRejectedValueOnce({ code: 'INVALID_RESPONSE', action: '暂时无法读取结果。' })
    await act(() => result.current.commit([]))
    expect(result.current.failure?.code).toBe('INVALID_RESPONSE')

    act(() => emit(snapshot({ status: 'completed', results: [saved('a', '7')] })))
    expect(result.current.snapshot?.status).toBe('completed')
    expect(result.current.failure).toBeNull()
  })

  it('暂时缺失保存确认时，取消后以重新查询的完整结果为准', async () => {
    const { api, emit } = fakeImportApi()
    const { result } = renderHook(() => useImport(api))
    await act(() => result.current.choose('files'))
    act(() => emit(snapshot({ status: 'completed', results: [saved('a', '7', { committedAt: null })] })))
    expect(result.current.failure?.code).toBe('SAVE_CONFIRMATION_MISSING')

    vi.mocked(api.cancelImport).mockRejectedValueOnce({ code: 'ALREADY_COMMITTED', action: '保存已完成。' })
    vi.mocked(api.getImport).mockResolvedValueOnce(snapshot({ status: 'completed', results: [saved('a', '7')] }))
    await act(() => result.current.cancel())
    expect(result.current.snapshot?.results[0].committedAt).toBe(1)
    expect(result.current.failure).toBeNull()
  })

  it('接收来源后，选择和拖放均不可覆盖当前任务；卸载取消订阅', async () => {
    const { api, listeners } = fakeImportApi()
    const { result, unmount } = renderHook(() => useImport(api))
    await act(() => result.current.choose('files'))
    await act(() => result.current.choose('directory'))
    await act(() => result.current.drop([new File([''], 'later')]))
    expect(api.chooseSources).toHaveBeenCalledTimes(1)
    expect(api.acceptDroppedFiles).not.toHaveBeenCalled()
    expect(api.cancelImport).not.toHaveBeenCalled()
    expect(result.current.snapshot?.jobId).toBe('job')
    unmount()
    expect(listeners.size).toBe(0)
  })

  it('已接收的来源无需等待迟到的选择取消，准备期间拒绝第二次拖放', async () => {
    const { api } = fakeImportApi()
    const picker = deferred<Awaited<ReturnType<typeof api.chooseSources>>>()
    const prepare = deferred<string>()
    vi.mocked(api.chooseSources).mockReturnValue(picker.promise)
    vi.mocked(api.prepareImport).mockReturnValue(prepare.promise)
    const { result } = renderHook(() => useImport(api))
    let selecting!: Promise<void>, dropping!: Promise<void>
    act(() => { selecting = result.current.choose('files') })
    act(() => { dropping = result.current.drop([new File([''], 'first')]) })
    await waitFor(() => expect(api.prepareImport).toHaveBeenCalledTimes(1))
    await act(() => result.current.drop([new File([''], 'later')]))
    await act(async () => { picker.resolve([]); await selecting })
    expect(result.current.busy).toBe(true)
    await act(async () => { prepare.resolve('job'); await dropping })
    expect(result.current.snapshot?.jobId).toBe('job')
    expect(api.acceptDroppedFiles).toHaveBeenCalledTimes(1)
    expect(api.prepareImport).toHaveBeenCalledTimes(1)
    expect(api.cancelImport).not.toHaveBeenCalled()
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
    await act(() => result.current.cancel())
    vi.mocked(api.chooseSources).mockRejectedValue({ message: 'private path' })
    await act(() => result.current.choose('files'))
    expect(result.current.error?.action).not.toContain('private path')
    expect(result.current.snapshot).toBeNull()
  })

  it('整批取消确认前保持正在取消，确认后清除本地任务编号', async () => {
    const { api, emit } = fakeImportApi()
    const cancelled = deferred<void>()
    vi.mocked(api.cancelImport).mockReturnValue(cancelled.promise)
    const { result } = renderHook(() => useImport(api))
    await act(() => result.current.choose('files'))
    act(() => emit(snapshot({ status: 'committing' })))
    let pending!: Promise<void>
    act(() => { pending = result.current.cancel() })
    await act(() => result.current.cancel())
    expect(api.cancelImport).toHaveBeenCalledExactlyOnceWith('job')
    expect(result.current.cancelling).toBe(true)
    expect(localStorage.getItem('whomi:import-job')).toBe('job')
    await act(async () => { emit(snapshot({ status: 'cancelled' })); cancelled.resolve(); await pending })
    expect(result.current.snapshot?.status).toBe('cancelled')
    expect(result.current.cancelling).toBe(false)
    expect(localStorage.getItem('whomi:import-job')).toBeNull()
  })
})
