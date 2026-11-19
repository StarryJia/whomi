import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import { expect, it } from 'vitest'
import { ExceptionNotice, ExceptionNoticeProvider, useExceptionNotice, useExceptionNoticeLayer } from './exception-notices'

it('deduplicates matching exceptions and shows the next occurrence after an operation clears', async () => {
  function Notices({ pending }: { pending: boolean }) {
    useExceptionNotice(pending ? { key: 'import', title: '保存失败', detail: '请检查磁盘空间。' } : null)
    return <>
      <ExceptionNotice title="无法读取设置" detail="请重新读取。" noticeKey="settings" />
      <ExceptionNotice title="无法读取设置" noticeKey="settings" />
    </>
  }

  const user = userEvent.setup()
  const { rerender } = render(<ExceptionNoticeProvider><Notices pending /></ExceptionNoticeProvider>)
  const notices = screen.getByRole('region', { name: '异常提醒' })
  expect(within(notices).getAllByRole('alert')).toHaveLength(2)
  const settingsCard = within(notices).getByText('无法读取设置').closest('li')!
  await user.click(within(settingsCard).getByRole('button', { name: '关闭提醒' }))
  expect(within(notices).getByRole('alert')).toHaveTextContent('保存失败')
  const disclosure = within(notices).getByRole('button', { name: '展开详情' })
  disclosure.focus()
  await user.keyboard(' ')
  expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  expect(within(notices).getByText('请检查磁盘空间。')).toBeVisible()
  await user.keyboard('{Enter}')
  expect(disclosure).toHaveAttribute('aria-expanded', 'false')
  await user.click(within(notices).getByRole('button', { name: '关闭提醒' }))
  expect(screen.queryByRole('region', { name: '异常提醒' })).not.toBeInTheDocument()

  rerender(<ExceptionNoticeProvider><Notices pending={false} /></ExceptionNoticeProvider>)
  rerender(<ExceptionNoticeProvider><Notices pending /></ExceptionNoticeProvider>)
  expect(screen.getByRole('alert')).toHaveTextContent('保存失败')
})

it('places a modal exception inside its active dialog and removes it when the dialog closes', async () => {
  function Dialog() {
    const dialog = useRef<HTMLDialogElement>(null)
    useExceptionNoticeLayer(dialog)
    return <dialog open aria-label="迁移数据" ref={dialog}>
      <ExceptionNotice title="数据迁移失败" detail="磁盘空间不足，请重新选择保存目录。" />
      <button type="button">重新选择</button>
    </dialog>
  }

  const user = userEvent.setup()
  const { rerender } = render(<ExceptionNoticeProvider><Dialog /></ExceptionNoticeProvider>)
  const dialog = screen.getByRole('dialog', { name: '迁移数据' })
  const notices = within(dialog).getByRole('region', { name: '异常提醒' })
  expect(within(notices).getByRole('alert')).toHaveTextContent('数据迁移失败')
  await user.click(within(notices).getByRole('button', { name: '展开详情' }))
  expect(within(notices).getByText('磁盘空间不足，请重新选择保存目录。')).toBeVisible()
  expect(within(dialog).getByRole('button', { name: '重新选择' })).toBeEnabled()

  rerender(<ExceptionNoticeProvider>{null}</ExceptionNoticeProvider>)
  expect(screen.queryByRole('region', { name: '异常提醒' })).not.toBeInTheDocument()
})
