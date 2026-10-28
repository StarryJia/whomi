import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useClarification } from './use-clarification'
import type {
  ClarificationAdapter, ClarificationAnswer, ClarificationModel,
  ClarificationQuestion, ClarificationReceipt, ClarificationWithdrawal,
} from './types'

const question: ClarificationQuestion = {
  id: 'care', title: '当时更在意什么？', context: '示例：朋友准备答辩时，你们约好一起练习。',
  options: [{ id: 'help', title: '帮他完成眼前的事' }, { id: 'listen', title: '听听他的感受' }],
}
const models: readonly ClarificationModel[] = [
  { id: 'configured', label: '示例可用模型', available: true },
  { id: 'offline', label: '示例不可用模型', available: false },
]

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function createAdapter(overrides: Partial<ClarificationAdapter> = {}): ClarificationAdapter {
  return {
    submit: async () => ({ answerId: 'answer-1', persistence: 'preview' }),
    withdraw: async () => ({ persistence: 'preview' }),
    ...overrides,
  }
}

describe('解惑回答状态', () => {
  it('点击有效卡牌立即提交该选项，不提交不存在的选项', async () => {
    const submissions: { questionId: string; answer: ClarificationAnswer }[] = []
    const { result } = renderHook(() => useClarification(createAdapter({ submit: async (questionId, answer) => {
      submissions.push({ questionId, answer })
      return { answerId: 'selected', persistence: 'preview' }
    } })))

    await act(() => result.current.choose(question, 'missing'))
    expect(submissions).toEqual([])
    await act(() => result.current.choose(question, 'listen'))

    expect(submissions).toEqual([{ questionId: 'care', answer: { kind: 'option', optionId: 'listen', text: '听听他的感受' } }])
    expect(result.current.canSubmit).toBe(true)
    expect(result.current.get('care')).toMatchObject({
      mode: 'cards', answer: { kind: 'option', optionId: 'listen', text: '听听他的感受' },
      receipt: { answerId: 'selected', persistence: 'preview' },
    })
    expect(result.current.get('care').pending).toBeUndefined()
  })

  it('两种回答方式互斥，切换保留草稿且不自动发送', async () => {
    const submissions: ClarificationAnswer[] = []
    const { result } = renderHook(() => useClarification(createAdapter({ submit: async (_id, answer) => {
      submissions.push(answer)
      return { answerId: 'selected', persistence: 'preview' }
    } })))

    act(() => result.current.setDraft('care', '卡牌状态不允许修改'))
    expect(result.current.get('care').draft).toBe('')
    act(() => result.current.startOwn('care'))
    act(() => result.current.setDraft('care', '我想先听他说完。'))
    await act(() => result.current.choose(question, 'help'))
    expect(result.current.get('care')).toMatchObject({ mode: 'own', draft: '我想先听他说完。', modelId: '' })
    act(() => result.current.useCards('care'))
    await act(() => result.current.sendOwn(question, models))
    expect(result.current.get('care')).toMatchObject({ mode: 'cards', draft: '我想先听他说完。' })
    act(() => result.current.startOwn('care'))
    expect(result.current.get('care').draft).toBe('我想先听他说完。')
    expect(submissions).toEqual([])
  })

  it('自己回答必须有非空内容与明确选中的可用模型，发送时去掉首尾空白', async () => {
    const submissions: ClarificationAnswer[] = []
    const { result } = renderHook(() => useClarification(createAdapter({ submit: async (_id, answer) => {
      submissions.push(answer)
      return { answerId: 'written', persistence: 'saved' }
    } })))

    act(() => result.current.startOwn('care'))
    act(() => result.current.setModel('care', 'configured'))
    act(() => result.current.setDraft('care', ' \n '))
    await act(() => result.current.sendOwn(question, models))
    act(() => result.current.setDraft('care', '  想确认他需要哪种帮助。 \n'))
    act(() => result.current.setModel('care', ''))
    await act(() => result.current.sendOwn(question, models))
    act(() => result.current.setModel('care', 'missing'))
    await act(() => result.current.sendOwn(question, models))
    act(() => result.current.setModel('care', 'offline'))
    await act(() => result.current.sendOwn(question, models))
    act(() => result.current.setModel('care', 'configured'))
    await act(() => result.current.sendOwn(question, []))
    expect(submissions).toEqual([])
    await act(() => result.current.sendOwn(question, models))

    expect(submissions).toEqual([{ kind: 'text', text: '想确认他需要哪种帮助。', modelId: 'configured' }])
    expect(result.current.get('care').draft).toBe('  想确认他需要哪种帮助。 \n')
    expect(result.current.get('care').receipt?.persistence).toBe('saved')
  })

  it('同一次事件里连续点击只提交第一张卡，等待期间禁止修改或撤回', async () => {
    const request = deferred<ClarificationReceipt>()
    const submissions: ClarificationAnswer[] = []
    const withdrawals: string[] = []
    const { result } = renderHook(() => useClarification(createAdapter({
      submit: async (_id, answer) => { submissions.push(answer); return request.promise },
      withdraw: async (_id, answerId) => { withdrawals.push(answerId); return { persistence: 'preview' } },
    })))
    let submitted!: Promise<void>
    act(() => {
      submitted = result.current.choose(question, 'help')
      void result.current.choose(question, 'listen')
      result.current.startOwn('care')
      result.current.setDraft('care', '不能同时改成自己回答')
      result.current.setModel('care', 'configured')
      void result.current.sendOwn(question, models)
      void result.current.withdraw('care')
    })
    expect(submissions).toEqual([{ kind: 'option', optionId: 'help', text: '帮他完成眼前的事' }])
    expect(withdrawals).toEqual([])
    expect(result.current.get('care')).toMatchObject({ pending: 'submit', mode: 'cards', draft: '', modelId: '' })
    await act(async () => { request.resolve({ answerId: 'first', persistence: 'preview' }); await submitted })
    expect(result.current.get('care').receipt?.answerId).toBe('first')
  })

  it('成功回答在撤回前禁止编辑和再次提交', async () => {
    const submissions: ClarificationAnswer[] = []
    const { result } = renderHook(() => useClarification(createAdapter({ submit: async (_id, answer) => {
      submissions.push(answer)
      return { answerId: 'locked', persistence: 'preview' }
    } })))
    act(() => {
      result.current.startOwn('care')
      result.current.setDraft('care', '先听他说完。')
      result.current.setModel('care', 'configured')
    })
    await act(() => result.current.sendOwn(question, models))
    act(() => {
      result.current.useCards('care')
      result.current.setDraft('care', '改成别的回答')
      result.current.setModel('care', 'offline')
    })
    await act(() => result.current.sendOwn(question, models))
    await act(() => result.current.choose(question, 'help'))
    expect(submissions).toHaveLength(1)
    expect(result.current.get('care')).toMatchObject({ mode: 'own', draft: '先听他说完。', modelId: 'configured' })
  })

  it('卡牌提交失败后重试失败时的答案快照', async () => {
    const submissions: ClarificationAnswer[] = []
    const { result } = renderHook(() => useClarification(createAdapter({ submit: async (_id, answer) => {
      submissions.push(answer)
      if (submissions.length === 1) throw new Error('offline')
      return { answerId: 'retried', persistence: 'preview' }
    } })))
    await act(() => result.current.choose(question, 'help'))
    expect(result.current.get('care')).toMatchObject({ error: 'submit', failedAnswer: { kind: 'option', optionId: 'help', text: '帮他完成眼前的事' } })
    expect(result.current.get('care').pending).toBeUndefined()
    expect(result.current.get('care').receipt).toBeUndefined()
    await act(() => result.current.retry({ ...question, options: [{ id: 'help', title: '更新后的选项文案' }] }, models))
    expect(submissions).toEqual([
      { kind: 'option', optionId: 'help', text: '帮他完成眼前的事' },
      { kind: 'option', optionId: 'help', text: '帮他完成眼前的事' },
    ])
    expect(result.current.get('care').receipt?.answerId).toBe('retried')
    expect(result.current.get('care').failedAnswer).toBeUndefined()
    expect(result.current.get('care').error).toBeUndefined()
  })

  it('重试自己回答时重新检查模型是否仍可用', async () => {
    const submissions: ClarificationAnswer[] = []
    const { result } = renderHook(() => useClarification(createAdapter({ submit: async (_id, answer) => {
      submissions.push(answer)
      if (submissions.length === 1) throw new Error('offline')
      return { answerId: 'retried', persistence: 'preview' }
    } })))
    act(() => {
      result.current.startOwn('care')
      result.current.setDraft('care', '  先听他说完。  ')
      result.current.setModel('care', 'configured')
    })
    await act(() => result.current.sendOwn(question, models))
    await act(() => result.current.retry(question, [{ id: 'configured', label: '示例模型', available: false }]))
    await act(() => result.current.retry(question, []))
    expect(submissions).toHaveLength(1)
    expect(result.current.get('care').error).toBe('submit')
    await act(() => result.current.retry(question, models))
    expect(submissions).toEqual([
      { kind: 'text', text: '先听他说完。', modelId: 'configured' },
      { kind: 'text', text: '先听他说完。', modelId: 'configured' },
    ])
    expect(result.current.get('care').receipt?.answerId).toBe('retried')
  })

  it.each(['draft', 'model', 'cards'] as const)('提交失败后修改 %s 清除旧失败提示与重试快照', async (change) => {
    const submissions: ClarificationAnswer[] = []
    const { result } = renderHook(() => useClarification(createAdapter({ submit: async (_id, answer) => {
      submissions.push(answer)
      throw new Error('offline')
    } })))
    act(() => {
      result.current.startOwn('care')
      result.current.setDraft('care', '原来的草稿')
      result.current.setModel('care', 'configured')
    })
    await act(() => result.current.sendOwn(question, models))
    act(() => {
      if (change === 'draft') result.current.setDraft('care', '新的草稿')
      if (change === 'model') result.current.setModel('care', 'offline')
      if (change === 'cards') result.current.useCards('care')
    })
    await act(() => result.current.retry(question, models))
    expect(result.current.get('care').error).toBeUndefined()
    expect(result.current.get('care').failedAnswer).toBeUndefined()
    expect(submissions).toHaveLength(1)
  })

  it('卡牌失败后进入自己回答清除旧失败，重试不会跨模式发送卡牌', async () => {
    const submissions: ClarificationAnswer[] = []
    const { result } = renderHook(() => useClarification(createAdapter({ submit: async (_id, answer) => {
      submissions.push(answer)
      throw new Error('offline')
    } })))
    await act(() => result.current.choose(question, 'help'))
    act(() => result.current.startOwn('care'))
    await act(() => result.current.retry(question, models))
    expect(result.current.get('care')).toMatchObject({ mode: 'own' })
    expect(result.current.get('care').error).toBeUndefined()
    expect(result.current.get('care').failedAnswer).toBeUndefined()
    expect(submissions).toHaveLength(1)
  })

  it('撤回等待和失败保留原回答，重试成功后恢复同题草稿', async () => {
    const firstWithdrawal = deferred<ClarificationWithdrawal>()
    const withdrawals: { questionId: string; answerId: string }[] = []
    const { result } = renderHook(() => useClarification(createAdapter({
      withdraw: async (questionId, answerId) => {
        withdrawals.push({ questionId, answerId })
        if (withdrawals.length === 1) return firstWithdrawal.promise
        return { persistence: 'preview' }
      },
    })))
    act(() => {
      result.current.startOwn('care')
      result.current.setDraft('care', '想先听他说完。')
      result.current.setModel('care', 'configured')
    })
    await act(() => result.current.sendOwn(question, models))
    let withdrawing!: Promise<void>
    act(() => {
      withdrawing = result.current.withdraw('care')
      void result.current.withdraw('care')
      result.current.useCards('care')
      result.current.setDraft('care', '撤回等待时不修改')
    })
    expect(withdrawals).toEqual([{ questionId: 'care', answerId: 'answer-1' }])
    expect(result.current.get('care')).toMatchObject({
      pending: 'withdraw', answer: { kind: 'text', text: '想先听他说完。', modelId: 'configured' },
      receipt: { answerId: 'answer-1', persistence: 'preview' },
    })
    await act(async () => { firstWithdrawal.reject(new Error('offline')); await withdrawing })
    expect(result.current.get('care')).toMatchObject({
      error: 'withdraw', answer: { kind: 'text', text: '想先听他说完。', modelId: 'configured' },
      receipt: { answerId: 'answer-1', persistence: 'preview' },
    })
    expect(result.current.get('care').pending).toBeUndefined()
    expect(result.current.get('care').withdrawn).toBeUndefined()
    await act(() => result.current.withdraw('care'))
    expect(withdrawals).toHaveLength(2)
    expect(result.current.get('care')).toMatchObject({
      mode: 'own', draft: '想先听他说完。', modelId: 'configured', withdrawn: { persistence: 'preview' },
    })
    expect(result.current.get('care').answer).toBeUndefined()
    expect(result.current.get('care').receipt).toBeUndefined()
    expect(result.current.get('care').error).toBeUndefined()
    act(() => result.current.setDraft('care', '修改后的草稿'))
    expect(result.current.get('care').draft).toBe('修改后的草稿')
    expect(result.current.get('care').withdrawn).toBeUndefined()
  })

  it('撤回卡牌恢复选卡模式并保留之前的自己回答草稿', async () => {
    const { result } = renderHook(() => useClarification(createAdapter()))
    act(() => {
      result.current.startOwn('care')
      result.current.setDraft('care', '留待稍后再写。')
      result.current.useCards('care')
    })
    await act(() => result.current.choose(question, 'help'))
    await act(() => result.current.withdraw('care'))
    expect(result.current.get('care')).toMatchObject({ mode: 'cards', draft: '留待稍后再写。' })
    expect(result.current.get('care').receipt).toBeUndefined()
    act(() => result.current.startOwn('care'))
    expect(result.current.get('care').draft).toBe('留待稍后再写。')
  })

  it('没有适配器时可以写草稿，但不产生提交或撤回回执', async () => {
    const { result } = renderHook(() => useClarification())
    await act(() => result.current.choose(question, 'help'))
    act(() => {
      result.current.startOwn('care')
      result.current.setDraft('care', '未接入时保留的想法')
      result.current.setModel('care', 'configured')
    })
    await act(() => result.current.sendOwn(question, models))
    await act(() => result.current.retry(question, models))
    await act(() => result.current.withdraw('care'))
    expect(result.current.canSubmit).toBe(false)
    expect(result.current.get('care')).toMatchObject({ mode: 'own', draft: '未接入时保留的想法' })
    expect(result.current.get('care').pending).toBeUndefined()
    expect(result.current.get('care').receipt).toBeUndefined()
    expect(result.current.get('care').withdrawn).toBeUndefined()
    expect(result.current.get('care').answer).toBeUndefined()
  })

  it('不同题的异步结果互不覆盖，特殊标识符也能独立编辑', async () => {
    const first = deferred<ClarificationReceipt>()
    const second = deferred<ClarificationReceipt>()
    const { result } = renderHook(() => useClarification(createAdapter({ submit: async (questionId) => {
      return questionId === 'care' ? first.promise : second.promise
    } })))
    act(() => {
      result.current.startOwn('__proto__')
      result.current.setDraft('__proto__', '独立的草稿')
    })
    let firstSubmit!: Promise<void>
    let secondSubmit!: Promise<void>
    act(() => {
      firstSubmit = result.current.choose(question, 'help')
      secondSubmit = result.current.choose({ ...question, id: 'constructor' }, 'listen')
    })
    await act(async () => { second.resolve({ answerId: 'second', persistence: 'saved' }); await secondSubmit })
    expect(result.current.get('constructor').receipt?.answerId).toBe('second')
    expect(result.current.get('care').pending).toBe('submit')
    await act(async () => { first.reject(new Error('offline')); await firstSubmit })
    expect(result.current.get('care').error).toBe('submit')
    expect(result.current.get('constructor').receipt?.answerId).toBe('second')
    expect(result.current.get('__proto__')).toMatchObject({ mode: 'own', draft: '独立的草稿' })
    expect(result.current.get('toString')).toMatchObject({ mode: 'cards', draft: '', modelId: '' })
  })

  it('提交回执没有回答标识时按失败保留重试入口', async () => {
    const { result } = renderHook(() => useClarification(createAdapter({ submit: async () => ({ answerId: '  ', persistence: 'preview' }) })))
    await act(() => result.current.choose(question, 'help'))
    expect(result.current.get('care').receipt).toBeUndefined()
    expect(result.current.get('care').error).toBe('submit')
    expect(result.current.get('care').failedAnswer).toEqual({ kind: 'option', optionId: 'help', text: '帮他完成眼前的事' })
  })
})
