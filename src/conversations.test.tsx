import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { createPreviewClient } from './data/preview-client'
import { ConversationReader } from './components/conversations'
import { fakeImportApi, saved, snapshot } from './test/import-api'

const conversations = [{
  id: 'sample', title: '项目讨论', messages: [
    { id: '1', sender: '小林', text: '先确认页面范围。', isSelf: false },
    { id: '2', sender: '我', text: '<script>原文不是网页</script>', isSelf: true },
  ],
}]

function setViewport(mobile = false) {
  const media = window.matchMedia('')
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({
    ...media, media: query,
    matches: query === '(prefers-reduced-motion: reduce)' || (mobile && query === '(max-width: 640px)'),
  }))
}

beforeEach(() => setViewport())

describe('文件选择与会话前端', () => {
  it('已选消息移出分页窗口后引用仍能跳回，草稿与选择保持', async () => {
    const user = userEvent.setup()
    const client = createPreviewClient([{ id: 'long', title: '长会话引用', messages: Array.from({ length: 650 }, (_, index) => ({
      id: String(index + 1), sender: '成员', text: `引用原文 ${index + 1}`,
    })) }])
    const locate = vi.spyOn(client, 'locateSource')
    render(<App client={client} />)
    await user.click(screen.getByRole('button', { name: '展开会话列表' }))
    await user.click(await screen.findByRole('button', { name: '长会话引用' }))
    await user.click(screen.getByRole('button', { name: '选择消息' }))
    expect(document.querySelectorAll('.message[tabindex="0"]')).toHaveLength(1)
    const firstMessage = screen.getByRole('option', { name: '成员：引用原文 1' })
    firstMessage.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('option', { name: '成员：引用原文 2' })).toHaveFocus()
    expect(document.querySelectorAll('.message[tabindex="0"]')).toHaveLength(1)
    await user.click(screen.getByRole('option', { name: '成员：引用原文 1' }))
    await user.type(screen.getByRole('textbox'), '保留这个问题')
    for (let index = 0; index < 5; index++) await user.click(screen.getByRole('button', { name: '加载后文' }))
    expect(screen.queryByRole('option', { name: '成员：引用原文 1' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '1 条引用' }))
    expect(await screen.findByRole('option', { name: '成员：引用原文 1' })).toHaveAttribute('aria-selected', 'true')
    expect(locate).toHaveBeenCalledExactlyOnceWith({ conversationId: 'long', messageId: '1' })
    expect(screen.getByRole('textbox')).toHaveValue('保留这个问题')
  }, 15000)

  it('移除上方页和恢复前文时，保留消息的可见位置不变', async () => {
    const user = userEvent.setup()
    const data = [{ id: 'long', title: '虚构长会话', messages: Array.from({ length: 650 }, (_, index) => ({
      id: String(index + 1), sender: '示例成员', text: `锚点消息 ${index + 1}`,
    })) }]
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const firstId = (this.parentElement?.firstElementChild as HTMLElement | null)?.dataset.messageId ?? '0'
      const index = this.dataset.messageId ? Number(this.dataset.messageId) - Number(firstId) : 0
      const container = this.closest<HTMLElement>('.reader-scroll')
      return new DOMRect(0, this.dataset.messageId ? index * 20 - (container?.scrollTop ?? 0) : 0, 100, 20)
    })
    render(<App client={createPreviewClient(data)} />)
    await user.click(screen.getByRole('button', { name: '展开会话列表' }))
    await user.click(await screen.findByRole('button', { name: '虚构长会话' }))
    for (let index = 0; index < 4; index++) await user.click(screen.getByRole('button', { name: '加载后文' }))
    const reader = screen.getByRole('region', { name: '聊天记录' })
    reader.scrollTop = 8800
    fireEvent.scroll(reader)
    const anchor = within(reader).getByText('锚点消息 450').closest('li')!
    const top = anchor.getBoundingClientRect().top
    await user.click(screen.getByRole('button', { name: '加载后文' }))
    expect(reader.querySelectorAll('.message')).toHaveLength(500)
    expect(anchor.getBoundingClientRect().top).toBe(top)
    expect(reader.scrollTop).toBe(6800)
    await user.click(screen.getByRole('button', { name: '加载前文' }))
    expect(anchor.getBoundingClientRect().top).toBe(top)
    expect(reader.scrollTop).toBe(8800)
  }, 15000)

  it('相同时间的大整数编号范围准确高亮，未知时间不编造日期', async () => {
    const api = createPreviewClient([{ id: 'large', title: '虚构大编号', messages: Array.from({ length: 4 }, (_, index) => ({
      id: (9007199254740992n + BigInt(index)).toString(), sender: '示例成员', text: `大编号消息 ${index}`, time: '导出中没有日期',
    })) }])
    const page = await api.readMessages({ conversationId: 'large', direction: 'after' })
    const messages = page.items.map(item => ({ ...item, timeBucket: 1 as const, sortTime: 0 }))
    render(<ConversationReader conversation={{ id: 'large', title: '虚构大编号', messages }} range={{ start: messages[1], end: messages[2] }} sourceStatus="available" />)
    expect(screen.getByText('大编号消息 0').closest('li')).not.toHaveClass('message-source')
    expect(screen.getByText('大编号消息 1').closest('li')).toHaveClass('message-source')
    expect(screen.getByText('大编号消息 2').closest('li')).toHaveClass('message-source')
    expect(screen.getByText('大编号消息 3').closest('li')).not.toHaveClass('message-source')
    expect(screen.getAllByText('导出中没有日期')).toHaveLength(4)
    expect(screen.getByText('时间未知')).toBeInTheDocument()
    expect(screen.queryByText(/1970/)).not.toBeInTheDocument()
  })

  it('首次持久保存刷新摘要，打开后返回导入结果，重启仍由后台列表读取', async () => {
    const user = userEvent.setup()
    const { api, emit } = fakeImportApi()
    const query = createPreviewClient([{ id: '7', title: '新保存的虚构会话', messages: [{ id: '1', sender: '成员', text: '持久阅读样例' }] }])
    const summary = await query.listConversations({})
    vi.mocked(api.listConversations).mockResolvedValueOnce({ items: [], nextCursor: null }).mockResolvedValue(summary)
    api.readMessages = vi.fn(query.readMessages)
    const first = render(<App importApi={api} />)
    await waitFor(() => expect(api.listConversations).toHaveBeenCalledTimes(1))
    await user.click(screen.getByRole('button', { name: '导入会话' }))
    await user.click(screen.getByRole('button', { name: '选择文件' }))
    await screen.findByText('两层目录中的记录.json')
    const value = snapshot({ status: 'completed', results: [saved('a', '7')] })
    vi.mocked(api.getImport).mockResolvedValue(value)
    act(() => emit(value))
    await waitFor(() => expect(api.listConversations).toHaveBeenCalledTimes(2))
    await user.click(await screen.findByRole('button', { name: '打开会话' }))
    expect(await screen.findByText('持久阅读样例')).toBeInTheDocument()
    expect(api.readMessages).toHaveBeenCalledExactlyOnceWith({ conversationId: '7', direction: 'after', limit: 100 })
    await user.click(screen.getByRole('button', { name: '返回导入结果' }))
    expect(await screen.findByText('已保存 500 条消息。')).toBeInTheDocument()
    first.unmount()
    render(<App importApi={api} />)
    await user.click(screen.getByRole('button', { name: '展开会话列表' }))
    expect(await screen.findByRole('button', { name: '新保存的虚构会话' })).toBeInTheDocument()
  })

  it('正式查询只取摘要和第一页，未知时间保留原始文本并标明时间未知', async () => {
    const user = userEvent.setup()
    const api = createPreviewClient(conversations)
    const list = vi.spyOn(api, 'listConversations')
    const read = vi.spyOn(api, 'readMessages')
    render(<App client={api} />)
    await user.click(screen.getByRole('button', { name: '展开会话列表' }))
    await user.click(await screen.findByRole('button', { name: '项目讨论' }))
    expect(list).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledExactlyOnceWith({ conversationId: 'sample', direction: 'after', limit: 100 })
    expect(await screen.findByText('时间未知')).toBeInTheDocument()
    expect(screen.getByText('<script>原文不是网页</script>').closest('li')).toHaveClass('message-self')
    expect(screen.queryByText(/1970/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '个人总览' }))
    expect(screen.getByText('已有记录，尚未形成分析结果。')).toBeInTheDocument()
  })

  it('加号进入导入页，不改变抽屉状态；管理图标不可执行', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: '导入会话' }))
    expect(screen.getByRole('button', { name: '展开会话列表' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: '数据导入' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: '选择文件' })).toHaveFocus())
    await user.click(screen.getByRole('button', { name: '管理会话' }))
    expect(screen.getByRole('button', { name: '管理会话' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: '文件导入' })).toBeInTheDocument()
  })

  it('选择和拖入文件只显示文件名，不读取正文、不创建会话', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: '导入会话' }))
    const file = new File(['private content'], '聊天记录.json', { type: 'application/json' })
    const read = vi.fn()
    Object.defineProperty(file, 'text', { value: read })
    await user.upload(screen.getByLabelText('选择聊天记录文件'), file)
    expect(screen.getByRole('status')).toHaveTextContent('聊天记录.json')
    expect(screen.getByRole('status')).toHaveTextContent('尚未导入')
    expect(read).not.toHaveBeenCalled()
    const next = new File(['other'], '另一份.txt')
    fireEvent.drop(screen.getByRole('region', { name: '文件导入' }), {
      dataTransfer: { files: [next], types: ['Files'], items: [] },
    })
    expect(screen.getByRole('status')).toHaveTextContent('另一份.txt')
    expect(screen.getByRole('status')).not.toHaveTextContent('聊天记录.json')
    await user.click(screen.getByRole('button', { name: '展开会话列表' }))
    const drawer = screen.getByLabelText('会话列表', { selector: 'div' })
    expect(drawer.firstElementChild).toBeEmptyDOMElement()
    await user.click(screen.getByRole('button', { name: '收起侧栏' }))
    expect(drawer.firstElementChild).toBeEmptyDOMElement()
    expect(screen.queryByLabelText('暂无会话')).not.toBeInTheDocument()
    expect(screen.queryByText('导入成功')).not.toBeInTheDocument()
  })

  it('一次拖入多个文件提示重新选择，不丢弃已选文件', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: '导入会话' }))
    await user.upload(screen.getByLabelText('选择聊天记录文件'), new File(['a'], '保留.txt'))
    fireEvent.drop(screen.getByRole('region', { name: '文件导入' }), {
      dataTransfer: { files: [new File(['b'], 'b.txt'), new File(['c'], 'c.txt')], types: ['Files'], items: [] },
    })
    expect(screen.getByRole('alert')).toHaveTextContent('请一次选择一个文件')
    expect(screen.getByRole('status')).toHaveTextContent('保留.txt')
  })

  it('抽屉与侧栏独立，收起抽屉保留同一正文元素及阅读位置', async () => {
    const user = userEvent.setup()
    render(<App conversations={conversations} />)
    await user.click(screen.getByRole('button', { name: '展开会话列表' }))
    await user.click(screen.getByRole('button', { name: '项目讨论' }))
    const reader = screen.getByRole('region', { name: '聊天记录' })
    reader.scrollTop = 120
    expect(within(reader).getByText('<script>原文不是网页</script>')).toBeInTheDocument()
    expect(reader.querySelector('script')).toBeNull()
    await user.click(screen.getByRole('button', { name: '收起侧栏' }))
    expect(screen.getByRole('button', { name: '项目讨论' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '收起会话列表' }))
    expect(screen.getByLabelText('会话列表', { selector: 'div' })).toHaveAttribute('inert')
    expect(screen.getByRole('region', { name: '聊天记录' })).toBe(reader)
    expect(reader.scrollTop).toBe(120)
    await user.click(screen.getByRole('button', { name: '展开会话列表' }))
    expect(screen.getByRole('button', { name: '项目讨论' })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('region', { name: '聊天记录' })).toBe(reader)
  })

  it('阅读可草拟 AI 问题，无模型时不发送，品牌返回 Hello 后卸载正文', async () => {
    const user = userEvent.setup()
    render(<App conversations={conversations} />)
    await user.click(screen.getByRole('button', { name: '展开会话列表' }))
    await user.click(screen.getByRole('button', { name: '项目讨论' }))
    expect(screen.getByRole('textbox', { name: '向 AI 提问' })).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: '向 AI 提问' }), '帮我看看这段交流')
    expect(screen.getByRole('button', { name: '发送给 AI' })).toBeDisabled()
    await user.click(screen.getByRole('link', { name: 'Whomi 首页' }))
    expect(screen.queryByText('先确认页面范围。')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '收起侧栏' })).toBeInTheDocument()
  })

  it('窄屏用键盘进入导入页时关闭覆盖面板并转移焦点', async () => {
    setViewport(true)
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: '展开侧栏' }))
    screen.getByRole('button', { name: '导入会话' }).focus()
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: '选择文件' })).toHaveFocus())
    expect(screen.getByRole('main')).not.toHaveAttribute('inert')
    await user.click(screen.getByRole('button', { name: '展开侧栏' }))
    await user.click(screen.getByRole('button', { name: '导入会话' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '选择文件' })).toHaveFocus())
  })
})
