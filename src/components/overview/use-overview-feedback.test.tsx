import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useOverviewFeedback } from './use-overview-feedback'
import type { FeedbackReceipt, SparkDiscovery, SparkFeedback } from './types'

const discovery: SparkDiscovery = {
  id: 'care', title: '通过跟进表达关心', observation: '可能更常用行动表达关心。',
  scenes: [], sources: [], feedback: { vote: 'agree', comment: '工作中更明显。' },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('Spark 反馈草稿', () => {
  it.each(['constructor', 'toString', '__proto__'])('标识符 %s 可在初始化前读取，并独立载入已有反馈', (id) => {
    const { result } = renderHook(() => useOverviewFeedback())
    expect(result.current.get(id).draft).toEqual({ vote: null, comment: '' })
    act(() => result.current.initialize([{ ...discovery, id }, discovery]))
    expect(result.current.get(id).draft).toEqual({ vote: 'agree', comment: '工作中更明显。' })
    act(() => result.current.setComment(id, '这个发现的补充。'))
    expect(result.current.get(id).draft.comment).toBe('这个发现的补充。')
    expect(result.current.get('care').draft.comment).toBe('工作中更明显。')
  })

  it.each(['constructor', 'toString', '__proto__'])('标识符 %s 无需初始化即可编辑、提交和重试', async (id) => {
    const submissions: SparkFeedback[] = []
    const { result } = renderHook(() => useOverviewFeedback(async (_id, feedback) => {
      submissions.push(feedback)
      if (submissions.length === 1) throw new Error('offline')
      return { persistence: 'saved', analysis: 'not-requested' }
    }))
    act(() => result.current.toggleVote(id, 'agree'))
    act(() => result.current.setComment(id, '等待保存的补充。'))
    await act(() => result.current.submit(id))
    expect(result.current.get(id).error).toBe(true)
    await act(() => result.current.retry(id))
    expect(result.current.get(id).receiptMatchesDraft).toBe(true)
    expect(submissions).toEqual([
      { vote: 'agree', comment: '等待保存的补充。' },
      { vote: 'agree', comment: '等待保存的补充。' },
    ])
    expect(result.current.get('care').draft).toEqual({ vote: null, comment: '' })
  })

  it('只在首次见到发现时装入已有反馈，并按发现隔离草稿', () => {
    const { result } = renderHook(() => useOverviewFeedback())
    act(() => result.current.initialize([discovery]))
    expect(result.current.get('care').draft).toEqual({ vote: 'agree', comment: '工作中更明显。' })
    act(() => result.current.setComment('care', '只对熟悉的朋友这样。'))
    act(() => result.current.initialize([discovery]))
    expect(result.current.get('care').draft.comment).toBe('只对熟悉的朋友这样。')
    expect(result.current.get('other').draft).toEqual({ vote: null, comment: '' })
  })

  it('赞同与不赞同互斥，再次选择同一项可以取消', () => {
    const { result } = renderHook(() => useOverviewFeedback())
    act(() => result.current.toggleVote('care', 'agree'))
    expect(result.current.get('care').draft.vote).toBe('agree')
    act(() => result.current.toggleVote('care', 'disagree'))
    expect(result.current.get('care').draft.vote).toBe('disagree')
    act(() => result.current.toggleVote('care', 'disagree'))
    expect(result.current.get('care').draft.vote).toBeNull()
  })

  it('没有保存接口时保留直接评论，不返回保存回执', async () => {
    const { result } = renderHook(() => useOverviewFeedback())
    act(() => result.current.setComment('care', '当时只是顺手问了一句。'))
    await act(() => result.current.submit('care'))
    expect(result.current.canSave).toBe(false)
    expect(result.current.get('care').draft.comment).toBe('当时只是顺手问了一句。')
    expect(result.current.get('care').receipt).toBeUndefined()
  })

  it('旧提交完成后保留提交期间的新草稿，且不把新输入显示为已保存', async () => {
    const request = deferred<FeedbackReceipt>()
    const captured: SparkFeedback[] = []
    const { result } = renderHook(() => useOverviewFeedback(async (_id, feedback) => {
      captured.push(feedback)
      return request.promise
    }))
    act(() => result.current.setComment('care', '第一份补充'))
    let submitted!: Promise<void>
    act(() => { submitted = result.current.submit('care') })
    expect(result.current.get('care').submitting).toBe(true)
    act(() => result.current.setComment('care', '提交后继续写的新补充'))
    await act(async () => { request.resolve({ persistence: 'saved', analysis: 'pending' }); await submitted })
    expect(captured).toEqual([{ vote: null, comment: '第一份补充' }])
    expect(result.current.get('care').draft.comment).toBe('提交后继续写的新补充')
    expect(result.current.get('care').receiptMatchesDraft).toBe(false)
    expect(result.current.get('care').isDirty).toBe(true)
    expect(result.current.get('care').receipt?.analysis).toBe('pending')
  })

  it('失败后重试原始快照，保留后来修改的输入', async () => {
    const submitted: SparkFeedback[] = []
    const { result } = renderHook(() => useOverviewFeedback(async (_id, feedback) => {
      submitted.push(feedback)
      if (submitted.length === 1) throw new Error('offline')
      return { persistence: 'saved', analysis: 'not-requested' }
    }))
    act(() => result.current.setComment('care', '失败时的补充'))
    await act(() => result.current.submit('care'))
    expect(result.current.get('care').error).toBe(true)
    act(() => result.current.setComment('care', '后来的补充'))
    await act(() => result.current.retry('care'))
    expect(submitted).toEqual([
      { vote: null, comment: '失败时的补充' },
      { vote: null, comment: '失败时的补充' },
    ])
    expect(result.current.get('care').draft.comment).toBe('后来的补充')
    expect(result.current.get('care').receiptMatchesDraft).toBe(false)
    expect(result.current.get('care').error).toBe(false)
  })

  it('保存成功后再次编辑会取消当前草稿的成功状态', async () => {
    const { result } = renderHook(() => useOverviewFeedback(async () => ({ persistence: 'saved', analysis: 'not-requested' })))
    act(() => result.current.setComment('care', '已提交的补充'))
    await act(() => result.current.submit('care'))
    expect(result.current.get('care').receiptMatchesDraft).toBe(true)
    act(() => result.current.setComment('care', '新的草稿'))
    expect(result.current.get('care').receiptMatchesDraft).toBe(false)
    expect(result.current.get('care').isDirty).toBe(true)
  })
})
