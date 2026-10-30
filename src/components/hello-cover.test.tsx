import { createRef } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { HelloCover } from './hello-cover'

function mountCover(onEnter = vi.fn()) {
  const result = render(<HelloCover name="" buttonRef={createRef()} onEnter={onEnter}>
    <h2>示例总览内容</h2><button type="button">示例反馈操作</button>
  </HelloCover>)
  return { ...result, onEnter, button: screen.getByRole('button', { name: /进入个人总览/ }) }
}

describe('Hello 总览预览与进入过渡', () => {
  it('自动聚焦不显示键盘边框，Tab 导航保留焦点提示，鼠标按下后收起', () => {
    const { container, button } = mountCover()
    button.focus()
    expect(container.firstChild).toHaveAttribute('data-keyboard-focus', 'false')
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(container.firstChild).toHaveAttribute('data-keyboard-focus', 'true')
    fireEvent.pointerDown(button)
    expect(container.firstChild).toHaveAttribute('data-keyboard-focus', 'false')
  })
  it('鼠标经过才挂载总览预览，预览对键盘和辅助技术保持隔离，移开恢复遮挡', async () => {
    const user = userEvent.setup()
    const { button, onEnter, container } = mountCover()
    expect(screen.queryByText('示例总览内容')).not.toBeInTheDocument()

    await user.hover(button)

    const preview = screen.getByText('示例总览内容').parentElement!
    expect(preview).toHaveAttribute('inert')
    expect(preview).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByRole('button', { name: '示例反馈操作' })).not.toBeInTheDocument()
    expect(container.firstChild).toHaveClass('is-peeking')
    expect(onEnter).not.toHaveBeenCalled()

    await user.unhover(button)
    expect(container.firstChild).not.toHaveClass('is-peeking')
    expect(onEnter).not.toHaveBeenCalled()
  })

  it('触摸经过不触发悬停预览，按下后完成遮罩渐隐才进入且只进入一次', () => {
    const { button, onEnter, container } = mountCover()
    fireEvent.pointerEnter(button, { pointerType: 'touch' })
    expect(screen.queryByText('示例总览内容')).not.toBeInTheDocument()
    fireEvent.click(button)
    fireEvent.click(button)
    expect(container.firstChild).toHaveClass('is-revealing')
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(onEnter).not.toHaveBeenCalled()

    const veil = container.querySelector('.hello-cover-veil')!
    fireEvent.transitionEnd(veil, { propertyName: 'opacity' })
    fireEvent.transitionEnd(veil, { propertyName: 'opacity' })
    expect(onEnter).toHaveBeenCalledTimes(1)
  })

  it('过渡事件缺失仍能完成进入，离开封面会清理待完成回调', () => {
    vi.useFakeTimers()
    try {
      const first = mountCover()
      fireEvent.click(first.button)
      act(() => { vi.advanceTimersByTime(700) })
      expect(first.onEnter).toHaveBeenCalledTimes(1)
      first.unmount()

      const second = mountCover()
      fireEvent.click(second.button)
      second.unmount()
      act(() => { vi.advanceTimersByTime(1000) })
      expect(second.onEnter).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('减少动态效果时点击直接进入，不等待动画', () => {
    const media = window.matchMedia('')
    vi.spyOn(window, 'matchMedia').mockReturnValue({ ...media, matches: true })
    const { button, onEnter, container } = mountCover()
    fireEvent.click(button)
    expect(onEnter).toHaveBeenCalledTimes(1)
    expect(container.firstChild).not.toHaveClass('is-revealing')
  })
})
