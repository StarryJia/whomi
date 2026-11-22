import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'
import { defaultPrompts } from '../../shared/system-prompts'
import { SystemPrompts } from './system-prompts'

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
function setup(values = defaultPrompts) {
  const api = { getPrompts: vi.fn(async () => ({ ...values })), savePrompt: vi.fn(async (id: string, text: string) => ({ ...values, [id]: text })) }
  render(<SystemPrompts api={api} registerGuard={() => {}} onBusy={() => {}} />)
  return { api, user: userEvent.setup() }
}
test('设置展示对话与洞察的四个提示词入口，各自说明可打开', async () => {
  const { user } = setup()
  await screen.findByRole('button', { name: '编辑AI 对话' })
  expect(screen.getAllByRole('button', { name: /^编辑/ }).map(button => button.getAttribute('aria-label')))
    .toEqual(['编辑AI 对话', '编辑洞察阅读', '编辑洞察核查', '编辑洞察成稿'])
  await user.click(screen.getByRole('button', { name: '洞察成稿说明' }))
  const help = screen.getByRole('dialog', { name: '洞察成稿说明' })
  expect(within(help).getByText('作用')).toBeVisible()
  expect(within(help).getByText('对应功能')).toBeVisible()
  expect(within(help).getByText('对话洞察')).toBeVisible()
  expect(screen.queryByText('默认', { exact: true })).not.toBeInTheDocument()
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  await user.keyboard('{Escape}')
  await user.click(screen.getByRole('button', { name: '编辑洞察成稿' }))
  const editor = screen.getByRole('dialog', { name: '编辑提示词 · 洞察成稿' })
  expect(within(editor).getByRole('textbox')).toHaveFocus()
  expect(within(editor).getByRole('textbox', { name: '提示词内容' })).toHaveValue(defaultPrompts.insightWriting)
  expect(within(editor).queryByText('对应功能')).not.toBeInTheDocument()
  await user.click(within(editor).getByRole('button', { name: '取消' }))
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '编辑洞察成稿' })).toHaveFocus()
})
test('保存失败保留草稿，重试成功后再次打开为保存值', async () => {
  const { api, user } = setup()
  api.savePrompt.mockRejectedValueOnce(new Error('磁盘写入失败，请重试。'))
  await user.click(await screen.findByRole('button', { name: '编辑AI 对话' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '用简短句子回答。' } })
  await user.click(screen.getByRole('button', { name: /^保存$/ }))
  expect(await screen.findByRole('alert')).toHaveTextContent('磁盘写入失败')
  expect(screen.getByRole('textbox')).toHaveValue('用简短句子回答。')
  await user.click(screen.getByRole('button', { name: /^保存$/ }))
  await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
  await user.click(screen.getByRole('button', { name: '编辑AI 对话' }))
  expect(screen.getByRole('textbox')).toHaveValue('用简短句子回答。')
})
test('恢复默认只改草稿，关闭可继续编辑或放弃；空正文不发送保存', async () => {
  const { api, user } = setup()
  await user.click(await screen.findByRole('button', { name: '编辑AI 对话' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '临时修改' } })
  await user.click(screen.getByRole('button', { name: '取消' }))
  await user.click(screen.getByRole('button', { name: '继续编辑' }))
  expect(screen.getByRole('textbox')).toHaveValue('临时修改')
  await user.click(screen.getByRole('button', { name: '恢复默认' }))
  expect(screen.getByRole('textbox')).toHaveValue(defaultPrompts.dialogue)
  expect(api.savePrompt).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '  ' } })
  await user.click(screen.getByRole('button', { name: /^保存$/ }))
  expect(screen.getByRole('alert')).toHaveTextContent('请输入提示词')
  expect(api.savePrompt).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: '取消' }))
  await user.click(screen.getByRole('button', { name: '放弃修改' }))
  await user.click(screen.getByRole('button', { name: '编辑AI 对话' }))
  expect(screen.getByRole('textbox')).toHaveValue(defaultPrompts.dialogue)
})
