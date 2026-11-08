import { type FC, Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { cn } from '@cherrystudio/ui/lib/utils'

import { useMessageParts } from '../blocks/MessagePartsContext'
import { useTemporaryValue } from '../hooks/useTemporaryValue'
import { useMessageListActions } from '../MessageListProvider'
import type { MessageListItem } from '../types'
import {
  executeMessageMenuBarAction,
  type MessageMenuBarActionContext,
  type MessageMenuBarResolvedAction,
  resolveMessageMenuBarToolbarActions
} from './messageMenuBarActions'
import { renderDefaultToolbarAction } from './MessageMenuBarToolbarRenderers'
import MessageTokens from './MessageTokens'

interface Props {
  message: MessageListItem
  isLastMessage: boolean
}

const MessageMenuBar: FC<Props> = ({ message, isLastMessage }) => {
  const actions = useMessageListActions()
  const [copied, setCopied] = useTemporaryValue(false, 2000)
  const [isCopying, setIsCopying] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const copyGeneration = useRef(0)
  const messageParts = useMessageParts(message.id)
  const mainTextContent = useMemo(() => messageParts.map(({ text }) => text).join('\n'), [messageParts])

  useEffect(() => {
    setCopied(false)
    setIsCopying(false)
    setCopyFailed(false)
    return () => { copyGeneration.current++ }
  }, [mainTextContent, setCopied])

  const actionContext = useMemo<MessageMenuBarActionContext>(
    () => ({
      actions,
      message,
      mainTextContent,
      copied,
      setCopied,
      isCopying,
      isProcessing: message.status === 'running'
    }),
    [actions, copied, isCopying, mainTextContent, message, setCopied]
  )

  const toolbarActions = useMemo(() => resolveMessageMenuBarToolbarActions(actionContext), [actionContext])

  const executeAction = useCallback(
    async (action: MessageMenuBarResolvedAction) => {
      if (action.id !== 'copy') {
        await executeMessageMenuBarAction(action.id, actionContext)
        return
      }
      const generation = ++copyGeneration.current
      setIsCopying(true)
      setCopyFailed(false)
      try {
        await executeMessageMenuBarAction(action.id, {
          ...actionContext,
          setCopied: (value) => { if (copyGeneration.current === generation) setCopied(value) }
        })
      } catch {
        if (copyGeneration.current === generation) setCopyFailed(true)
      } finally {
        if (copyGeneration.current === generation) setIsCopying(false)
      }
    },
    [actionContext, setCopied]
  )

  return (
    <>
      <div
        data-ui="part:message-actions"
        className={cn('menubar flex select-none flex-row items-center justify-end gap-1.5', isLastMessage && 'show')}>
        {toolbarActions.map((action) => (
          <Fragment key={action.id}>
            {renderDefaultToolbarAction({ action, executeAction, softHoverBg: !isLastMessage })}
          </Fragment>
        ))}
        {copied && <span role="status" className="sr-only">已复制</span>}
        {copyFailed && <span role="alert" className="whitespace-normal">复制失败，请重试。</span>}
      </div>
      <MessageTokens message={message} />
    </>
  )
}

export default memo(MessageMenuBar)
