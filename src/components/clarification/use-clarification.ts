import { useCallback, useRef, useState } from 'react'
import type {
  ClarificationAdapter, ClarificationAnswer, ClarificationController,
  ClarificationEntry, ClarificationModel, ClarificationQuestion,
} from './types'

const emptyEntry: ClarificationEntry = { mode: 'cards', draft: '', modelId: '' }

function clearFeedback(entry: ClarificationEntry): ClarificationEntry {
  return { ...entry, answer: undefined, failedAnswer: undefined, error: undefined, withdrawn: undefined }
}

function hasModel(models: readonly ClarificationModel[], modelId: string) {
  return Boolean(modelId) && models.some(model => model.id === modelId && model.available)
}

export function useClarification(adapter?: ClarificationAdapter): ClarificationController {
  const [entries, setEntries] = useState(() => new Map<string, ClarificationEntry>())
  const entriesRef = useRef(entries)

  const update = useCallback((questionId: string, change: (entry: ClarificationEntry) => ClarificationEntry) => {
    const entry = entriesRef.current.get(questionId) ?? emptyEntry
    const changed = change(entry)
    if (changed === entry) return
    const next = new Map(entriesRef.current)
    next.set(questionId, changed)
    // 在重新渲染前锁定同题，拦截同一次事件中的重复提交。
    entriesRef.current = next
    setEntries(next)
  }, [])

  const get = useCallback((questionId: string) => entries.get(questionId) ?? emptyEntry, [entries])

  const setMode = useCallback((questionId: string, mode: ClarificationEntry['mode']) => {
    update(questionId, entry => entry.pending || entry.receipt || entry.mode === mode
      ? entry : { ...clearFeedback(entry), mode })
  }, [update])

  const startOwn = useCallback((questionId: string) => setMode(questionId, 'own'), [setMode])
  const useCards = useCallback((questionId: string) => setMode(questionId, 'cards'), [setMode])

  const setDraft = useCallback((questionId: string, draft: string) => {
    update(questionId, entry => entry.pending || entry.receipt || entry.mode !== 'own' || entry.draft === draft
      ? entry : { ...clearFeedback(entry), draft })
  }, [update])

  const setModel = useCallback((questionId: string, modelId: string) => {
    update(questionId, entry => entry.pending || entry.receipt || entry.modelId === modelId
      ? entry : { ...clearFeedback(entry), modelId })
  }, [update])

  const submit = useCallback(async (questionId: string, answer: ClarificationAnswer) => {
    const entry = entriesRef.current.get(questionId) ?? emptyEntry
    const mode = answer.kind === 'option' ? 'cards' : 'own'
    if (!adapter || entry.pending || entry.receipt || entry.mode !== mode) return
    const snapshot = { ...answer }
    update(questionId, current => ({ ...current, pending: 'submit', answer: snapshot,
      failedAnswer: undefined, error: undefined, withdrawn: undefined }))
    try {
      const receipt = await adapter.submit(questionId, { ...snapshot })
      if (!receipt.answerId.trim()) throw new Error('Missing answer ID')
      update(questionId, current => ({ ...current, pending: undefined, receipt: { ...receipt } }))
    } catch {
      update(questionId, current => ({ ...current, pending: undefined, error: 'submit', failedAnswer: snapshot }))
    }
  }, [adapter, update])

  const choose = useCallback(async (question: ClarificationQuestion, optionId: string) => {
    const entry = entriesRef.current.get(question.id) ?? emptyEntry
    if (entry.mode !== 'cards') return
    const option = question.options.find(candidate => candidate.id === optionId)
    if (option) await submit(question.id, { kind: 'option', optionId: option.id, text: option.title })
  }, [submit])

  const sendOwn = useCallback(async (question: ClarificationQuestion, models: readonly ClarificationModel[]) => {
    const entry = entriesRef.current.get(question.id) ?? emptyEntry
    const text = entry.draft.trim()
    if (entry.mode !== 'own' || !text || !hasModel(models, entry.modelId)) return
    await submit(question.id, { kind: 'text', text, modelId: entry.modelId })
  }, [submit])

  const retry = useCallback(async (question: ClarificationQuestion, models: readonly ClarificationModel[]) => {
    const answer = entriesRef.current.get(question.id)?.failedAnswer
    if (!answer || (answer.kind === 'text' && !hasModel(models, answer.modelId))) return
    await submit(question.id, answer)
  }, [submit])

  const withdraw = useCallback(async (questionId: string) => {
    const entry = entriesRef.current.get(questionId) ?? emptyEntry
    if (!adapter || !entry.receipt || entry.pending) return
    const answerId = entry.receipt.answerId
    update(questionId, current => ({ ...current, pending: 'withdraw', error: undefined }))
    try {
      const withdrawn = await adapter.withdraw(questionId, answerId)
      update(questionId, current => ({ ...clearFeedback(current), pending: undefined,
        receipt: undefined, withdrawn: { ...withdrawn } }))
    } catch {
      update(questionId, current => ({ ...current, pending: undefined, error: 'withdraw' }))
    }
  }, [adapter, update])

  return {
    canSubmit: Boolean(adapter),
    get, startOwn, useCards, setDraft, setModel, choose, sendOwn, retry, withdraw,
  }
}
