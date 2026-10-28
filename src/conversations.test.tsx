import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

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

  it('阅读只显示原文，品牌返回 Hello 后卸载正文', async () => {
    const user = userEvent.setup()
    render(<App conversations={conversations} />)
    await user.click(screen.getByRole('button', { name: '展开会话列表' }))
    await user.click(screen.getByRole('button', { name: '项目讨论' }))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '发送' })).not.toBeInTheDocument()
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
