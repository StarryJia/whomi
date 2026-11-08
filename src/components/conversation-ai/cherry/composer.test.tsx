import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { TiptapEditorHTMLElement } from '@tiptap/core'
import { createRef, useState, type Ref } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CherryComposer, clearComposerDraft, clearComposerInputHistory, moveComposerInputHistory, readComposerDraft,
  useComposerDraft, writeComposerDraft,
  type CherryComposerHandle,
} from './composer'

const fragmentType = 'web application/x-cherry-composer-fragment+json'

beforeEach(() => {
  // jsdom does not calculate the single-line geometry needed by ProseMirror's caret navigation.
  const rect = new DOMRect(0, 0, 16, 16)
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => rect })
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [rect] })
  vi.spyOn(window, 'scrollBy').mockImplementation(() => {})
})

afterEach(() => {
  Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
  Reflect.deleteProperty(Range.prototype, 'getClientRects')
})

function clipboard(data: Record<string, string>, files: File[] = []) {
  return { getData: (type: string) => data[type] ?? '', types: Object.keys(data), files, items: [] }
}

function paste(textbox: HTMLElement, text: string) {
  fireEvent.paste(textbox, { clipboardData: clipboard({ 'text/plain': text }) })
}

function textbox() {
  return screen.getByRole('textbox', { name: '向 AI 提问' })
}

async function richTextbox() {
  return waitFor(() => {
    expect(textbox()).toHaveClass('ProseMirror')
    return textbox()
  })
}

function select(editor: HTMLElement, position: 'all' | 'end') {
  const richEditor = (editor as TiptapEditorHTMLElement).editor
  if (!richEditor) throw new Error('The real composer editor did not mount')
  act(() => {
    editor.focus()
    if (position === 'all') richEditor.commands.selectAll()
    else richEditor.commands.setTextSelection(richEditor.state.doc.content.size - 1)
  })
}

function Fixture({
  scopeKey, send = async () => true, stop = () => {}, onSubmittingChange,
}: {
  scopeKey: string
  send?: (value: string) => Promise<boolean>
  stop?: () => void
  onSubmittingChange?: (locked: boolean) => void
}) {
  const [value, onChange] = useComposerDraft(scopeKey)
  const [running, setRunning] = useState(false)
  return <CherryComposer
    scopeKey={scopeKey} value={value} onChange={onChange}
    onSend={async text => {
      const accepted = await send(text)
      if (accepted) setRunning(true)
      return accepted
    }}
    onStop={() => { stop(); setRunning(false) }}
    running={running} sendDisabled={false} onSubmittingChange={onSubmittingChange}
  />
}

function FocusFixture({ disabled, handle }: { disabled: boolean; handle: Ref<CherryComposerHandle> }) {
  const scopeKey = 'composer-focus-after-restore'
  const [value, onChange] = useComposerDraft(scopeKey)
  return <>
    <button type="button">返回原文操作</button>
    <CherryComposer ref={handle} scopeKey={scopeKey} value={value} onChange={onChange}
      onSend={async () => true} onStop={() => {}} running={false} sendDisabled={false} disabled={disabled} />
  </>
}

