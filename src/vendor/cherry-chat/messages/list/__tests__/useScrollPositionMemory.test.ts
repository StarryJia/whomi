import { act, renderHook } from '@testing-library/react'
import type { VListHandle } from 'virtua'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  computeScrollAnchor,
  forgetScrollPosition,
  resolveRestoreTarget,
  type ScrollPositionMemoryInputs,
  useScrollPositionMemory
} from '../useScrollPositionMemory'

describe('computeScrollAnchor', () => {
  it('returns null when the list is following', () => {
    expect(
      computeScrollAnchor({
        following: true,
        scrollOffset: 1234,
        topIndex: 4,
        getKeyAtIndex: () => 'g4',
        getOffsetAtIndex: () => 0
      })
    ).toBeNull()
  })

  it('returns null when the top-most item is out of range', () => {
    expect(
      computeScrollAnchor({
        following: false,
        scrollOffset: 100,
        topIndex: 9,
        getKeyAtIndex: () => null,
        getOffsetAtIndex: () => 0
      })
    ).toBeNull()
  })

  it('captures the top-most visible group key and the offset past its top', () => {
    expect(
      computeScrollAnchor({
        following: false,
        scrollOffset: 250,
        topIndex: 3,
        getKeyAtIndex: (index) => (index === 3 ? 'g3' : null),
        getOffsetAtIndex: (index) => (index === 3 ? 100 : 0)
      })
    ).toEqual({ key: 'g3', offset: 150 })
  })

  it('clamps a negative offset to zero', () => {
    expect(
      computeScrollAnchor({
        following: false,
        scrollOffset: 80,
        topIndex: 2,
        getKeyAtIndex: () => 'g2',
        getOffsetAtIndex: () => 120
      })
    ).toEqual({ key: 'g2', offset: 0 })
  })
})

describe('resolveRestoreTarget', () => {
  it('follows the newest message (end-aligned, bottom offset) when nothing is saved', () => {
    expect(resolveRestoreTarget(null, () => 5, 9, 24)).toEqual({ index: 9, align: 'end', offset: 24 })
    expect(resolveRestoreTarget(undefined, () => 5, 9, 24)).toEqual({ index: 9, align: 'end', offset: 24 })
  })

  it('follows the newest message when the saved message no longer exists', () => {
    expect(resolveRestoreTarget({ key: 'gone', offset: 40 }, () => -1, 9, 24)).toEqual({
      index: 9,
      align: 'end',
      offset: 24
    })
  })

  it('restores the saved anchor (start-aligned, saved offset) when the message is found', () => {
    expect(resolveRestoreTarget({ key: 'g7', offset: 40 }, (key) => (key === 'g7' ? 7 : -1), 9, 24)).toEqual({
      index: 7,
      align: 'start',
      offset: 40
    })
  })
})

