import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { MouseEvent, PointerEvent } from 'react'
import type { MessageView } from '../../shared/desktop-api'
import { useMessageSelection } from './selection'

const messages: MessageView[] = ['1', '2'].map(id => ({
  id, conversationId: 'example', memberId: null, senderKind: 'member', senderName: '示例成员',
  isSelf: false, sentAtMs: null, timeRaw: null, timePrecision: 'unknown', timezone: null,
  timeBucket: 0, sortTime: Number(id), ordinal: Number(id), kind: 'text', sourceType: null,
  text: `示例消息 ${id}`, reply: null, attachments: [],
}))
function pointer(element: HTMLElement, pointerId = 1) {
  return { button: 0, isPrimary: true, pointerId, clientX: 10, clientY: 10, currentTarget: element,
    preventDefault: vi.fn() } as unknown as PointerEvent<HTMLElement>
}
function dispatch(target: EventTarget, name: string, pointerId = 1) {
  const event = new Event(name, { bubbles: true })
  Object.defineProperty(event, 'pointerId', { value: pointerId })
  target.dispatchEvent(event)
}
function setup() {
  vi.useFakeTimers()
  const reader = document.createElement('div'), item = document.createElement('div')
  reader.className = 'reader-scroll'
  item.dataset.messageId = '2'
  reader.append(item)
  document.body.append(reader)
  const { result } = renderHook(() => useMessageSelection(messages))
  act(() => result.current.bindings(messages[0]).onClick({} as MouseEvent<HTMLElement>))
  act(() => result.current.bindings(messages[1]).onPointerDown(pointer(item)))
  return { reader, item, result }
}
afterEach(() => { vi.useRealTimers(); document.querySelectorAll('.reader-scroll').forEach(element => element.remove()) })

it.each(['blur', 'lostpointercapture'])('长按选择遇到%s时结束手势并恢复原有选择，下一次点击正常', event => {
  const { reader, item, result } = setup()
  act(() => vi.advanceTimersByTime(250))
  expect(reader).toHaveAttribute('data-selection-dragging', 'true')
  expect([...result.current.selectedIds]).toEqual(['1', '2'])

  act(() => dispatch(event === 'blur' ? window : item, event))
  expect(reader).not.toHaveAttribute('data-selection-dragging')
  expect([...result.current.selectedIds]).toEqual(['1'])
  act(() => {
    result.current.bindings(messages[1]).onPointerDown(pointer(item, 3))
    dispatch(document, 'pointerup', 3)
    result.current.bindings(messages[1]).onClick({} as MouseEvent<HTMLElement>)
  })
  expect([...result.current.selectedIds]).toEqual(['1', '2'])
})

it('长按尚未成立时窗口失焦，定时器不能稍后开始选择', () => {
  const { reader, result } = setup()
  act(() => { dispatch(window, 'blur'); vi.advanceTimersByTime(300) })
  expect(reader).not.toHaveAttribute('data-selection-dragging')
  expect([...result.current.selectedIds]).toEqual(['1'])
})

it.each(['pointerup', 'pointercancel'])('另一根指针的%s不会结束当前长按，原指针释放后正常结束', event => {
  const { reader, result } = setup()
  act(() => vi.advanceTimersByTime(250))
  act(() => dispatch(document, event, 2))
  expect(reader).toHaveAttribute('data-selection-dragging', 'true')
  expect([...result.current.selectedIds]).toEqual(['1', '2'])
  act(() => dispatch(document, 'pointerup', 1))
  expect(reader).not.toHaveAttribute('data-selection-dragging')
  expect([...result.current.selectedIds]).toEqual(['1', '2'])
})
