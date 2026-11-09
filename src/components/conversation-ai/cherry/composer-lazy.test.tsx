import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { expect, it, vi } from 'vitest'
import { ModelSelector } from '../model-selector'
import { CherryComposer } from './composer'

const runtime = vi.hoisted(() => {
  let start!: () => void
  let release!: () => void
  const loading = new Promise<void>(resolve => { start = resolve })
  const ready = new Promise<void>(resolve => { release = resolve })
  return { loading, ready, release, start }
})

vi.mock('../../../vendor/cherry-chat/composer/ComposerSurfaceRuntime', async importOriginal => {
  runtime.start()
  await runtime.ready
  return importOriginal<typeof import('../../../vendor/cherry-chat/composer/ComposerSurfaceRuntime')>()
})

it('keeps the model menu open when the rich composer finishes loading', async () => {
  const user = userEvent.setup()
  const selectModel = vi.fn()
  const send = vi.fn(async () => false)
  function Fixture() {
    const [value, onChange] = useState('保留这个问题')
    const [model, setModel] = useState('')
    return <CherryComposer scopeKey="composer-lazy-model" value={value} onChange={onChange}
      onSend={send} onStop={() => {}} running={false} sendDisabled={false}
      toolbar={<ModelSelector label="对话模型" models={[{ id: 'sample', label: '示例模型' }]} value={model}
        onSelect={id => { selectModel(id); setModel(id) }} />} />
  }
  render(<><button type="button">查看原文</button><Fixture /></>)
  await runtime.loading
  const editor = () => screen.getByRole('textbox', { name: '向 AI 提问' })
  expect(editor()).toBeInstanceOf(HTMLTextAreaElement)
  act(() => editor().focus())
  await user.click(screen.getByRole('combobox', { name: '对话模型' }))
  const menu = await screen.findByRole('listbox', { name: '模型' })
  expect(screen.getByRole('textbox', { name: '搜索模型' })).toHaveFocus()

  await act(async () => {
    runtime.release()
    await import('../../../vendor/cherry-chat/composer/ComposerSurfaceRuntime')
    await vi.dynamicImportSettled()
  })

  expect(menu).toBeVisible()
  await user.click(within(menu).getByRole('option', { name: '示例模型' }))
  expect(selectModel).toHaveBeenCalledExactlyOnceWith('sample')
  const modelTrigger = screen.getByRole('combobox', { name: '对话模型' })
  expect(modelTrigger).toHaveAttribute('title', '示例模型')
  expect(screen.queryByRole('listbox', { name: '模型' })).not.toBeInTheDocument()

  await waitFor(() => expect(modelTrigger).toHaveFocus())
  expect(editor()).toBeInstanceOf(HTMLTextAreaElement)
  const sendButton = screen.getByRole('button', { name: '发送给 AI' })
  await user.pointer({ target: sendButton, keys: '[MouseLeft>]' })
  const outside = screen.getByRole('button', { name: '查看原文' })
  await act(async () => {
    outside.focus()
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  })
  expect(sendButton).toBeInTheDocument()
  await user.pointer({ target: sendButton, keys: '[/MouseLeft]' })
  expect(send).toHaveBeenCalledExactlyOnceWith('保留这个问题')
  await waitFor(() => expect(editor()).toHaveClass('ProseMirror'))
  expect(outside).toHaveFocus()
  act(() => editor().focus())
  expect(editor()).toHaveFocus()
  expect(editor()).toHaveTextContent('保留这个问题')
})
