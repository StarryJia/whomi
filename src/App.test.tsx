import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

const sidebarStorageKey = 'whomi:sidebar-open'
const unavailableDestinations = [
  '分析',
  '设置',
]

beforeEach(() => {
  const mediaQuery = window.matchMedia('(max-width: 640px)')
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    ...mediaQuery,
    media: query,
    matches: query === '(prefers-reduced-motion: reduce)',
  }))
})

describe('Whomi 首页', () => {
  it('展开时收起按钮位于顶部，Logo 保留返回首页操作', () => {
    render(<App />)
    const sidebar = screen.getByLabelText('应用导航')
    const header = sidebar.querySelector('header')!

    expect(within(header).getByRole('link', { name: 'Whomi 首页' })).toBeInTheDocument()
    expect(within(header).getByRole('button', { name: '收起侧栏' })).toBeInTheDocument()
    expect(sidebar.querySelector('footer')).not.toContainElement(
      screen.getByRole('button', { name: '收起侧栏' }),
    )
  })

  it('收起后 Logo 悬停提示展开，点击展开后恢复首页链接并转移焦点', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: '收起侧栏' }))

    const logo = screen.getByRole('button', { name: '展开侧栏' })
    expect(logo.querySelector('img')).toBeInTheDocument()
    expect(logo).toHaveFocus()
    expect(screen.queryByRole('link', { name: 'Whomi 首页' })).not.toBeInTheDocument()
    await user.hover(logo)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('展开侧栏')
    expect(logo).toHaveAttribute('aria-expanded', 'false')

    await user.click(logo)
    expect(screen.getByRole('link', { name: 'Whomi 首页' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '收起侧栏' })).toHaveFocus()
  })

  it('没有称呼或只有空白时仅显示 Hello', () => {
    const { rerender } = render(<App />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Hello$/)

    rerender(<App displayName="   " />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Hello$/)
  })

  it.each([false, true])('展开后点击 Logo 返回首页并保持展开，窄屏：%s', async (isMobile) => {
    const mediaQuery = window.matchMedia('(max-width: 640px)')
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      ...mediaQuery,
      media: query,
      matches: query === '(prefers-reduced-motion: reduce)' ||
        (query === '(max-width: 640px)' && isMobile),
    }))
    const user = userEvent.setup()
    render(<App />)
    if (isMobile) await user.click(screen.getByRole('button', { name: '展开侧栏' }))

    const homeLink = screen.getByRole('link', { name: 'Whomi 首页' })
    expect(homeLink).toHaveAttribute('href', '#main-content')
    await user.click(homeLink)

    expect(screen.getByRole('button', { name: '收起侧栏' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('link', { name: 'Whomi 首页' })).toBeInTheDocument()
    if (isMobile) {
      expect(screen.getByRole('dialog', { name: '导航面板' })).toBeInTheDocument()
      expect(homeLink).toHaveFocus()
    }
  })

  it('保留完整长称呼并去除首尾空白', () => {
    const displayName = '一个很长但仍应完整保留的中文称呼'.repeat(5)
    render(<App displayName={`  ${displayName}  `} />)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      `Hello，${displayName}`,
    )
    expect(screen.getByRole('button', { name: /进入个人总览/ })).toHaveAccessibleName(
      new RegExp(`^Hello，${displayName}`),
    )
  })

  it('提供主导航、独立的首页入口和有明确名称的禁用业务入口', () => {
    render(<App />)

    expect(screen.getByRole('navigation', { name: '主导航' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Whomi 首页' })).toHaveAttribute(
      'href',
      '#main-content',
    )
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content')
    expect(screen.getByRole('button', { name: '收起侧栏' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    for (const name of unavailableDestinations) {
      expect(screen.getByRole('button', { name })).toHaveAttribute(
        'aria-disabled',
        'true',
      )
    }
    expect(within(screen.getByRole('main')).getByRole('heading')).toHaveTextContent(
      /^Hello$/,
    )
  })

  it('收展立即更新语义状态，并在重新打开页面后保留选择', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<App />)

    await user.click(screen.getByRole('button', { name: '收起侧栏' }))
    expect(screen.getByRole('button', { name: '展开侧栏' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(window.localStorage.getItem(sidebarStorageKey)).toBe('false')

    unmount()
    render(<App />)
    expect(screen.getByRole('button', { name: '展开侧栏' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )

    await user.click(screen.getByRole('button', { name: '展开侧栏' }))
    expect(screen.getByRole('button', { name: '收起侧栏' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(window.localStorage.getItem(sidebarStorageKey)).toBe('true')
  })

  it('折叠后业务入口仍有名称，点击禁用入口不会改变首页', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: '收起侧栏' }))

    for (const name of unavailableDestinations) {
      const destination = screen.getByRole('button', { name })
      expect(destination).toHaveAttribute('aria-disabled', 'true')
      await user.click(destination)
    }
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Hello$/)
    expect(screen.getByRole('button', { name: '展开侧栏' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })

  it('已保存的侧栏值损坏时回退到展开状态', () => {
    window.localStorage.setItem(sidebarStorageKey, 'not-a-boolean')
    render(<App />)

    expect(screen.getByRole('button', { name: '收起侧栏' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  it('浏览器拒绝读取存储时仍可打开首页和收展侧栏', async () => {
    const user = userEvent.setup()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage is unavailable', 'SecurityError')
    })
    render(<App />)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Hello$/)
    await user.click(screen.getByRole('button', { name: '收起侧栏' }))
    expect(screen.getByRole('button', { name: '展开侧栏' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })

  it('浏览器拒绝保存偏好时仍响应后续收展操作', async () => {
    const user = userEvent.setup()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage quota exceeded', 'QuotaExceededError')
    })
    render(<App />)

    await user.click(screen.getByRole('button', { name: '收起侧栏' }))
    await user.click(screen.getByRole('button', { name: '展开侧栏' }))
    expect(screen.getByRole('button', { name: '收起侧栏' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Hello$/)
  })
})
