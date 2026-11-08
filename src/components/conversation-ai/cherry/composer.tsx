import {
  useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore,
  type ReactNode, type Ref,
} from 'react'

import {
  readChatDraftCache, subscribeChatDraftCache, writeChatDraftCache,
} from '../../../vendor/cherry-chat/composer/chatDraftCache'
import ComposerCore from '../../../vendor/cherry-chat/composer/ComposerCore'
import type { ComposerSerializedDraft } from '../../../vendor/cherry-chat/composer/composerDraft'
import ComposerSurface from '../../../vendor/cherry-chat/composer/ComposerSurface'
import type { ComposerSurfaceActions } from '../../../vendor/cherry-chat/composer/ComposerSurfaceRuntime'
import type { InputHistoryDirection } from '../../../vendor/cherry-chat/composer/inputHistoryNavigation'
import { useInputHistory } from '../../../vendor/cherry-chat/composer/useInputHistory'

export { clearComposerInputHistory, moveComposerInputHistory } from '../../../vendor/cherry-chat/composer/useInputHistory'

export function readComposerDraft(scopeKey: string) {
  return readChatDraftCache(scopeKey).text
}

export function writeComposerDraft(scopeKey: string, text: string) {
  writeChatDraftCache(scopeKey, { text })
}

export function clearComposerDraft(scopeKey: string) {
  writeComposerDraft(scopeKey, '')
}

export function useComposerDraft(scopeKey: string) {
  const subscribe = useCallback((listener: () => void) => subscribeChatDraftCache(scopeKey, listener), [scopeKey])
  const readDraft = useCallback(() => readComposerDraft(scopeKey), [scopeKey])
  const writeDraft = useCallback((text: string) => writeComposerDraft(scopeKey, text), [scopeKey])
  return [useSyncExternalStore(subscribe, readDraft, readDraft), writeDraft] as const
}

export interface CherryComposerHandle {
  focus: () => void
}

export interface CherryComposerProps {
  scopeKey: string
  value: string
  onChange: (text: string) => void
  onSend: (text: string) => Promise<boolean>
  onStop: () => void
  running: boolean
  sendDisabled: boolean
  disabled?: boolean
  onSubmittingChange?: (locked: boolean) => void
  toolbar?: ReactNode
  references?: ReactNode
  ref?: Ref<CherryComposerHandle>
}

export function CherryComposer(props: CherryComposerProps) {
  return <ScopedCherryComposer key={props.scopeKey} {...props} />
}

function ScopedCherryComposer({
  scopeKey, value, onChange, onSend, onStop, running, sendDisabled, disabled = false,
  onSubmittingChange, toolbar, references, ref,
}: CherryComposerProps) {
  const actionsRef = useRef<ComposerSurfaceActions>(null)
  const directSendInFlightRef = useRef(false)
  const valueRef = useRef(value)
  const [isDirectSending, setIsDirectSending] = useState(false)
  const [isExpanded, setExpanded] = useState(false)
  const [historyPreview, setHistoryPreview] = useState<string | null>(null)
  const text = historyPreview ?? value
  const editable = !disabled && !isDirectSending
  const pendingFocus = useRef<AbortController | null>(null)

  useLayoutEffect(() => { valueRef.current = value }, [value])

  const setActions = useCallback((actions: ComposerSurfaceActions) => { actionsRef.current = actions }, [])
  const cancelPendingFocus = useCallback(() => {
    pendingFocus.current?.abort()
    pendingFocus.current = null
  }, [])
  useImperativeHandle(ref, () => ({
    focus: () => {
      cancelPendingFocus()
      if (editable) {
        actionsRef.current?.focus('end')
        return
      }

      // ProseMirror cannot take focus until the editor becomes editable.
      const request = new AbortController()
      pendingFocus.current = request
      const options = { capture: true, signal: request.signal }
      document.addEventListener('pointerdown', cancelPendingFocus, options)
      document.addEventListener('keydown', cancelPendingFocus, options)
      document.addEventListener('focusin', cancelPendingFocus, options)
      window.addEventListener('blur', cancelPendingFocus, { signal: request.signal })
    },
  }), [cancelPendingFocus, editable])
  useEffect(() => {
    if (!editable || !pendingFocus.current) return
    cancelPendingFocus()
    actionsRef.current?.focus('end')
  }, [cancelPendingFocus, editable])
  useEffect(() => cancelPendingFocus, [cancelPendingFocus])

  const applyHistoryDraft = useCallback((draft: ComposerSerializedDraft, options: { source: 'history' | 'draft' }) => {
    actionsRef.current?.replaceDraft(draft)
    setHistoryPreview(options.source === 'history' ? draft.text : null)
    actionsRef.current?.focus('end')
  }, [])
  const { isInputHistoryActive, navigateHistory, resetHistoryIndex, saveHistory } =
    useInputHistory({ scopeKey, applyDraft: applyHistoryDraft })
  const handleInputHistoryNavigate = useCallback((direction: InputHistoryDirection) => {
    const draft = actionsRef.current?.getDraft()
    return draft ? navigateHistory(direction, draft) : false
  }, [navigateHistory])

  const handleTextChange = useCallback((nextText: string) => {
    if (directSendInFlightRef.current || disabled) return
    resetHistoryIndex()
    setHistoryPreview(null)
    onChange(nextText)
  }, [disabled, onChange, resetHistoryIndex])

  const clearCurrentDraft = useCallback(() => {
    actionsRef.current?.replaceDraft({ text: '', tokens: [] })
    onChange('')
  }, [onChange])

  const handleSendDraft = useCallback(async (draft: ComposerSerializedDraft) => {
    if (directSendInFlightRef.current || sendDisabled || disabled || running || !draft.text.trim()) return

    const submittedValue = valueRef.current
    directSendInFlightRef.current = true
    setIsDirectSending(true)
    try {
      onSubmittingChange?.(true)
      const sent = await onSend(draft.text)
      if (sent) {
        saveHistory(draft.text)
        resetHistoryIndex()
        setHistoryPreview(null)
        if (valueRef.current === submittedValue) clearCurrentDraft()
      }
    } catch {
      // The host reports the send failure and the current draft stays available to retry.
    } finally {
      directSendInFlightRef.current = false
      setIsDirectSending(false)
      onSubmittingChange?.(false)
    }
  }, [clearCurrentDraft, disabled, onSend, onSubmittingChange, resetHistoryIndex, running, saveHistory, sendDisabled])

  return (
    <div className="cherry-chat-surface" data-composer-dock-surface="">
      <ComposerCore fallback={
        <ComposerSurface
          text={text}
          onTextChange={handleTextChange}
          placeholder="输入消息…"
          sendDisabled={sendDisabled || disabled || isDirectSending || running || !text.trim()}
          isLoading={running && !isDirectSending}
          onSendDraft={handleSendDraft}
          onPause={onStop}
          isExpanded={isExpanded}
          onExpandedChange={setExpanded}
          editable={editable}
          fontSize={14}
          narrowMode
          onActionsChange={setActions}
          isInputHistoryActive={isInputHistoryActive}
          onInputHistoryNavigate={handleInputHistoryNavigate}
          leftControls={toolbar}
          topContent={references}
        />
      } />
    </div>
  )
}
