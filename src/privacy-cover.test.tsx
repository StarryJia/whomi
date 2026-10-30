import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import gsap from 'gsap'
import App from './App'

function enableStartupMotion() {
  const mediaQuery = window.matchMedia('(max-width: 640px)')
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    ...mediaQuery,
    media: query,
    matches: false,
  }))
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 16, y: 16, left: 16, top: 16, width: 50, height: 50,
    bottom: 66, right: 66, toJSON: () => ({}),
  })
}

beforeEach(() => {
  const mediaQuery = window.matchMedia('(max-width: 640px)')
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    ...mediaQuery,
    media: query,
    matches: query === '(prefers-reduced-motion: reduce)',
  }))
})

describe('Hello 隐私封面', () => {
  it('封面只显示问候，侧栏在分析上方提供个人总览入口', () => {
    render(<App />)

    const main = screen.getByRole('main')
    expect(within(main).getByRole('heading', { level: 1 })).toHaveTextContent(/^Hello$/)
    expect(screen.queryByText('还没有可查看的总览。')).not.toBeInTheDocument()
    expect(within(main).queryByRole('button', { name: '返回 Hello' })).not.toBeInTheDocument()
    const navigation = within(screen.getByRole('navigation', { name: '主导航' }))
    expect(navigation.queryByRole('button', { name: '个人仪表台' })).not.toBeInTheDocument()
    const destinations = navigation.getAllByRole('button')
    expect(destinations[0]).toHaveAccessibleName('个人总览')
    expect(destinations[1]).toHaveAccessibleName('分析管理')
    expect(within(main).queryByText('点击任意位置，进入个人总览')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '个人总览' })).not.toBeInTheDocument()
  })

  it.each([false, true])('侧栏可直接进入总览并聚焦标题，窄屏：%s', async (isMobile) => {
    const mediaQuery = window.matchMedia('(max-width: 640px)')
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      ...mediaQuery, media: query,
      matches: query === '(prefers-reduced-motion: reduce)' || (query === '(max-width: 640px)' && isMobile),
    }))
    const user = userEvent.setup()
    render(<App />)
    if (isMobile) await user.click(screen.getByRole('button', { name: '展开侧栏' }))

    const overviewMenu = screen.getByRole('button', { name: '个人总览' })
    await user.click(overviewMenu)

    await waitFor(() => expect(screen.getByRole('heading', { name: '个人总览' })).toHaveFocus())
    expect(overviewMenu).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('dialog', { name: '导航面板' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: isMobile ? '展开侧栏' : '收起侧栏' })).toBeInTheDocument()
  })

  it('聚焦 Hello 时保留封面', () => {
    render(<App />)

    const hello = screen.getByRole('button', { name: /进入个人总览/ })
    hello.focus()

    expect(hello).toHaveFocus()
    expect(screen.queryByRole('heading', { name: '个人总览' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '返回 Hello' })).not.toBeInTheDocument()
  })

  it.each(['{Enter}', ' '])('主动按 %s 后展示个人总览并将焦点移到标题', async (key) => {
    const user = userEvent.setup()
    render(<App />)

    screen.getByRole('button', { name: /进入个人总览/ }).focus()
    await user.keyboard(key)

    await waitFor(() => expect(screen.getByRole('heading', { name: '个人总览' })).toHaveFocus())
    expect(screen.getByText('还没有可查看的总览。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /进入个人总览/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '返回 Hello' })).toBeInTheDocument()
  })

  it('返回 Hello 后移除总览内容并将焦点交还入口', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: /进入个人总览/ }))

    await user.click(screen.getByRole('button', { name: '返回 Hello' }))

    expect(screen.queryByRole('heading', { name: '个人总览' })).not.toBeInTheDocument()
    expect(screen.queryByText('还没有可查看的总览。')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '返回 Hello' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: /进入个人总览/ })).toHaveFocus())
  })

  it.each([false, true])('展开品牌返回封面时保持侧栏状态，窄屏：%s', async (isMobile) => {
    const mediaQuery = window.matchMedia('(max-width: 640px)')
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      ...mediaQuery,
      media: query,
      matches: query === '(prefers-reduced-motion: reduce)' ||
        (query === '(max-width: 640px)' && isMobile),
    }))
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: /进入个人总览/ }))
    if (isMobile) await user.click(screen.getByRole('button', { name: '展开侧栏' }))

    const homeLink = screen.getByRole('link', { name: 'Whomi 首页' })
    await user.click(homeLink)

    expect(screen.queryByRole('heading', { name: '个人总览', hidden: true })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '收起侧栏' })).toHaveAttribute('aria-expanded', 'true')
    if (isMobile) {
      expect(screen.getByRole('dialog', { name: '导航面板' })).toBeInTheDocument()
      await waitFor(() => expect(homeLink).toHaveFocus())
      await user.keyboard('{Escape}')
      expect(screen.getByRole('button', { name: /进入个人总览/ })).toBeInTheDocument()
    } else {
      await waitFor(() => expect(screen.getByRole('button', { name: /进入个人总览/ })).toHaveFocus())
    }
  })

  it('重新打开应用时回到封面，不恢复上次打开的总览', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<App />)
    await user.click(screen.getByRole('button', { name: /进入个人总览/ }))
    expect(screen.getByRole('heading', { name: '个人总览' })).toBeInTheDocument()

    unmount()
    render(<App />)

    expect(screen.getByRole('button', { name: /进入个人总览/ })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '个人总览' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '返回 Hello' })).not.toBeInTheDocument()
  })

  it('封面进入动画中点击品牌会取消进入，旧回调不会再次打开总览', () => {
    enableStartupMotion()
    render(<App />)
    act(() => { gsap.getById('whomi-startup')?.pause().time(3.8, false) })
    vi.useFakeTimers()
    try {
      fireEvent.click(screen.getByRole('button', { name: /进入个人总览/ }))
      expect(document.querySelector('.hello-cover')).toHaveClass('is-revealing')
      fireEvent.click(screen.getByRole('link', { name: 'Whomi 首页' }))
      act(() => { vi.advanceTimersByTime(1000) })
      expect(screen.getByRole('button', { name: /进入个人总览/ })).toBeInTheDocument()
      expect(document.querySelector('.hello-cover')).not.toHaveClass('is-revealing')
      expect(screen.queryByRole('heading', { name: '个人总览' })).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('开场期间隔离背景，自动结束后可进入总览且品牌返回不重播', async () => {
    enableStartupMotion()
    const user = userEvent.setup()
    render(<App />)

    const main = screen.getByRole('main', { hidden: true })
    const sidebar = screen.getByLabelText('应用导航')
    expect(main).toHaveAttribute('inert')
    expect(sidebar).toHaveAttribute('inert')
    expect(screen.queryByRole('button', { name: '跳过开场动画' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重播开场动画' })).not.toBeInTheDocument()
    act(() => { gsap.getById('whomi-startup')?.pause().time(3.8, false) })

    await waitFor(() => expect(screen.getByRole('button', { name: /进入个人总览/ })).toHaveFocus())
    expect(main).not.toHaveAttribute('inert')
    expect(sidebar).not.toHaveAttribute('inert')
    expect(screen.queryByRole('button', { name: '跳过开场动画' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /进入个人总览/ }))
    await user.click(screen.getByRole('link', { name: 'Whomi 首页' }))

    await waitFor(() => expect(screen.getByRole('button', { name: /进入个人总览/ })).toHaveFocus())
    expect(screen.queryByRole('heading', { name: '个人总览' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '跳过开场动画' })).not.toBeInTheDocument()
  })

  it('开场和封面均无重播或跳过按钮，Escape 结束后保留可操作封面', async () => {
    enableStartupMotion()
    const user = userEvent.setup()
    render(<App />)
    expect(screen.queryByRole('button', { name: '跳过开场动画' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重播开场动画' })).not.toBeInTheDocument()
    expect(screen.getByRole('main', { hidden: true })).toHaveAttribute('inert')
    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.getByRole('button', { name: /进入个人总览/ })).toHaveFocus())
    expect(screen.queryByRole('heading', { name: '个人总览' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '跳过开场动画' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重播开场动画' })).not.toBeInTheDocument()
    expect(screen.getByRole('main')).not.toHaveAttribute('inert')
  })
})
