import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { ChatgptStatus } from '../../shared/chatgpt-plan'
import type { SettingsApi } from '../../shared/settings-contract'
import { ProviderAccount, unconfiguredAccount } from './chatgpt-account'

afterEach(() => { vi.useRealTimers() })

test('登录成功后清除授权期间已经恢复的状态读取错误', async () => {
  vi.useFakeTimers()
  let complete!: (value: ChatgptStatus) => void
  const signIn = new Promise<ChatgptStatus>(resolve => { complete = resolve })
  const getAccountStatus = vi.fn()
    .mockResolvedValueOnce({ state: 'disconnected' })
    .mockRejectedValueOnce(new Error('账户状态读取失败，请重试。'))
    .mockResolvedValue({ state: 'pending' })
  const api = {
    getAccountStatus,
    signInAccount: vi.fn(() => signIn),
    cancelAccountSignIn: vi.fn(async () => {}),
  } as unknown as SettingsApi
  await act(async () => {
    render(<ProviderAccount id="copilot" api={api} provider={unconfiguredAccount('copilot')}
      refresh={async () => {}} onConnection={() => {}} />)
  })
  fireEvent.click(screen.getByRole('button', { name: '使用 GitHub 登录' }))
  await act(async () => { await vi.advanceTimersByTimeAsync(400) })
  expect(screen.getByRole('alert')).toHaveTextContent('账户状态读取失败，请重试。')

  await act(async () => { complete({ state: 'connected', email: 'fixture@example.invalid' }) })

  expect(screen.getByText('已连接 GitHub')).toBeVisible()
  expect(screen.getByText('fixture@example.invalid')).toBeVisible()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('授权等待期间状态读取恢复后清除暂时错误', async () => {
  vi.useFakeTimers()
  const api = {
    getAccountStatus: vi.fn()
      .mockResolvedValueOnce({ state: 'pending' })
      .mockRejectedValueOnce(new Error('账户状态读取失败，请重试。'))
      .mockResolvedValue({ state: 'pending', userCode: 'FIXTURE-CODE' }),
  } as unknown as SettingsApi
  await act(async () => {
    render(<ProviderAccount id="copilot" api={api} provider={unconfiguredAccount('copilot')}
      refresh={async () => {}} onConnection={() => {}} />)
  })
  await act(async () => { await vi.advanceTimersByTimeAsync(400) })
  expect(screen.getByRole('alert')).toHaveTextContent('账户状态读取失败，请重试。')

  await act(async () => { await vi.advanceTimersByTimeAsync(800) })

  expect(screen.getByText('FIXTURE-CODE')).toBeVisible()
  expect(screen.getByRole('button', { name: '取消登录' })).toBeEnabled()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('登录失败后的状态读取成功保留登录操作错误', async () => {
  const api = {
    getAccountStatus: vi.fn().mockResolvedValue({ state: 'disconnected' }),
    signInAccount: vi.fn().mockRejectedValue(new Error('登录失败，请重新登录。')),
    cancelAccountSignIn: vi.fn(async () => {}),
  } as unknown as SettingsApi
  await act(async () => {
    render(<ProviderAccount id="copilot" api={api} provider={unconfiguredAccount('copilot')}
      refresh={async () => {}} onConnection={() => {}} />)
  })

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '使用 GitHub 登录' })) })

  expect(screen.getByRole('button', { name: '使用 GitHub 登录' })).toBeEnabled()
  expect(screen.getByRole('alert')).toHaveTextContent('登录失败，请重新登录。')
})
