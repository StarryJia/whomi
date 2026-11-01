import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { CodexUsage } from './codex-usage'
import type { CodexQuotaState } from '../../shared/codex-quota'

const ready: CodexQuotaState = { state: 'ready', source: { email: 'demo@example.invalid', workspaceId: 'workspace-demo', authFile: 'C:/fixture/auth.json' }, planType: 'prolite', windows: [{ seconds: 604800, remainingPercent: 62, resetsAt: 1794130454000 }], updatedAt: 1793549700000 }
function setup(quota = vi.fn().mockResolvedValue(ready)) {
  const api = { getCodexQuota: quota, getAccountUsage: vi.fn().mockResolvedValue({ requests: 2, inputTokens: 1234, outputTokens: 0, partial: true }) }
  const view = render(<CodexUsage api={api} accountId="whomi-a" />)
  return { api, ...view, user: userEvent.setup() }
}

test('shows compact actual windows and explicit Codex identity while local records start collapsed', async () => {
  const { user, api } = setup()
  expect(await screen.findByRole('meter', { name: '每周额度' })).toHaveAttribute('aria-valuenow', '62')
  expect(screen.queryByText('5 小时额度')).not.toBeInTheDocument()
  expect(screen.getByText(/demo@example.invalid/)).toBeVisible()
  expect(screen.getByText(/workspace-demo/)).toBeVisible()
  expect(api.getAccountUsage).not.toHaveBeenCalled()
  await user.click(screen.getByText('本机使用记录', { exact: true }))
  expect(await screen.findByText('1,234')).toBeVisible()
  expect(screen.getByText('0', { exact: true })).toBeVisible()
  expect(screen.getByText(/部分请求未返回完整用量/)).toBeVisible()
})

test('a small positive remainder is never displayed as exhausted', async () => {
  setup(vi.fn().mockResolvedValue({ ...ready, windows: [{ seconds: 18000, remainingPercent: 0.04, resetsAt: null }] }))
  expect(await screen.findByRole('meter', { name: '5 小时额度' })).toHaveAttribute('aria-valuenow', '0.04')
  expect(screen.getByText('<0.1%', { exact: true })).toBeVisible()
  expect(screen.queryByText('0%', { exact: true })).not.toBeInTheDocument()
})

test('only connects after an explicit action and cancellation discards a late result', async () => {
  let resolve!: (value: CodexQuotaState) => void
  const get = vi.fn().mockResolvedValueOnce({ state: 'disconnected' }).mockImplementationOnce(() => new Promise(done => { resolve = done })).mockResolvedValue({ state: 'disconnected' })
  const { user } = setup(get)
  await user.click(await screen.findByRole('button', { name: '连接本机 Codex 用量' }))
  expect(get).toHaveBeenLastCalledWith('whomi-a', 'connect')
  await user.click(screen.getByRole('button', { name: '取消连接' }))
  await act(async () => resolve(ready))
  expect(screen.queryByRole('meter')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '连接本机 Codex 用量' })).toBeEnabled()
  expect(screen.getByRole('button', { name: '连接本机 Codex 用量' })).toHaveFocus()
})

test('keeps timestamped stale quota while refreshing and on network errors, and recovers on retry', async () => {
  let reject!: (e: Error) => void
  const get = vi.fn().mockResolvedValueOnce(ready).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail })).mockResolvedValue({ ...ready, windows: [{ seconds: 18000, remainingPercent: 0, resetsAt: null }, ...ready.windows] })
  const { user } = setup(get)
  await screen.findByRole('meter')
  const timestamp = screen.getByText(/更新于/).textContent
  await user.click(screen.getByRole('button', { name: '刷新额度' }))
  expect(screen.getByRole('button', { name: '正在刷新' })).toBeDisabled()
  expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '62')
  await act(async () => reject(Object.assign(new Error('请检查网络后重试。'), { code: 'CODEX_QUOTA_NETWORK' })))
  expect(screen.getByRole('alert')).toHaveTextContent('上次结果')
  expect(screen.getByText(/更新于/).textContent).toBe(timestamp)
  await user.click(screen.getByRole('button', { name: '重试读取额度' }))
  expect(await screen.findByRole('meter', { name: '5 小时额度' })).toHaveAttribute('aria-valuenow', '0')
  expect(screen.getByText('重置时间未提供')).toBeVisible()
})

test('source changes clear old numbers and require explicit reconnection', async () => {
  const get = vi.fn().mockResolvedValueOnce(ready).mockResolvedValue({ state: 'unavailable', reason: 'source-changed' })
  const { user } = setup(get)
  await screen.findByRole('meter')
  await user.click(screen.getByRole('button', { name: '刷新额度' }))
  expect(await screen.findByRole('button', { name: '重新连接本机 Codex' })).toBeVisible()
  expect(screen.queryByRole('meter')).not.toBeInTheDocument()
  expect(screen.queryByText(/demo@example.invalid/)).not.toBeInTheDocument()
  expect(within(screen.getByRole('region', { name: '剩余额度' })).getByRole('link', { name: '在 ChatGPT 管理用量' })).toHaveAttribute('href', 'https://chatgpt.com/settings/usage')
  get.mockResolvedValueOnce({ state: 'disconnected' })
  await user.click(screen.getByRole('button', { name: '断开' }))
  expect(screen.getByRole('button', { name: '连接本机 Codex 用量' })).toHaveFocus()
})
