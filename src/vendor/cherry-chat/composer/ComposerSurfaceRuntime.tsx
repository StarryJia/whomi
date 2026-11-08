import type { Editor, JSONContent } from '@tiptap/core'
import type { EditorView } from '@tiptap/pm/view'
import { EditorContent } from '@tiptap/react'
import { CirclePause, Maximize2, Minimize2 } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'

import { Button, ScrollArea, Tooltip } from '@cherrystudio/ui'
import { cn } from '@cherrystudio/ui/lib/utils'

import NarrowLayout from '../shared/layout/NarrowLayout'
import { createComposerDraftContent, serializeComposerDocument, type ComposerSerializedDraft } from './composerDraft'
import { createComposerEditorPreset } from './composerPreset'
import { getComposerPositionAtTextOffset } from './editorSelection'
import { type InputHistoryDirection, shouldHandleInputHistoryNavigation } from './inputHistoryNavigation'
import { isComposerEnter, matchesComposerEnter, readPlainTextTransfer } from './plainTextTransfer'
import SendMessageButton from './SendMessageButton'
import { useComposerEditorFrameSizing } from './useComposerEditorFrameSizing'
import { useRichTextEditorKernel } from './useRichTextEditorKernel'
import { useTimer } from './useTimer'
import './composer.css'

const COMPOSER_SIDE_PADDING_PX = 24

interface ComposerFocusRestoreSnapshot {
  activeElement: Element | null
  pointerDownVersion: number
}

export interface ComposerSurfaceActions {
  focus: (position?: 'start' | 'end' | 'all' | number | boolean | null) => void
  replaceDraft: (draft: ComposerSerializedDraft) => void
  getDraft: () => ComposerSerializedDraft
}

export interface ComposerSurfaceProps {
  text: string
  onTextChange: (text: string) => void
  placeholder: string
  sendDisabled: boolean
  isLoading: boolean
  onSendDraft: (draft: ComposerSerializedDraft) => Promise<void>
  onPause: () => void
  isExpanded: boolean
  onExpandedChange: (expanded: boolean) => void
  editable: boolean
  fontSize: number
  narrowMode: boolean
  sidePaddingPx?: number
  onActionsChange: (actions: ComposerSurfaceActions) => void
  isInputHistoryActive: boolean
  onInputHistoryNavigate: (direction: InputHistoryDirection) => boolean
  leftControls?: ReactNode
  topContent?: ReactNode
  initialTextSelection?: { start: number; end: number }
  deferredIntent?: ComposerDeferredIntent
}

/** The fallback must hold the caret and focus until the editor mounts. */
export interface ComposerDeferredIntent {
  hadFocus?: boolean
}

function setComposerEditorContent(
  editor: Editor,
  lastSerializedDraftRef: { current: ComposerSerializedDraft | null },
  content: JSONContent
) {
  lastSerializedDraftRef.current = serializeComposerDocument(content)
  editor.commands.setContent(content, { emitUpdate: false })
}

function handleComposerCopy(view: EditorView, event: ClipboardEvent) {
  if (view.state.selection.empty || !event.clipboardData) return false
  const selectedContent = view.state.selection.content().content.toJSON() as JSONContent[] | null
  const { text } = serializeComposerDocument({ type: 'doc', content: selectedContent ?? [] })
  event.clipboardData.setData('text/plain', text)
  event.preventDefault()
  return true
}

function getComposerSelectionState(view: EditorView, key: 'ArrowUp' | 'ArrowDown', isInputHistoryActive: boolean) {
  const { doc, selection } = view.state
  // ProseMirror positions include the trailing block-close token.
  const lastSelectablePosition = Math.max(1, doc.content.size - 1)
  const isCursorAtEnd = selection.empty && selection.from === lastSelectablePosition
  let isCursorAtHistoryBoundary = false

  if (isCursorAtEnd) {
    if (key === 'ArrowUp' && isInputHistoryActive) {
      // Browsing stays active when a recalled entry wraps visually.
      isCursorAtHistoryBoundary = true
    } else {
      const topLevelBlockIndex = selection.$head.index(0)
      const isAtDocumentEdgeBlock =
        key === 'ArrowUp' ? topLevelBlockIndex === 0 : topLevelBlockIndex === doc.childCount - 1
      const direction = key === 'ArrowUp' ? 'up' : 'down'
      isCursorAtHistoryBoundary = isAtDocumentEdgeBlock && view.endOfTextblock(direction)
    }
  }

  return {
    isAllSelected: !selection.empty && selection.from <= 1 && selection.to >= lastSelectablePosition,
    isCursorAtHistoryBoundary
  }
}

