import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useConversations, type ConversationClient } from './use-conversations'
import type { MessagePage, MessageView, SourceWindow } from '../shared/desktop-api'
import { createPreviewClient } from './preview-client'

// 全部编号、正文和会话均为虚构测试资料。
function message(index: number): MessageView {
  return { id: String(index), conversationId: '1', memberId: null, senderKind: 'member', senderName: '示例成员', isSelf: false,
    sentAtMs: index, timeRaw: null, timePrecision: 'millisecond', timezone: null, timeBucket: 0, sortTime: index,
    ordinal: index, kind: 'text', sourceType: null, text: `示例消息 ${index}`, reply: null, attachments: [] }
}
function page(start: number, total = 13000): MessagePage {
  const end = Math.min(start + 99, total)
  return { items: Array.from({ length: end - start + 1 }, (_, i) => message(start + i)),
    beforeCursor: start > 1 ? String(start) : null, afterCursor: end < total ? String(end) : null, snapshotMaxId: String(total) }
}
function client(): ConversationClient {
  return { listConversations: vi.fn(async () => ({ items: [{ id: '1', title: '虚构会话', kind: 'direct' as const, messageCount: 13000,
    memberCount: 2, firstSentAtMs: 1, lastSentAtMs: 13000, summaryStatus: 'ready' as const }], nextCursor: null })),
    readMessages: vi.fn(async input => page(input.cursor ? Number(input.cursor) + (input.direction === 'after' ? 1 : -100) : 1)),
    locateSource: vi.fn(async () => ({ status: 'available', conversationId: '1', startMessageId: '12000', endMessageId: '12900',
      start: message(12000), end: message(12900), page: page(11980), rangeEndCursor: '12900' } as SourceWindow)) }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('持久会话分页状态', () => {
  it('开发预览在不足一页的前文边界不重复消息', async () => {
    const api = createPreviewClient([{ id: 'preview', title: '虚构短上下文', messages: Array.from({ length: 150 }, (_, index) => ({
      id: String(index), sender: '示例成员', text: `虚构记录 ${index}`,
    })) }])
    const { result } = renderHook(() => useConversations(api))
    await act(async () => { await result.current.locate({ conversationId: 'preview', messageId: '30' }) })
    await act(async () => { await result.current.loadBefore() })
    const ids = result.current.current!.messages.map(message => message.id)
    expect(ids).toHaveLength(110)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids[0]).toBe('0')
  })

  it('列表只使用摘要，打开会话只请求 100 条第一页', async () => {
    const api = client()
    const { result } = renderHook(() => useConversations(api))
    await waitFor(() => expect(result.current.conversations).toHaveLength(1))
    expect(api.readMessages).not.toHaveBeenCalled()
    await act(async () => { await result.current.open('1') })
    expect(api.readMessages).toHaveBeenCalledExactlyOnceWith({ conversationId: '1', direction: 'after', limit: 100 })
    expect(result.current.current!.messages).toHaveLength(100)
  })

  it('第 12000 条只定位一次，范围跨页持续，5 页窗口可双向恢复', async () => {
    const api = client()
    const { result } = renderHook(() => useConversations(api))
    const request = { conversationId: '1', messageId: '12000', endMessageId: '12900' }
    await act(async () => { await result.current.locate(request) })
    expect(api.locateSource).toHaveBeenCalledExactlyOnceWith(request)
    expect(api.readMessages).not.toHaveBeenCalled()
    expect(result.current.current!.messages[20].id).toBe('12000')
    for (let i = 0; i < 6; i++) await act(async () => { await result.current.loadAfter() })
    expect(result.current.current!.messages).toHaveLength(500)
    expect(result.current.current!.messages[0].id).toBe('12180')
    expect(result.current.current!.range).toMatchObject({ start: { id: '12000' }, end: { id: '12900' } })
    await act(async () => { await result.current.loadBefore() })
    expect(result.current.current!.messages).toHaveLength(500)
    expect(result.current.current!.messages[0].id).toBe('12080')
    expect(result.current.current!.afterCursor).not.toBeNull()
    expect(api.locateSource).toHaveBeenCalledTimes(1)
  })

  it('切换后晚返回的打开和定位请求不能覆盖新会话', async () => {
    const api = client()
    const old = deferred<MessagePage>()
    const locate = deferred<SourceWindow>()
    vi.mocked(api.readMessages).mockImplementationOnce(() => old.promise)
    vi.mocked(api.locateSource).mockImplementationOnce(() => locate.promise)
    const { result } = renderHook(() => useConversations(api))
    let pending!: Promise<void>
    act(() => { pending = result.current.open('old') })
    await act(async () => { await result.current.open('new') })
    await act(async () => { old.resolve(page(1)); await pending })
    expect(result.current.current!.conversationId).toBe('new')
    act(() => { pending = result.current.locate({ conversationId: 'old', messageId: '12000' }).then(() => {}) })
    await act(async () => { await result.current.open('new') })
    await act(async () => { locate.resolve({ status: 'unavailable' }); await pending })
    expect(result.current.current!.conversationId).toBe('new')
    expect(result.current.current!.sourceStatus).not.toBe('unavailable')
  })

  it('刷新列表丢弃旧翻页结果，列表加载更多保持已有顺序', async () => {
    const api = client()
    vi.mocked(api.listConversations).mockResolvedValueOnce({ items: [], nextCursor: 'next' })
    const { result } = renderHook(() => useConversations(api))
    await waitFor(() => expect(result.current.listCursor).toBe('next'))
    await act(async () => { await result.current.loadMore() })
    expect(result.current.conversations.map((item: { id: string }) => item.id)).toEqual(['1'])
    await act(async () => { await result.current.open('1') })
    const old = deferred<MessagePage>()
    vi.mocked(api.readMessages).mockImplementationOnce(() => old.promise)
    let pending!: Promise<void>
    act(() => { pending = result.current.loadAfter() })
    await act(async () => { await result.current.refresh() })
    await act(async () => { old.resolve(page(101)); await pending })
    expect(result.current.current!.messages).toHaveLength(100)
  })

  it('引用跨页成功只替换消息页，失败保留原页，不增加来源范围与常驻提示', async () => {
    const api = client()
    const { result } = renderHook(() => useConversations(api))
    await act(async () => { await result.current.open('1') })
    await act(async () => { expect(await result.current.locate({ conversationId: '1', messageId: '12000' }, { preserveOnFailure: true })).toBe(true) })
    expect(result.current.current!.messages[20].id).toBe('12000')
    expect(result.current.current!.sourceStatus).toBeUndefined()
    expect(result.current.current!.range).toBeUndefined()
    const original = result.current.current
    vi.mocked(api.locateSource).mockResolvedValueOnce({ status: 'unavailable' })
    await act(async () => { expect(await result.current.locate({ conversationId: '1', messageId: 'absent' }, { preserveOnFailure: true })).toBe(false) })
    expect(result.current.current).toBe(original)
  })

  it('定位失败明确标记原文不可用，无客户端不会伪造会话', async () => {
    const api = client()
    vi.mocked(api.locateSource).mockRejectedValueOnce(new Error('private detail'))
    const { result, unmount } = renderHook(() => useConversations(api))
    await act(async () => { await result.current.locate({ conversationId: '1', messageId: '12000' }) })
    expect(result.current.current!.sourceStatus).toBe('unavailable')
    expect(String(result.current.error)).not.toContain('private detail')
    unmount()
    const empty = renderHook(() => useConversations())
    expect(empty.result.current.available).toBe(false)
    expect(empty.result.current.conversations).toEqual([])
  })

  it('刷新中断定位时结束等待状态，晚返回不能重新恢复定位结果', async () => {
    const api = client()
    const old = deferred<SourceWindow>()
    vi.mocked(api.locateSource).mockReturnValueOnce(old.promise)
    const { result } = renderHook(() => useConversations(api))
    let pending!: Promise<void>
    act(() => { pending = result.current.locate({ conversationId: '1', messageId: '12000' }).then(() => {}) })
    await act(async () => { await result.current.refresh() })
    expect(result.current.loading).toBe(false)
    expect(result.current.current!.sourceStatus).toBe('unavailable')
    await act(async () => { old.resolve({ status: 'unavailable' }); await pending })
    expect(result.current.current!.sourceStatus).toBe('unavailable')
  })

  it('客户端替换和卸载后不接收旧列表或消息页', async () => {
    const first = client(), second = client()
    const oldList = deferred<Awaited<ReturnType<ConversationClient['listConversations']>>>()
    const oldMessages = deferred<MessagePage>()
    vi.mocked(first.listConversations).mockReturnValueOnce(oldList.promise)
    vi.mocked(first.readMessages).mockReturnValueOnce(oldMessages.promise)
    const { result, rerender, unmount } = renderHook(({ api }) => useConversations(api), { initialProps: { api: first } })
    let pending!: Promise<void>
    act(() => { pending = result.current.open('old') })
    rerender({ api: second })
    await waitFor(() => expect(result.current.conversations[0]?.id).toBe('1'))
    await act(async () => { oldList.resolve({ items: [], nextCursor: null }); oldMessages.resolve(page(1)); await pending })
    expect(result.current.conversations[0].id).toBe('1')
    expect(result.current.current).toBeUndefined()
    const detached = deferred<MessagePage>()
    vi.mocked(second.readMessages).mockReturnValueOnce(detached.promise)
    act(() => { pending = result.current.open('detached') })
    unmount()
    await act(async () => { detached.resolve(page(1)); await pending })
  })
})
