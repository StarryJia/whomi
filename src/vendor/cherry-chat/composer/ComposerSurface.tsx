import { CirclePause } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type KeyboardEvent } from 'react'

import { ScrollArea } from '@cherrystudio/ui'

import NarrowLayout from '../shared/layout/NarrowLayout'
import { getComposerEditorMinHeight } from './composerSizing'
import type { ComposerSurfaceActions, ComposerSurfaceProps } from './ComposerSurfaceRuntime'
import { isComposerEnter, matchesComposerEnter, readPlainTextTransfer } from './plainTextTransfer'
import SendMessageButton from './SendMessageButton'
import './composer.css'

const COMPOSER_SIDE_PADDING_PX = 24

let runtimePromise: Promise<{ default: ComponentType<ComposerSurfaceProps> }> | undefined

function loadRuntime() {
  runtimePromise ??= import('./ComposerSurfaceRuntime').catch((error) => {
    runtimePromise = undefined
    console.error('输入框加载失败，请重试。', error)
    throw error
  })
  return runtimePromise
}

export default function DeferredComposerSurface(props: ComposerSurfaceProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const selectionRef = useRef({ start: props.text.length, end: props.text.length })
  const controlFocusRef = useRef<EventTarget | null>(null)
  const controlPointerRef = useRef<number | null>(null)
  const controlReleaseFrame = useRef<number | null>(null)
  const [Runtime, setRuntime] = useState<ComponentType<ComposerSurfaceProps>>()
  const [isComposing, setIsComposing] = useState(false)
  const [hasControlInteraction, setHasControlInteraction] = useState(false)
  const canHandoff = !isComposing && !hasControlInteraction

  const requestRuntime = useCallback(() => {
    void loadRuntime()
      .then((module) => setRuntime(() => module.default))
      .catch(() => {
        // Later interactions can retry a failed lazy import.
      })
  }, [])

  const getFallbackDraft = useCallback(() => ({ text: props.text, tokens: [] }), [props.text])

  useEffect(() => {
    if (props.text.trim().length > 0 || props.isExpanded) requestRuntime()
  }, [props.isExpanded, props.text, requestRuntime])

  // Start the editor off the first-paint path when idle, before the next keystroke can be interrupted.
  useEffect(() => {
    if (Runtime || !window.requestIdleCallback) return
    const idleId = window.requestIdleCallback(() => requestRuntime())
    return () => window.cancelIdleCallback(idleId)
  }, [Runtime, requestRuntime])

  const checkControlInteraction = useCallback(() => {
    if (controlReleaseFrame.current !== null) return
    // Focus can move through a portal and pointerup precedes the click that uses the control.
    controlReleaseFrame.current = window.requestAnimationFrame(() => {
      controlReleaseFrame.current = null
      if (controlFocusRef.current !== document.activeElement) controlFocusRef.current = null
      setHasControlInteraction(controlFocusRef.current !== null || controlPointerRef.current !== null)
    })
  }, [])
  useEffect(() => {
    const finishPointer = () => {
      if (controlPointerRef.current === null) return
      controlPointerRef.current = null
      checkControlInteraction()
    }
    const finishControlPointer = (event: PointerEvent) => {
      if (controlPointerRef.current === event.pointerId) finishPointer()
    }
    window.addEventListener('pointerup', finishControlPointer, true)
    window.addEventListener('pointercancel', finishControlPointer, true)
    window.addEventListener('blur', finishPointer)
    return () => {
      window.removeEventListener('pointerup', finishControlPointer, true)
      window.removeEventListener('pointercancel', finishControlPointer, true)
      window.removeEventListener('blur', finishPointer)
      if (controlReleaseFrame.current !== null) window.cancelAnimationFrame(controlReleaseFrame.current)
    }
  }, [checkControlInteraction])

  useLayoutEffect(() => {
    if (Runtime && canHandoff) return

    const actions: ComposerSurfaceActions = {
      focus: (position) => {
        const input = textareaRef.current
        if (!input) return
        input.focus({ preventScroll: true })
        const nextPosition =
          typeof position === 'number'
            ? position
            : position === 'start'
              ? 0
              : position === 'all'
                ? undefined
                : input.value.length
        input.setSelectionRange(nextPosition ?? 0, nextPosition ?? input.value.length)
        selectionRef.current = { start: input.selectionStart, end: input.selectionEnd }
      },
      replaceDraft: (draft) => {
        selectionRef.current = { start: draft.text.length, end: draft.text.length }
      },
      getDraft: getFallbackDraft
    }
    props.onActionsChange(actions)
  }, [Runtime, canHandoff, getFallbackDraft, props.onActionsChange])

  if (Runtime && canHandoff) {
    const input = textareaRef.current
    return <Runtime {...props} initialTextSelection={selectionRef.current}
      deferredIntent={{ hadFocus: !!input && input.ownerDocument.activeElement === input }} />
  }

  const updateSelection = () => {
    const input = textareaRef.current
    if (input) selectionRef.current = { start: input.selectionStart, end: input.selectionEnd }
  }

  const insertFallbackText = (input: HTMLTextAreaElement, text: string) => {
    input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end')
    selectionRef.current = { start: input.selectionStart, end: input.selectionEnd }
    props.onTextChange(input.value)
  }

  const navigateInputHistory = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.nativeEvent.isComposing) return false

    const input = event.currentTarget
    const isAllSelected =
      input.value.length > 0 && input.selectionStart === 0 && input.selectionEnd === input.value.length
    const isAtBoundary =
      event.key === 'ArrowUp' ? input.selectionStart === input.value.length : input.selectionEnd === input.value.length
    if (!(props.text.trim().length === 0 || isAllSelected || isAtBoundary)) return false

    return props.onInputHistoryNavigate(event.key === 'ArrowUp' ? 'up' : 'down')
  }

  const editorMinHeight = getComposerEditorMinHeight(props.fontSize)
  const sendAction = props.isLoading && props.sendDisabled ? (
    <button
      data-ui="chat.composer.action.pause"
      type="button"
      className="text-error flex size-7.5 items-center justify-center rounded-full border-0 bg-transparent p-0 hover:bg-accent"
      aria-label="停止回答"
      onClick={props.onPause}>
      <CirclePause size={20} />
    </button>
  ) : (
    <SendMessageButton
      disabled={props.sendDisabled}
      sendMessage={() => {
        if (!isComposing) void props.onSendDraft(getFallbackDraft())
      }}
      shortcutLabel="Enter"
    />
  )

  return (
    <NarrowLayout
      narrowMode={props.narrowMode}
      withSidePadding
      className="pointer-events-none"
      style={{ width: '100%', paddingInline: props.sidePaddingPx ?? COMPOSER_SIDE_PADDING_PX }}>
      <div className="pointer-events-auto w-full">
        <div className="inputbar relative z-2 flex flex-col pt-0" onDrop={event => event.preventDefault()}>
          <div
            id="inputbar"
            data-ui="chat.composer"
            data-composer-inputbar=""
            data-composer-presentation="regular"
            onFocusCapture={event => {
              if (textareaRef.current?.isSameNode(event.target)) {
                if (controlFocusRef.current) checkControlInteraction()
                return
              }
              controlFocusRef.current = event.target
              setHasControlInteraction(true)
            }}
            onBlurCapture={() => {
              if (controlFocusRef.current) checkControlInteraction()
            }}
            onPointerDownCapture={event => {
              if (event.target === textareaRef.current || event.button !== 0) return
              controlPointerRef.current = event.pointerId
              setHasControlInteraction(true)
            }}
            className="inputbar-container relative rounded-[20px] border-[0.5px] border-border bg-composer-surface pt-2 mb-3 shadow-sm">
            {props.topContent}
            <div className="group/composer-editor relative flex min-w-0 flex-1">
              <ScrollArea
                type="auto"
                className="min-w-0 flex-1 [-webkit-app-region:no-drag]"
                style={{ height: editorMinHeight }}>
                <textarea
                  dir="auto"
                  ref={textareaRef}
                  aria-label="向 AI 提问"
                  value={props.text}
                  placeholder={props.placeholder}
                  rows={1}
                  readOnly={!props.editable}
                  spellCheck={false}
                  data-ui="part:composer-input"
                  className="box-border block field-sizing-content w-full min-w-0 resize-none overflow-hidden border-0 bg-transparent text-foreground outline-none"
                  style={{
                    minHeight: editorMinHeight,
                    padding: '6px 15px 0',
                    fontSize: props.fontSize,
                    textAlign: 'start',
                    lineHeight: 1.4
                  }}
                  onChange={(event) => {
                    updateSelection()
                    props.onTextChange(event.currentTarget.value)
                    requestRuntime()
                  }}
                  onFocus={requestRuntime}
                  onSelect={updateSelection}
                  onPaste={(event) => {
                    event.preventDefault()
                    if (!props.editable) return
                    const text = readPlainTextTransfer(event.clipboardData)
                    if (text) insertFallbackText(event.currentTarget, text)
                    requestRuntime()
                  }}
                  onCompositionStart={() => setIsComposing(true)}
                  onCompositionEnd={(event) => {
                    // Some input methods only write the committed characters on compositionend.
                    const input = event.currentTarget
                    selectionRef.current = { start: input.selectionStart, end: input.selectionEnd }
                    if (props.editable && input.value !== props.text) props.onTextChange(input.value)
                    setIsComposing(false)
                  }}
                  onKeyDown={(event) => {
                    if (!props.editable || isComposing || event.nativeEvent.isComposing) return
                    requestRuntime()
                    if (navigateInputHistory(event)) {
                      event.preventDefault()
                      return
                    }
                    if (!isComposerEnter(event.nativeEvent)) return

                    event.preventDefault()
                    if (matchesComposerEnter(event, false)) {
                      if (!event.repeat && !props.sendDisabled) void props.onSendDraft(getFallbackDraft())
                      return
                    }
                    if (matchesComposerEnter(event, true)) insertFallbackText(event.currentTarget, '\n')
                  }}
                />
              </ScrollArea>
            </div>
            <div
              data-ui="part:composer-actions"
              data-composer-toolbar=""
              className="relative z-2 flex h-10 shrink-0 flex-row justify-between gap-4 px-2 py-1.25">
              <div className="flex min-w-0 flex-1 items-center overflow-hidden">{props.leftControls}</div>
              <div className="flex flex-row items-center gap-1.5">{sendAction}</div>
            </div>
          </div>
        </div>
      </div>
    </NarrowLayout>
  )
}
