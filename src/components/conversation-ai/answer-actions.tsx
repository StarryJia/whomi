import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'

// Cherry useCopyToClipboard 的成功反馈流程；本地回答只写入原始 Markdown。
export function AnswerActions({ text, available }: { text: string; available: boolean }) {
  const [state, setState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle')
  const generation = useRef(0)
  useEffect(() => { generation.current++; setState('idle'); return () => { generation.current++ } }, [text])
  useEffect(() => {
    if (state !== 'copied') return
    const timer = setTimeout(() => setState('idle'), 2000)
    return () => clearTimeout(timer)
  }, [state])
  async function copy() {
    const current = ++generation.current
    setState('copying')
    try {
      await navigator.clipboard.writeText(text)
      if (generation.current === current) setState('copied')
    } catch {
      if (generation.current === current) setState('failed')
    }
  }
  if (!available || !text.trim()) return null
  return <div className="conversation-answer-actions">
    <button type="button" aria-label={state === 'copied' ? '已复制' : '复制回答'} title={state === 'copied' ? '已复制' : '复制回答'}
      disabled={state === 'copying'} onClick={() => { void copy() }}>{state === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</button>
    {state === 'copied' && <span role="status" className="visually-hidden">已复制</span>}
    {state === 'failed' && <span role="alert">复制失败，请重试。</span>}
  </div>
}
