import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { FileImport } from '../file-import'
import { candidate, deferred, fakeImportApi, saved, snapshot } from '../../test/import-api'

it.each(['event', 'lookup'])('删除保存中的唯一目标后可重新导入，旧任务的迟到结果不会覆盖新选择（%s 先到）', async first => {
  const { api, emit } = fakeImportApi()
  const lookupStarted = deferred<void>(), finishLookup = deferred<void>()
  const start = vi.mocked(api.startImport).getMockImplementation()!
  vi.mocked(api.startImport).mockImplementation(async request => {
    if (request.kind === 'stage') return start(request)
    emit(snapshot({ status: 'committing' }))
    vi.mocked(api.getImport).mockImplementationOnce(async () => {
      lookupStarted.resolve()
      await finishLookup.promise
      if (first === 'lookup') throw { code: 'IMPORT_RESULT_REMOVED', action: '请重新选择导入来源。' }
      return snapshot({ status: 'completed', results: [saved('a', '7')] })
    })
    return 'job'
  })
  const onSaved = vi.fn(), onOpen = vi.fn()
  render(<FileImport api={api} onSaved={onSaved} onOpenConversation={onOpen} />)
  await userEvent.click(screen.getByRole('button', { name: '选择文件' }))
  await lookupStarted.promise
  expect(await screen.findByRole('heading', { name: '正在保存' })).toBeVisible()
  const removed = snapshot({ status: 'removed' })
  if (first === 'event') act(() => emit(removed))
  else await act(async () => finishLookup.resolve())
  const choose = await screen.findByRole('button', { name: '选择文件' })
  expect(choose).toBeEnabled()
  expect(localStorage.getItem('whomi:import-job')).toBeNull()

  const next = snapshot({ jobId: 'next', status: 'awaiting_commit', candidates: [candidate('x'), candidate('y')] })
  vi.mocked(api.prepareImport).mockImplementationOnce(async () => { emit(next); return next.jobId })
  await userEvent.click(choose)
  expect(await screen.findByRole('checkbox', { name: '会话 x' })).toBeEnabled()
  if (first === 'event') await act(async () => finishLookup.resolve())
  else act(() => emit(removed))
  expect(screen.getByRole('checkbox', { name: '会话 y' })).toBeVisible()
  expect(screen.queryByRole('button', { name: '打开会话' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '查看错误日志' })).not.toBeInTheDocument()
  expect(localStorage.getItem('whomi:import-job')).toBe('next')
  expect(onSaved).not.toHaveBeenCalled()
})