describe('Cherry 纯文本输入器', () => {
  it('受理前锁定原稿，拒绝后原样保留并可重试', async () => {
    const scopeKey = 'composer-rejection'
    writeComposerDraft(scopeKey, '  第一行  \n第二行')
    let rejectSubmission!: (accepted: boolean) => void
    const send = vi.fn(() => new Promise<boolean>(resolve => { rejectSubmission = resolve }))
    const onSubmittingChange = vi.fn()
    render(<Fixture scopeKey={scopeKey} send={send} onSubmittingChange={onSubmittingChange} />)
    const editor = await richTextbox()
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(editor).toHaveAttribute('contenteditable', 'false')
    expect(readComposerDraft(scopeKey)).toBe('  第一行  \n第二行')
    expect(onSubmittingChange.mock.calls).toEqual([[true]])
    paste(editor, '锁定时粘贴')
    fireEvent.click(screen.getByRole('button', { name: '发送给 AI' }))
    expect(send.mock.calls).toEqual([['  第一行  \n第二行']])
    await act(async () => rejectSubmission(false))
    expect(editor).toHaveAttribute('contenteditable', 'true')
    expect(readComposerDraft(scopeKey)).toBe('  第一行  \n第二行')
    expect(onSubmittingChange.mock.calls).toEqual([[true], [false]])
  })

  it('受理后开放下一条草稿，生成期间回车不排队，停止保留新草稿', async () => {
    const scopeKey = 'composer-accepted'
    writeComposerDraft(scopeKey, '示例问题甲')
    let acceptSubmission!: (accepted: boolean) => void
    const send = vi.fn(() => new Promise<boolean>(resolve => { acceptSubmission = resolve }))
    const stop = vi.fn()
    render(<Fixture scopeKey={scopeKey} send={send} stop={stop} />)
    const editor = await richTextbox()
    fireEvent.click(screen.getByRole('button', { name: '发送给 AI' }))
    await act(async () => acceptSubmission(true))
    expect(readComposerDraft(scopeKey)).toBe('')
    expect(editor).toHaveAttribute('contenteditable', 'true')
    paste(editor, '示例草稿乙')
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(send.mock.calls).toEqual([['示例问题甲']])
    fireEvent.click(screen.getByRole('button', { name: '停止回答' }))
    expect(stop).toHaveBeenCalledOnce()
    expect(readComposerDraft(scopeKey)).toBe('示例草稿乙')
  })

  it('组合输入回车不发送，普通回车只发送一次', async () => {
    const scopeKey = 'composer-ime'
    writeComposerDraft(scopeKey, '示例拼音')
    const send = vi.fn(async () => true)
    render(<Fixture scopeKey={scopeKey} send={send} />)
    const editor = await richTextbox()
    fireEvent.compositionStart(editor)
    fireEvent.keyDown(editor, { key: 'Enter', isComposing: true, keyCode: 229 })
    expect(send).not.toHaveBeenCalled()
    fireEvent.compositionEnd(editor)
    await act(async () => new Promise(resolve => setTimeout(resolve, 100)))
    fireEvent.keyDown(editor, { key: 'Enter', repeat: true })
    expect(send).not.toHaveBeenCalled()
    await act(async () => fireEvent.keyDown(editor, { key: 'Enter' }))
    expect(send.mock.calls).toEqual([['示例拼音']])
  })

  it('切换对话后迟到的受理只清空原对话草稿', async () => {
    const first = 'composer-late-first'
    const second = 'composer-late-second'
    writeComposerDraft(first, '正在保存的问题')
    writeComposerDraft(second, '另一段对话的草稿')
    let acceptSubmission!: (accepted: boolean) => void
    const send = () => new Promise<boolean>(resolve => { acceptSubmission = resolve })
    const { rerender } = render(<Fixture scopeKey={first} send={send} />)
    fireEvent.keyDown(await richTextbox(), { key: 'Enter' })
    rerender(<Fixture scopeKey={second} />)
    const editor = await richTextbox()
    await act(async () => acceptSubmission(true))
    expect(readComposerDraft(first)).toBe('')
    expect(readComposerDraft(second)).toBe('另一段对话的草稿')
    expect(editor).toHaveTextContent('另一段对话的草稿')
  })

  it('方向键预览当前对话的历史，向下恢复草稿且其他对话不读取该历史', async () => {
    const first = 'composer-history-first'
    const second = 'composer-history-second'
    writeComposerDraft(first, '上一条示例问题')
    writeComposerDraft(second, '另一段对话的草稿')
    const { rerender } = render(<Fixture scopeKey={first} />)
    let editor = await richTextbox()
    await act(async () => fireEvent.keyDown(editor, { key: 'Enter' }))
    fireEvent.click(screen.getByRole('button', { name: '停止回答' }))
    paste(editor, '当前草稿')
    fireEvent.keyDown(editor, { key: 'ArrowUp' })
    expect(editor).toHaveTextContent('上一条示例问题')
    expect(readComposerDraft(first)).toBe('当前草稿')
    fireEvent.keyDown(editor, { key: 'ArrowDown' })
    expect(editor).toHaveTextContent('当前草稿')
    rerender(<Fixture scopeKey={second} />)
    editor = await richTextbox()
    fireEvent.keyDown(editor, { key: 'ArrowUp' })
    expect(editor).toHaveTextContent('另一段对话的草稿')
    rerender(<Fixture scopeKey={first} />)
    expect(await richTextbox()).toHaveTextContent('当前草稿')
    act(() => clearComposerDraft(first))
  })

  it('新对话取得正式编号时转移首条问题历史和保留正式草稿', async () => {
    const provisional = 'composer-history-provisional'
    const saved = 'composer-history-saved'
    writeComposerDraft(provisional, '首条已保存问题')
    const { rerender } = render(<Fixture scopeKey={provisional} />)
    const provisionalEditor = await richTextbox()
    await act(async () => fireEvent.keyDown(provisionalEditor, { key: 'Enter' }))
    fireEvent.click(screen.getByRole('button', { name: '停止回答' }))
    writeComposerDraft(saved, '正式对话草稿')
    moveComposerInputHistory(provisional, saved)
    rerender(<Fixture scopeKey={saved} />)
    const editor = await richTextbox()
    select(editor, 'end')
    fireEvent.keyDown(editor, { key: 'ArrowUp' })
    expect(editor).toHaveTextContent('首条已保存问题')
    expect(readComposerDraft(saved)).toBe('正式对话草稿')
  })

  it('清理被删除对话后方向键不读取旧问题，保留其他对话的历史', async () => {
    const removed = 'composer-history-removed'
    const retained = 'composer-history-retained'
    writeComposerDraft(removed, '即将删除的问题')
    writeComposerDraft(retained, '另一对话已发送问题')
    const { rerender } = render(<Fixture scopeKey={removed} />)
    const removedEditor = await richTextbox()
    await act(async () => fireEvent.keyDown(removedEditor, { key: 'Enter' }))
    fireEvent.click(screen.getByRole('button', { name: '停止回答' }))
    rerender(<Fixture scopeKey={retained} />)
    const retainedEditor = await richTextbox()
    await act(async () => fireEvent.keyDown(retainedEditor, { key: 'Enter' }))
    fireEvent.click(screen.getByRole('button', { name: '停止回答' }))

    clearComposerInputHistory(removed)
    rerender(<Fixture scopeKey={removed} />)
    act(() => textbox().focus())
    const reopened = await richTextbox()
    fireEvent.keyDown(reopened, { key: 'ArrowUp' })
    expect(reopened.textContent).toBe('')

    rerender(<Fixture scopeKey={retained} />)
    act(() => textbox().focus())
    const other = await richTextbox()
    fireEvent.keyDown(other, { key: 'ArrowUp' })
    expect(other.textContent).toBe('另一对话已发送问题')
  })

  it('保留纯文本粘贴的空格和换行，忽略图片、私有片段和链接标记', async () => {
    const scopeKey = 'composer-paste'
    const privateFragment = JSON.stringify({
      version: 1, segments: [{ kind: 'token', token: { id: 'secret', kind: 'file', promptText: '内部路径' } }],
    })
    render(<Fixture scopeKey={scopeKey} />)
    act(() => textbox().focus())
    const editor = await richTextbox()
    const image = new File(['image'], 'sample.png', { type: 'image/png' })
    fireEvent.paste(editor, { clipboardData: clipboard({
      [fragmentType]: privateFragment,
      'text/html': '<span data-composer-token>内部路径</span>',
    }, [image]) })
    expect(readComposerDraft(scopeKey)).toBe('')
    fireEvent.paste(editor, { clipboardData: clipboard({
      [fragmentType]: privateFragment,
      'text/plain': '  示例  \n{{literal}}',
      'text/html': '<b>其他内容</b>',
    }, [image]) })
    expect(readComposerDraft(scopeKey)).toBe('  示例  \n{{literal}}')
    expect(editor.querySelector('[data-composer-token]')).toBeNull()
  })

  it('Shift+Enter 换行，复制选区时保留 Markdown 行尾空格', async () => {
    const scopeKey = 'composer-copy'
    writeComposerDraft(scopeKey, '  示例  ')
    render(<Fixture scopeKey={scopeKey} />)
    const editor = await richTextbox()
    select(editor, 'end')
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true })
    paste(editor, '第二行')
    expect(readComposerDraft(scopeKey)).toBe('  示例  \n第二行')

    select(editor, 'all')
    const setData = vi.fn()
    fireEvent.copy(editor, { clipboardData: { setData } })
    expect(setData.mock.calls).toEqual([['text/plain', '  示例  \n第二行']])
  })

  it('暴露编辑器焦点入口，工具菜单关闭后可将焦点交回原编辑器', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const user = userEvent.setup()
    const handle = createRef<CherryComposerHandle>()
    function MenuFixture() {
      const [open, setOpen] = useState(false)
      const [value, onChange] = useComposerDraft('composer-focus')
      return <CherryComposer ref={handle}
        scopeKey="composer-focus" value={value} onChange={onChange}
        onSend={async () => true} onStop={() => {}} running={false} sendDisabled={false}
        toolbar={<>
          <button type="button" onClick={() => setOpen(true)}>工具选项</button>
          {open ? <button type="button" onKeyDown={event => {
            if (event.key === 'Escape') { setOpen(false); handle.current?.focus() }
          }}>示例选项</button> : null}
        </>} />
    }
    render(<MenuFixture />)
    act(() => handle.current?.focus())
    const editor = await richTextbox()
    await waitFor(() => expect(editor).toHaveFocus())
    await user.click(screen.getByRole('button', { name: '工具选项' }))
    act(() => screen.getByRole('button', { name: '示例选项' }).focus())
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('button', { name: '示例选项' })).not.toBeInTheDocument()
    await waitFor(() => expect(editor).toHaveFocus())
  })

  it('恢复对话时的焦点请求在编辑器可用后生效', async () => {
    writeComposerDraft('composer-focus-after-restore', '之前保存的草稿')
    const handle = createRef<CherryComposerHandle>()
    const view = render(<FocusFixture disabled handle={handle} />)
    const editor = await richTextbox()
    expect(editor).toHaveAttribute('contenteditable', 'false')
    await act(async () => {
      handle.current?.focus()
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    })
    expect(editor).not.toHaveFocus()

    view.rerender(<FocusFixture disabled={false} handle={handle} />)
    await waitFor(() => expect(editor).toHaveFocus())
  })

  it('恢复对话时的焦点请求在用户点击其他控件后取消', async () => {
    writeComposerDraft('composer-focus-after-restore', '之前保存的草稿')
    const handle = createRef<CherryComposerHandle>()
    const view = render(<FocusFixture disabled handle={handle} />)
    const editor = await richTextbox()
    act(() => handle.current?.focus())
    const other = screen.getByRole('button', { name: '返回原文操作' })
    await userEvent.setup().click(other)

    view.rerender(<FocusFixture disabled={false} handle={handle} />)
    await act(async () => {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    })
    expect(editor).toHaveAttribute('contenteditable', 'true')
    expect(other).toHaveFocus()
  })
})