export default function ComposerSurfaceRuntime({
  text,
  onTextChange,
  placeholder,
  sendDisabled,
  isLoading,
  onSendDraft,
  onPause,
  isExpanded,
  onExpandedChange,
  editable,
  fontSize,
  narrowMode,
  sidePaddingPx = COMPOSER_SIDE_PADDING_PX,
  onActionsChange,
  isInputHistoryActive,
  onInputHistoryNavigate,
  leftControls,
  topContent,
  initialTextSelection,
  deferredIntent,
}: ComposerSurfaceProps) {
  const { setTimeoutTimer } = useTimer()
  const editorRef = useRef<Editor | null>(null)
  const textRef = useRef(text)
  const pendingLocalTextEchoRef = useRef<string | null>(null)
  const lastSerializedDraftRef = useRef<ComposerSerializedDraft | null>(null)
  const sendDisabledRef = useRef(sendDisabled)
  const editableRef = useRef(editable)
  const onSendDraftRef = useRef(onSendDraft)
  const isInputHistoryActiveRef = useRef(isInputHistoryActive)
  const onInputHistoryNavigateRef = useRef(onInputHistoryNavigate)
  const isExpandedRef = useRef(isExpanded)
  const pointerDownVersionRef = useRef(0)

  useLayoutEffect(() => {
    textRef.current = text
    sendDisabledRef.current = sendDisabled
    editableRef.current = editable
    onSendDraftRef.current = onSendDraft
    isInputHistoryActiveRef.current = isInputHistoryActive
    onInputHistoryNavigateRef.current = onInputHistoryNavigate
    isExpandedRef.current = isExpanded
  }, [editable, isExpanded, isInputHistoryActive, onInputHistoryNavigate, onSendDraft, sendDisabled, text])

  useEffect(() => {
    const onPointerDown = () => { pointerDownVersionRef.current += 1 }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [])

  const focusEditor = useCallback<ComposerSurfaceActions['focus']>((position) => {
    editorRef.current?.commands.focus(position, { scrollIntoView: false })
  }, [])
  const {
    fitContentHeight,
    editorContentStyle,
    frameRef,
    frameStyle,
    handleResizeKeyDown,
    handleTransitionEnd,
    hasCustomHeight,
    isResizing: isEditorResizing,
    maxHeight: editorMaxHeight,
    minHeight: editorMinHeight,
    resizeHandleValue,
    restoreDefaultHeight,
    startResize: startEditorResize,
    toggleExpanded: toggleEditorExpanded
  } = useComposerEditorFrameSizing({ fontSize, isExpanded, onExpandedChange, focusEditor, setTimeoutTimer })

  const createEditorFocusRestoreSnapshot = useCallback<() => ComposerFocusRestoreSnapshot>(
    () => ({
      activeElement: document.activeElement,
      pointerDownVersion: pointerDownVersionRef.current
    }),
    []
  )
  const shouldRestoreEditorFocus = useCallback(
    (snapshot: ComposerFocusRestoreSnapshot) => {
      if (pointerDownVersionRef.current !== snapshot.pointerDownVersion || !document.hasFocus()) return false

      const activeElement = document.activeElement
      return (
        activeElement === snapshot.activeElement ||
        activeElement === document.body ||
        (!!activeElement && !!frameRef.current?.contains(activeElement))
      )
    },
    [frameRef]
  )
  const submitDraft = useCallback(() => {
    const editor = editorRef.current
    if (sendDisabledRef.current || !editor || editor.view.composing) return

    const draft = serializeComposerDocument(editor)
    const focusRestoreSnapshot = createEditorFocusRestoreSnapshot()
    void onSendDraftRef.current(draft).finally(() => {
      if (shouldRestoreEditorFocus(focusRestoreSnapshot)) focusEditor()
    })
  }, [createEditorFocusRestoreSnapshot, focusEditor, shouldRestoreEditorFocus])

  const toggleEditorExpandedRef = useRef(toggleEditorExpanded)
  const fitContentHeightRef = useRef(fitContentHeight)
  useLayoutEffect(() => {
    toggleEditorExpandedRef.current = toggleEditorExpanded
    fitContentHeightRef.current = fitContentHeight
  }, [fitContentHeight, toggleEditorExpanded])

  const getDraft = useCallback((): ComposerSerializedDraft => {
    const editor = editorRef.current
    if (!editor || editor.isDestroyed) return lastSerializedDraftRef.current ?? { text: textRef.current, tokens: [] }
    return serializeComposerDocument(editor)
  }, [])

  const replaceDraft = useCallback((draft: ComposerSerializedDraft) => {
    const editor = editorRef.current
    if (!editor || editor.isDestroyed) return
    textRef.current = draft.text
    pendingLocalTextEchoRef.current = null
    setComposerEditorContent(editor, lastSerializedDraftRef, createComposerDraftContent(draft))
  }, [])

  useLayoutEffect(() => {
    onActionsChange({ focus: focusEditor, replaceDraft, getDraft })
  }, [focusEditor, getDraft, onActionsChange, replaceDraft])

  const editorExtensions = useMemo(() => createComposerEditorPreset({ placeholder }), [placeholder])
  const memoizedEditorProps = useMemo(() => ({
    attributes: {
      dir: 'auto',
      tabindex: '0',
      role: 'textbox',
      'aria-label': '向 AI 提问',
      'aria-multiline': 'true',
      'aria-readonly': String(!editable),
      class:
        'composer-tiptap box-border block w-full rounded-none break-words whitespace-pre-wrap text-foreground transition-none! outline-none',
      style: 'text-align: start'
    },
    handleKeyDown: (view: EditorView, event: KeyboardEvent) => {
      if (!editableRef.current || event.isComposing || view.composing || event.keyCode === 229) return false

      if (
        (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
        !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey &&
        shouldHandleInputHistoryNavigation({
          ...getComposerSelectionState(view, event.key, isInputHistoryActiveRef.current),
          isComposing: false,
          isQuickPanelVisible: false,
          key: event.key,
          text: textRef.current
        })
      ) {
        const direction: InputHistoryDirection = event.key === 'ArrowUp' ? 'up' : 'down'
        if (onInputHistoryNavigateRef.current(direction)) {
          event.preventDefault()
          event.stopPropagation()
          return true
        }
      }

      if (event.key === 'Escape' && isExpandedRef.current) {
        event.stopPropagation()
        toggleEditorExpandedRef.current(false)
        return true
      }

      // The composer is a single block. Every Enter combination stays out of the base keymap.
      if (isComposerEnter(event)) {
        event.preventDefault()
        if (matchesComposerEnter(event, false)) {
          if (!event.repeat) submitDraft()
        } else if (matchesComposerEnter(event, true)) {
          editorRef.current?.commands.setHardBreak()
        }
        return true
      }
      return false
    },
    handleDOMEvents: {
      paste: (_view: EditorView, event: ClipboardEvent) => {
        // Consume the event before ProseMirror parses HTML or Chrome opens a pasted file.
        event.preventDefault()
        const editor = editorRef.current
        const pastedText = readPlainTextTransfer(event.clipboardData)
        if (editor?.isEditable && pastedText) {
          fitContentHeightRef.current()
          const content = createComposerDraftContent({ text: pastedText }).content?.[0]?.content ?? []
          editor.commands.insertContent(content)
        }
        return true
      },
      copy: handleComposerCopy,
      cut: (view: EditorView, event: ClipboardEvent) => {
        if (!handleComposerCopy(view, event)) return false
        const editor = editorRef.current
        if (editor?.isEditable && !editor.isDestroyed) editor.chain().focus().deleteSelection().run()
        return true
      },
      drop: (_view: EditorView, event: DragEvent) => {
        event.preventDefault()
        return true
      },
    }
  }), [editable, submitDraft])

  const editor = useRichTextEditorKernel({
    extensions: editorExtensions,
    content: createComposerDraftContent({ text }),
    editable,
    // Keep an attached editor during the same commit that removes the fallback textarea.
    immediatelyRender: true,
    editorProps: memoizedEditorProps,
    onUpdate: ({ editor: updatedEditor }) => {
      const draft = serializeComposerDocument(updatedEditor)
      lastSerializedDraftRef.current = draft
      textRef.current = draft.text
      pendingLocalTextEchoRef.current = draft.text
      onTextChange(draft.text)
    },
    onCreate: ({ editor: createdEditor }) => {
      lastSerializedDraftRef.current = serializeComposerDocument(createdEditor)
    }
  })
  useLayoutEffect(() => {
    editorRef.current = editor
    return () => { editorRef.current = null }
  }, [editor])

  const focusHandoffDoneRef = useRef(false)
  useLayoutEffect(() => {
    if (focusHandoffDoneRef.current || !editor || editor.isDestroyed) return
    focusHandoffDoneRef.current = true
    const active = document.activeElement
    if (!document.hasFocus()) return
    if (active && active !== document.body && !frameRef.current?.contains(active)) return
    if (deferredIntent && !deferredIntent.hadFocus) return

    if (initialTextSelection) {
      editor.chain().focus(undefined, { scrollIntoView: false }).setTextSelection({
        from: getComposerPositionAtTextOffset(editor, initialTextSelection.start),
        to: getComposerPositionAtTextOffset(editor, initialTextSelection.end)
      }).run()
      return
    }
    editor.commands.focus('end', { scrollIntoView: false })
  }, [deferredIntent, editor, frameRef, initialTextSelection])

  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    const currentText = serializeComposerDocument(editor).text
    if (currentText === text || pendingLocalTextEchoRef.current === text) {
      pendingLocalTextEchoRef.current = null
      return
    }
    pendingLocalTextEchoRef.current = null
    setComposerEditorContent(editor, lastSerializedDraftRef, createComposerDraftContent({ text }))
  }, [editor, text])

  const handleExpandControlClick = useCallback(() => {
    if (hasCustomHeight) {
      restoreDefaultHeight()
      return
    }
    toggleEditorExpanded()
  }, [hasCustomHeight, restoreDefaultHeight, toggleEditorExpanded])

  const ExpandIcon = hasCustomHeight ? Minimize2 : Maximize2
  const sendAction = isLoading && sendDisabled ? (
    <Tooltip content="停止回答" placement="top">
      <button
        data-ui="chat.composer.action.pause"
        type="button"
        className="text-error flex size-7.5 items-center justify-center rounded-full border-0 bg-transparent p-0 hover:bg-accent"
        aria-label="停止回答"
        onClick={onPause}>
        <CirclePause size={20} />
      </button>
    </Tooltip>
  ) : (
    <SendMessageButton sendMessage={submitDraft} disabled={sendDisabled} shortcutLabel="Enter" />
  )

  return (
    <NarrowLayout
      narrowMode={narrowMode}
      withSidePadding
      className="pointer-events-none"
      style={{ width: '100%', paddingInline: sidePaddingPx }}>
      <div className="pointer-events-auto w-full">
        <div className="inputbar relative z-2 flex flex-col pt-0" onDrop={event => event.preventDefault()}>
          <div
            id="inputbar"
            data-ui="chat.composer"
            data-composer-inputbar=""
            data-composer-presentation="regular"
            className={cn(
              'inputbar-container relative transition-all duration-200 ease-in-out rounded-[20px] border-[0.5px] border-border bg-composer-surface pt-2 mb-3 shadow-sm',
              isExpanded && 'expanded'
            )}>
            <div
              data-composer-resize-handle=""
              data-resizing={isEditorResizing || undefined}
              role="separator"
              aria-orientation="horizontal"
              aria-valuemin={editorMinHeight}
              aria-valuemax={editorMaxHeight}
              aria-valuenow={resizeHandleValue}
              aria-label="调整输入框高度"
              tabIndex={0}
              onMouseDown={startEditorResize}
              onKeyDown={handleResizeKeyDown}
              className="group/composer-resize-handle absolute top-0 right-4 left-4 z-3 h-2 cursor-row-resize [-webkit-app-region:no-drag] focus-visible:bg-primary/40 focus-visible:outline-none">
              <div className="absolute top-0 right-0 left-0 h-0.5 rounded-full bg-primary/20 opacity-0 transition-opacity group-hover/composer-resize-handle:opacity-100 group-focus/composer-resize-handle:opacity-100 group-data-[resizing=true]/composer-resize-handle:bg-primary/35 group-data-[resizing=true]/composer-resize-handle:opacity-100" />
            </div>
            <div data-composer-expand-corner="" className="group/expand-corner absolute top-px right-px z-4 size-8">
              <span
                aria-hidden="true"
                data-composer-expand-corner-line=""
                className="pointer-events-none absolute top-1 right-1 size-3 origin-top-right scale-100 rounded-tr-[16px] border-t-[1.5px] border-r-[1.5px] border-foreground/60 opacity-70 transition-[opacity,scale] duration-200 ease-out group-focus-within/expand-corner:scale-50 group-focus-within/expand-corner:opacity-0 group-hover/expand-corner:scale-50 group-hover/expand-corner:opacity-0"
              />
              <Button
                type="button"
                onClick={handleExpandControlClick}
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground pointer-events-none absolute top-1 right-1 size-5.5 translate-x-2.5 -translate-y-2.5 scale-80 rotate-[-8deg] rounded-full bg-transparent opacity-0 shadow-none transition-[opacity,translate,scale,rotate,color,background-color] duration-300 ease-out group-focus-within/expand-corner:pointer-events-auto group-focus-within/expand-corner:translate-x-0 group-focus-within/expand-corner:translate-y-0 group-focus-within/expand-corner:scale-100 group-focus-within/expand-corner:rotate-0 group-focus-within/expand-corner:bg-accent/80 group-focus-within/expand-corner:text-foreground group-focus-within/expand-corner:opacity-100 group-hover/expand-corner:pointer-events-auto group-hover/expand-corner:translate-x-0 group-hover/expand-corner:translate-y-0 group-hover/expand-corner:scale-100 group-hover/expand-corner:rotate-0 group-hover/expand-corner:bg-accent/80 group-hover/expand-corner:text-foreground group-hover/expand-corner:opacity-100 hover:bg-accent hover:text-foreground focus-visible:pointer-events-auto focus-visible:translate-x-0 focus-visible:translate-y-0 focus-visible:scale-100 focus-visible:rotate-0 focus-visible:bg-accent focus-visible:text-foreground focus-visible:opacity-100 [&_svg]:!size-3"
                aria-pressed={hasCustomHeight}
                aria-label={hasCustomHeight ? '恢复输入框高度' : '展开输入框'}>
                <ExpandIcon className="transition-[scale] duration-300 ease-out group-focus-within/expand-corner:scale-110 group-hover/expand-corner:scale-110" />
              </Button>
            </div>
            {topContent}
            <div
              ref={frameRef}
              data-ui="part:composer-input"
              data-composer-editor-frame=""
              className="group/composer-editor relative flex min-w-0 flex-1 overflow-hidden transition-[height] ease-out"
              onTransitionEnd={handleTransitionEnd}
              style={frameStyle}>
              <ScrollArea
                type="auto"
                className="min-w-0 flex-1 [-webkit-app-region:no-drag]"
                style={editorContentStyle}
                contentProps={{ className: 'grid min-h-full' }}>
                <EditorContent editor={editor} className="grid min-w-0" />
              </ScrollArea>
            </div>
            <div
              data-ui="part:composer-actions"
              data-composer-toolbar=""
              className="relative z-2 flex h-10 shrink-0 flex-row justify-between gap-4 px-2 py-1.25">
              <div className="flex min-w-0 flex-1 items-center overflow-hidden">{leftControls}</div>
              <div className="flex flex-row items-center gap-1.5">{sendAction}</div>
            </div>
          </div>
        </div>
      </div>
    </NarrowLayout>
  )
}
