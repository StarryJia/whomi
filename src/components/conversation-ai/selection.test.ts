import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react'
import type { MessageView } from '../../shared/desktop-api'
import { compareMessages, groupReferences, useMessageSelection } from './selection'

function message(id: string, sortTime = Number(id)): MessageView {
  return { id, conversationId: 'conversation', memberId: null, senderKind: 'member', senderName: '示例成员',
    isSelf: false, sentAtMs: null, timeRaw: null, timePrecision: 'unknown', timezone: null,
    timeBucket: 0, sortTime, ordinal: 0, kind: 'text', sourceType: null, text: `消息 ${id}`, reply: null, attachments: [] }
}
function click(shiftKey = false) { return { shiftKey } as MouseEvent<HTMLElement> }
function pointer(element: HTMLElement, values: Partial<PointerEvent<HTMLElement>> = {}) {
  return { button: 0, isPrimary: true, pointerId: 1, clientX: 10, clientY: 10, currentTarget: element,
    preventDefault: vi.fn(), ...values } as PointerEvent<HTMLElement>
}
const items = Array.from({ length: 5 }, (_, index) => message(String(index + 1)))

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren() })

describe('消息引用分组', () => {
  it('使用消息真实顺序和已知邻接，而不把全局编号或来源序号当作相邻', () => {
    const first = message('8', 1), middle = message('42', 2), last = message('99', 3)
    const selected = new Map([first, middle, last].map(item => [item.id, item]))
    expect(groupReferences(selected, new Map([['8', '42']])).map(group => group.messages.map(item => item.id)))
      .toEqual([['8', '42'], ['99']])
    expect(groupReferences(selected, new Map()).length).toBe(3)
  })

  it('相同时间的大整数编号排序不损失精度', () => {
    const first = message('9007199254740992', 1), second = message('9007199254740993', 1)
    expect(compareMessages(first, second)).toBe(-1)
    expect(groupReferences(new Map([[second.id, second], [first.id, first]]), new Map([[first.id, second.id]]))[0].messages)
      .toEqual([first, second])
  })

  it('离开分页窗口后保留已选快照，但不跨未知缺口合并引用', () => {
    const { result, rerender } = renderHook(({ loaded }) => useMessageSelection(loaded), { initialProps: { loaded: items.slice(0, 2) } })
    act(() => result.current.bindings(items[1]).onClick(click()))
    rerender({ loaded: items.slice(3) })
    act(() => result.current.bindings(items[3]).onClick(click()))
    expect(result.current.references.map(group => group.messages.map(item => item.id))).toEqual([['2'], ['4']])
    rerender({ loaded: items.slice(1, 4) })
    act(() => result.current.bindings(items[2]).onClick(click()))
    expect(result.current.references.map(group => group.messages.map(item => item.id))).toEqual([['2', '3', '4']])
    act(() => result.current.bindings(items[2]).onClick(click()))
    expect(result.current.references.map(group => group.messages.map(item => item.id))).toEqual([['2'], ['4']])
    act(() => result.current.clear())
    expect(result.current.references).toEqual([])
  })

  it('单击与键盘能够完成选择，Shift 单击按当前连续窗口选择范围', () => {
    const { result } = renderHook(() => useMessageSelection(items))
    act(() => result.current.bindings(items[0]).onClick(click()))
    act(() => result.current.bindings(items[2]).onClick(click(true)))
    expect([...result.current.selectedIds]).toEqual(['1', '2', '3'])
    const preventDefault = vi.fn()
    act(() => result.current.bindings(items[1]).onKeyDown({ key: ' ', preventDefault } as unknown as KeyboardEvent<HTMLElement>))
    expect(preventDefault).toHaveBeenCalled()
    expect(result.current.references.map(group => group.messages.map(item => item.id))).toEqual([['1'], ['3']])
  })
})

