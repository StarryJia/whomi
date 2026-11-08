import { useCallback, useRef, useState } from 'react'

import type { ComposerSerializedDraft } from './composerDraft'
import { getNextInputHistoryIndex, type InputHistoryDirection } from './inputHistoryNavigation'

export const INPUT_HISTORY_LIMIT = 20
const inputHistory = new Map<string, string[]>()
const EMPTY_HISTORY: string[] = []

export function clearComposerInputHistory(scopeKey: string) {
  inputHistory.delete(scopeKey)
}

export function moveComposerInputHistory(from: string, to: string) {
  if (from === to) return
  const previous = inputHistory.get(from)
  if (!previous) return
  const current = inputHistory.get(to) ?? EMPTY_HISTORY
  inputHistory.set(to, [...new Set([...previous, ...current])].slice(0, INPUT_HISTORY_LIMIT))
  inputHistory.delete(from)
}

interface UseInputHistoryApplyOptions {
  source: 'history' | 'draft'
}

interface UseInputHistoryOptions {
  scopeKey: string
  applyDraft: (draft: ComposerSerializedDraft, options: UseInputHistoryApplyOptions) => void
}

export function useInputHistory({ applyDraft, scopeKey }: UseInputHistoryOptions) {
  const [historyIndex, setHistoryIndex] = useState(-1)
  const draftBeforeHistoryRef = useRef<ComposerSerializedDraft | null>(null)
  const navigationHistoryRef = useRef<string[] | null>(null)
  const history = inputHistory.get(scopeKey) ?? EMPTY_HISTORY

  const applyHistoryIndex = useCallback(
    (nextIndex: number) => {
      setHistoryIndex(nextIndex)
      if (nextIndex === -1) {
        applyDraft(draftBeforeHistoryRef.current ?? { text: '', tokens: [] }, { source: 'draft' })
        draftBeforeHistoryRef.current = null
        navigationHistoryRef.current = null
        return
      }

      const activeHistory = navigationHistoryRef.current ?? history
      const historyItem = activeHistory[nextIndex]
      if (!historyItem) {
        applyDraft(draftBeforeHistoryRef.current ?? { text: '', tokens: [] }, { source: 'draft' })
        draftBeforeHistoryRef.current = null
        navigationHistoryRef.current = null
        setHistoryIndex(-1)
        return
      }

      applyDraft({ text: historyItem, tokens: [] }, { source: 'history' })
    },
    [applyDraft, history]
  )

  const navigateHistory = useCallback(
    (direction: InputHistoryDirection, currentDraft: ComposerSerializedDraft) => {
      const activeHistory = navigationHistoryRef.current ?? history
      const nextIndex = getNextInputHistoryIndex({
        currentIndex: historyIndex,
        direction,
        messagesLength: activeHistory.length
      })

      if (nextIndex === historyIndex) {
        return historyIndex !== -1
      }

      if (historyIndex === -1 && nextIndex !== -1) {
        draftBeforeHistoryRef.current = currentDraft
        navigationHistoryRef.current = history
      }
      applyHistoryIndex(nextIndex)
      return true
    },
    [applyHistoryIndex, history, historyIndex]
  )

  const resetHistoryIndex = useCallback(() => {
    setHistoryIndex(-1)
    draftBeforeHistoryRef.current = null
    navigationHistoryRef.current = null
  }, [])

  const saveHistory = useCallback(
    (content: string) => {
      const normalizedContent = content.trim()
      if (!normalizedContent) {
        return
      }

      const prev = inputHistory.get(scopeKey) ?? EMPTY_HISTORY
      inputHistory.set(
        scopeKey,
        [normalizedContent, ...prev.filter((item) => item !== normalizedContent)].slice(0, INPUT_HISTORY_LIMIT)
      )
    },
    [scopeKey]
  )

  return {
    isInputHistoryActive: historyIndex !== -1,
    navigateHistory,
    resetHistoryIndex,
    saveHistory
  }
}
