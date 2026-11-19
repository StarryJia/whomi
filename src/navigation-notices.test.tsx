import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import App from './App'
import { fakeImportApi, snapshot } from './test/import-api'

it('窄窗导航打开时 Tab 可进入导入异常详情并回到首页链接，Escape 收起导航', async () => {
  const media = window.matchMedia('')
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ ...media, media: query,
    matches: query === '(prefers-reduced-motion: reduce)' || query === '(max-width: 640px)' }))
  const user = userEvent.setup()
  const { api, emit } = fakeImportApi()
  render(<App importApi={api} />)
  await act(async () => emit(snapshot({ status: 'failed', failurePhase: 'statistics',
    issues: [{ code: 'STATISTICS_FAILED', action: '请查看错误日志。', severity: 'blocking', candidateId: '' }] })))
  await user.click(screen.getByRole('button', { name: '展开侧栏' }))
  const nav = within(screen.getByRole('dialog', { name: '导航面板' }))
  const home = nav.getByRole('link', { name: 'Whomi 首页' })
  const disclosure = screen.getByRole('button', { name: '展开详情' })
  home.focus()
  await user.tab({ shift: true })
  expect(disclosure).toHaveFocus()
  await user.keyboard('{Enter}')
  expect(nav.getByText(/请查看错误日志/)).toBeVisible()
  await user.tab()
  expect(home).toHaveFocus()
  for (let step = 0; step < 20 && document.activeElement !== disclosure; ++step) await user.tab()
  expect(disclosure).toHaveFocus()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog', { name: '导航面板' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '展开侧栏' })).toHaveFocus()
  expect(screen.getByRole('region', { name: '异常提醒' })).toBeVisible()
})