describe('长按滑动选择', () => {
  function surface() {
    const reader = document.createElement('div')
    reader.className = 'reader-scroll'
    const nodes = items.map(item => {
      const node = document.createElement('li')
      node.dataset.messageId = item.id
      reader.append(node)
      return node
    })
    document.body.append(reader)
    vi.spyOn(reader, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 300))
    return { reader, nodes }
  }

  it('长按后滚轮滚动且指针不移动时，选区跟随光标下的消息扩展', () => {
    vi.useFakeTimers()
    const { nodes, reader } = surface()
    let hit = nodes[0]
    const original = document.elementFromPoint
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => hit })
    const { result } = renderHook(() => useMessageSelection(items))
    act(() => result.current.bindings(items[0]).onPointerDown(pointer(nodes[0], { clientY: 150 })))
    act(() => vi.advanceTimersByTime(250))
    hit = nodes[3]
    act(() => reader.dispatchEvent(new Event('scroll')))
    expect([...result.current.selectedIds]).toEqual(['1', '2', '3', '4'])
    act(() => document.dispatchEvent(new Event('pointerup')))
    hit = nodes[4]
    act(() => reader.dispatchEvent(new Event('scroll')))
    expect([...result.current.selectedIds]).toEqual(['1', '2', '3', '4'])
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: original })
  })

  it('长按后连续选择并在反向拖动时缩小，结束不额外切换首条', () => {
    vi.useFakeTimers()
    const { nodes, reader } = surface()
    let hit = nodes[0]
    const original = document.elementFromPoint
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => hit })
    const { result } = renderHook(() => useMessageSelection(items))
    act(() => result.current.bindings(items[0]).onPointerDown(pointer(nodes[0], { clientY: 100 })))
    act(() => vi.advanceTimersByTime(250))
    expect(reader.dataset.selectionDragging).toBe('true')
    hit = nodes[3]
    act(() => result.current.bindings(items[0]).onPointerMove(pointer(nodes[0], { clientY: 150 })))
    expect([...result.current.selectedIds]).toEqual(['1', '2', '3', '4'])
    hit = nodes[1]
    act(() => result.current.bindings(items[0]).onPointerMove(pointer(nodes[0], { clientY: 120 })))
    expect([...result.current.selectedIds]).toEqual(['1', '2'])
    act(() => result.current.bindings(items[0]).onPointerUp(pointer(nodes[0])))
    act(() => result.current.bindings(items[0]).onClick(click()))
    expect([...result.current.selectedIds]).toEqual(['1', '2'])
    expect(reader.dataset.selectionDragging).toBeUndefined()
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: original })
  })

  it('长按前的移动保留原生滚动或文字选择，不触发消息选择', () => {
    vi.useFakeTimers()
    const { nodes } = surface()
    const { result } = renderHook(() => useMessageSelection(items))
    act(() => result.current.bindings(items[0]).onPointerDown(pointer(nodes[0])))
    const moved = pointer(nodes[0], { clientY: 40 })
    act(() => result.current.bindings(items[0]).onPointerMove(moved))
    act(() => vi.advanceTimersByTime(500))
    act(() => result.current.bindings(items[0]).onPointerUp(pointer(nodes[0])))
    act(() => result.current.bindings(items[0]).onClick(click()))
    expect(result.current.selectedIds.size).toBe(0)
    expect(moved.preventDefault).not.toHaveBeenCalled()
  })

  it('指针取消恢复初始选择，提前松开和卸载均取消长按任务', () => {
    vi.useFakeTimers()
    const { nodes } = surface()
    const { result, unmount } = renderHook(() => useMessageSelection(items))
    act(() => result.current.bindings(items[4]).onClick(click()))
    act(() => result.current.bindings(items[0]).onPointerDown(pointer(nodes[0])))
    act(() => vi.advanceTimersByTime(250))
    expect(result.current.selectedIds.has('1')).toBe(true)
    act(() => result.current.bindings(items[0]).onPointerCancel(pointer(nodes[0])))
    expect([...result.current.selectedIds]).toEqual(['5'])
    act(() => result.current.bindings(items[0]).onPointerDown(pointer(nodes[0])))
    act(() => document.dispatchEvent(new Event('pointerup')))
    act(() => vi.advanceTimersByTime(500))
    expect([...result.current.selectedIds]).toEqual(['5'])
    act(() => result.current.bindings(items[0]).onPointerDown(pointer(nodes[0])))
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