describe('useScrollPositionMemory', () => {
  let rafQueue: Map<number, () => void>

  const flushRaf = () => {
    let guard = 0
    // Restore schedules a frame which itself schedules a settle frame.
    while (rafQueue.size && guard++ < 20) {
      const batch = [...rafQueue.values()]
      rafQueue = new Map()
      act(() => batch.forEach((fn) => fn()))
    }
  }

  let scroller: { scrollTop: number; scrollHeight: number; clientHeight: number }
  let handle: {
    findItemIndex: ReturnType<typeof vi.fn>
    getItemOffset: ReturnType<typeof vi.fn>
    scrollToIndex: ReturnType<typeof vi.fn>
  }
  let following: boolean
  let enterFollowingAfterRestore: ReturnType<typeof vi.fn<() => void>>
  let enterReadingForRestore: ReturnType<typeof vi.fn<() => void>>
  let settleReadingRestore: ReturnType<typeof vi.fn<() => void>>
  let keysByIndex: Record<number, string>

  const buildInputs = (overrides: Partial<ScrollPositionMemoryInputs> = {}): ScrollPositionMemoryInputs => ({
    topicId: 't1',
    itemCount: 3,
    bottomPadding: 24,
    scrollerRef: { current: scroller as unknown as HTMLElement },
    vlistHandleRef: { current: handle as unknown as VListHandle },
    getDataKeyAtIndex: (index) => keysByIndex[index] ?? null,
    findDataIndexByKey: (key) => {
      const found = Object.entries(keysByIndex).find(([, k]) => k === key)
      return found ? Number(found[0]) : -1
    },
    shouldRestore: () => true,
    isFollowing: () => following,
    enterFollowingAfterRestore,
    enterReadingForRestore,
    settleReadingRestore,
    isAnimating: () => false,
    ...overrides
  })

  beforeEach(() => {
    rafQueue = new Map()
    let id = 0
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.set(id + 1, () => cb(0))
      return ++id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { rafQueue.delete(id) })
    forgetScrollPosition('t1')
    forgetScrollPosition('t2')

    scroller = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 }
    handle = { findItemIndex: vi.fn(), getItemOffset: vi.fn(), scrollToIndex: vi.fn() }
    following = false
    enterFollowingAfterRestore = vi.fn<() => void>()
    enterReadingForRestore = vi.fn<() => void>()
    settleReadingRestore = vi.fn<() => void>()
    keysByIndex = { 0: 'g0', 1: 'g1', 2: 'g2' }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps explicit navigation when it takes ownership before the initial restore frame', () => {
    let ownsInitialRestore = true
    renderHook(() => useScrollPositionMemory(buildInputs({ shouldRestore: () => ownsInitialRestore })))
    scroller.scrollTop = 250
    ownsInitialRestore = false
    flushRaf()
    expect(scroller.scrollTop).toBe(250)
    expect(handle.scrollToIndex).not.toHaveBeenCalled()
    expect(enterFollowingAfterRestore).not.toHaveBeenCalled()
  })

  it('restores the saved anchor without counting the viewport top spacer twice', () => {
    const first = renderHook(() => useScrollPositionMemory(buildInputs({ topPadding: 6 })))
    flushRaf()
    scroller.scrollTop = 180
    handle.findItemIndex.mockReturnValue(2)
    handle.getItemOffset.mockReturnValue(100)
    act(() => first.result.current.save(true))
    first.unmount()
    handle.scrollToIndex.mockClear()

    const second = renderHook(() => useScrollPositionMemory(buildInputs({ topicId: 't2' })))
    flushRaf()
    expect(handle.scrollToIndex).toHaveBeenCalledWith(2, { align: 'end', offset: 24 })
    second.unmount()
    handle.scrollToIndex.mockClear()

    renderHook(() => useScrollPositionMemory(buildInputs({ topPadding: 6 })))
    flushRaf()
    expect(handle.scrollToIndex).toHaveBeenCalledWith(2, { align: 'start', offset: 74 })
    expect(enterReadingForRestore).toHaveBeenCalledTimes(1)
    expect(settleReadingRestore).toHaveBeenCalledTimes(1)
  })
  it('follows the newest message via scrollToIndex(end) when nothing is saved', () => {
    renderHook(() => useScrollPositionMemory(buildInputs()))
    flushRaf()

    // last index (itemCount - 1), end-aligned, offset by the bottom padding.
    expect(handle.scrollToIndex).toHaveBeenCalledWith(2, { align: 'end', offset: 24 })
    expect(enterFollowingAfterRestore).toHaveBeenCalledTimes(1)
    expect(scroller.scrollTop).toBe(0) // not touched directly while the handle exists
  })

  it('falls back to scrollTop when no virtua handle is available', () => {
    renderHook(() => useScrollPositionMemory(buildInputs({ vlistHandleRef: { current: null } })))
    flushRaf()

    expect(scroller.scrollTop).toBe(600) // scrollHeight - clientHeight
    expect(enterFollowingAfterRestore).toHaveBeenCalledTimes(1)
  })

  it('waits for items before restoring', () => {
    const { rerender } = renderHook((props: ScrollPositionMemoryInputs) => useScrollPositionMemory(props), {
      initialProps: buildInputs({ itemCount: 0 })
    })
    flushRaf()
    expect(enterFollowingAfterRestore).not.toHaveBeenCalled()

    rerender(buildInputs({ itemCount: 3 }))
    flushRaf()
    expect(enterFollowingAfterRestore).toHaveBeenCalledTimes(1)
  })

  it('restores the newest message when React repeats mount effects', () => {
    renderHook(() => useScrollPositionMemory(buildInputs()), { reactStrictMode: true })
    flushRaf()
    expect(handle.scrollToIndex).toHaveBeenCalledWith(2, { align: 'end', offset: 24 })
    expect(enterFollowingAfterRestore).toHaveBeenCalledTimes(1)
  })
})
