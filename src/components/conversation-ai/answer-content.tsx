import { useLayoutEffect, useMemo, useRef } from 'react'
import { parseMarkdownIntoBlocks, type Components } from 'streamdown'
import remend from 'remend'
import { MarkdownCore } from '../../vendor/cherry-markdown/internal'
import './answer-content.css'

const components: Partial<Components> = {
  a: ({ children, href, title }) => <a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a>,
  table: ({ children }) => <div className="conversation-answer-table" tabIndex={0}><table>{children}</table></div>,
  pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
  code: ({ children, className }) => <code className={className}>{children}</code>,
  // 回答中的远程图片不能在用户阅读时自动外发请求。
  img: ({ alt }) => <span>{alt}</span>,
}

function AnswerBlock({ id, text }: { id: string; text: string }) {
  const body = useRef<HTMLDivElement>(null)
  const horizontal = useRef(0)
  useLayoutEffect(() => {
    const overflow = body.current?.querySelector<HTMLElement>('pre, .conversation-answer-table')
    if (overflow) overflow.scrollLeft = horizontal.current
  }, [text])
  return <div ref={body} onScrollCapture={event => { horizontal.current = (event.target as HTMLElement).scrollLeft }}>
    <MarkdownCore key={text} id={id} mode="static" animated={false} components={components} footnoteLabel="注释">{text}</MarkdownCore>
  </div>
}

export function AnswerContent({ id, text, status }: {
  id: string; text: string; status: 'running' | 'done' | 'failed' | 'stopped'
}) {
  // 只刷新变化的上游区块，保留已完成正文及局部横向阅读位置。
  const blocks = useMemo(() => parseMarkdownIntoBlocks(status === 'running' ? remend(text) : text), [text, status])
  return <div className="markdown conversation-answer-text">{blocks.map((block, index) =>
    <AnswerBlock key={`${id}-${index}`} id={`${id}-${index}`} text={block} />)}</div>
}
