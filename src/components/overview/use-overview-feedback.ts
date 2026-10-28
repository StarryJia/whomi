import { useCallback, useRef, useState } from 'react'
import type { FeedbackReceipt, FeedbackSaver, SparkDiscovery, SparkFeedback } from './types'

interface FeedbackEntry {
  draft: SparkFeedback
  baseline: SparkFeedback
  revision: number
  submitting: boolean
  error: boolean
  failedSnapshot?: SparkFeedback
  submittedSnapshot?: SparkFeedback
  receipt?: FeedbackReceipt
  receiptRevision?: number
}

function createEntry(feedback: SparkFeedback = { vote: null, comment: '' }): FeedbackEntry {
  return { draft: { ...feedback }, baseline: { ...feedback }, revision: 0, submitting: false, error: false }
}

function matches(left: SparkFeedback, right: SparkFeedback) {
  return left.vote === right.vote && left.comment === right.comment
}

const emptyEntry = createEntry()

export function useOverviewFeedback(saveFeedback?: FeedbackSaver) {
  const [entries, setEntries] = useState(() => new Map<string, FeedbackEntry>())
  const entriesRef = useRef(entries)

  const update = useCallback((id: string, change: (entry: FeedbackEntry) => FeedbackEntry) => {
    const next = new Map(entriesRef.current)
    next.set(id, change(entriesRef.current.get(id) ?? createEntry()))
    entriesRef.current = next
    setEntries(next)
  }, [])

  const initialize = useCallback((discoveries: readonly SparkDiscovery[]) => {
    let next = entriesRef.current
    for (const discovery of discoveries) {
      if (next.has(discovery.id)) continue
      if (next === entriesRef.current) next = new Map(next)
      next.set(discovery.id, createEntry(discovery.feedback))
    }
    if (next !== entriesRef.current) {
      entriesRef.current = next
      setEntries(next)
    }
  }, [])

  const get = useCallback((id: string) => {
    const entry = entries.get(id) ?? emptyEntry
    return {
      ...entry,
      isDirty: !matches(entry.draft, entry.baseline),
      receiptMatchesDraft: Boolean(entry.receipt && entry.submittedSnapshot &&
        entry.receiptRevision === entry.revision && matches(entry.draft, entry.submittedSnapshot)),
    }
  }, [entries])

  const toggleVote = useCallback((id: string, vote: 'agree' | 'disagree') => {
    update(id, (entry) => ({ ...entry, revision: entry.revision + 1,
      draft: { ...entry.draft, vote: entry.draft.vote === vote ? null : vote } }))
  }, [update])

  const setComment = useCallback((id: string, comment: string) => {
    update(id, (entry) => ({ ...entry, revision: entry.revision + 1, draft: { ...entry.draft, comment } }))
  }, [update])

  const send = useCallback(async (id: string, snapshot: SparkFeedback) => {
    const entry = entriesRef.current.get(id) ?? emptyEntry
    if (!saveFeedback || entry.submitting) return
    const submittedRevision = entry.revision
    update(id, (current) => ({ ...current, submitting: true, error: false }))
    try {
      // 保存一份独立快照，避免后续输入改变正在提交的内容。
      const receipt = await saveFeedback(id, { ...snapshot })
      update(id, (current) => ({ ...current, submitting: false, error: false, failedSnapshot: undefined,
        baseline: receipt.persistence === 'saved' ? snapshot : current.baseline,
        submittedSnapshot: snapshot, receipt, receiptRevision: submittedRevision }))
    } catch {
      update(id, (current) => ({ ...current, submitting: false, error: true, failedSnapshot: snapshot }))
    }
  }, [saveFeedback, update])

  const submit = useCallback(async (id: string) => {
    const entry = entriesRef.current.get(id) ?? emptyEntry
    if (!matches(entry.draft, entry.baseline)) await send(id, { ...entry.draft })
  }, [send])

  const retry = useCallback(async (id: string) => {
    const snapshot = entriesRef.current.get(id)?.failedSnapshot
    if (snapshot) await send(id, { ...snapshot })
  }, [send])

  return {
    canSave: Boolean(saveFeedback),
    initialize, get, toggleVote, setComment, submit, retry,
  }
}
