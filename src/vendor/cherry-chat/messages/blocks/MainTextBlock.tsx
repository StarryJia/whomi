import { ChevronDown } from 'lucide-react'
import { type ReactNode, memo, useId, useMemo, useState } from 'react'

import { AnswerContent } from '../../../../components/conversation-ai/answer-content'
import type { MessageListItem, MessageStatus } from '../types'
import { useScrollAnchor } from './useScrollAnchor'

const USER_MESSAGE_PREVIEW_EFFECTIVE_LINE_COUNT = 5

function buildUserMessageTextPreview(content: string) {
  let effectiveLineCount = 0
  const lineRegex = /([^\r\n]*)(\r\n|\r|\n|$)/g

  for (const match of content.matchAll(lineRegex)) {
    const [lineWithEnding, line] = match
    if (lineWithEnding.length === 0) break
    if (line.trim().length === 0) continue

    effectiveLineCount += 1

    if (effectiveLineCount === USER_MESSAGE_PREVIEW_EFFECTIVE_LINE_COUNT) {
      const remainingStart = match.index + lineWithEnding.length
      const hasMoreEffectiveLines = content
        .slice(remainingStart)
        .split(/\r\n|\r|\n/)
        .some((remainingLine) => remainingLine.trim().length > 0)

      return {
        content: hasMoreEffectiveLines ? content.slice(0, match.index + line.length) : content,
        isTruncated: hasMoreEffectiveLines
      }
    }
  }

  return { content, isTruncated: false }
}

function CollapsibleUserMessageContent({
  children,
  isCollapsible,
  isExpanded,
  onToggle
}: {
  children: ReactNode
  isCollapsible: boolean
  isExpanded: boolean
  onToggle: () => void
}) {
  const contentId = useId()
  const { anchorRef, withScrollAnchor } = useScrollAnchor<HTMLDivElement>()

  return (
    <div ref={anchorRef} className="flex max-w-full flex-col items-start">
      <div
        id={contentId}
        data-user-message-collapsible-content-preview
        className="max-w-full [&_.markdown>*:last-child]:mb-0! [&>*:last-child]:mb-0!">
        {children}
      </div>
      {isCollapsible && (
        <button
          type="button"
          aria-expanded={isExpanded}
          aria-controls={contentId}
          data-user-message-content-toggle
          className="mt-1 flex min-h-7 w-full items-center justify-start gap-1.5 rounded border-0 bg-transparent px-0 py-0.5 text-left text-[13px] text-muted-foreground focus-visible:bg-accent/50 focus-visible:outline-none"
          onClick={() => withScrollAnchor(onToggle, { enterReadingMode: !isExpanded })}>
          <span className="shrink-0 font-normal leading-5">{isExpanded ? '收起问题' : '展开问题'}</span>
          <ChevronDown
            aria-hidden="true"
            size={16}
            className={`shrink-0 opacity-70 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
          />
        </button>
      )}
    </div>
  )
}

function UserText({ content }: { content: string }) {
  const userMessagePreview = useMemo(() => buildUserMessageTextPreview(content), [content])
  const [isUserContentExpanded, setUserContentExpanded] = useState(false)
  const userDisplayContent = userMessagePreview.isTruncated && !isUserContentExpanded ? userMessagePreview.content : content
  return (
    <CollapsibleUserMessageContent
      isCollapsible={userMessagePreview.isTruncated}
      isExpanded={isUserContentExpanded}
      onToggle={() => setUserContentExpanded((expanded) => !expanded)}>
      <p className="markdown whitespace-pre-wrap [overflow-wrap:anywhere]">{userDisplayContent}</p>
    </CollapsibleUserMessageContent>
  )
}

const MainTextBlock = ({ id, content, role, status }: {
  id: string
  content: string
  role: MessageListItem['role']
  status: MessageStatus
}) => (
  role === 'user' ? <UserText content={content} /> : <AnswerContent id={id} text={content} status={status} />
)

export default memo(MainTextBlock)
