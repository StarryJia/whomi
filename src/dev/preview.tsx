import { StrictMode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../App'
import { createPreviewClient } from '../data/preview-client'
import type { FeedbackReceipt, FeedbackSaver } from '../components/overview/types'
import type { ClarificationReceipt, ClarificationWithdrawal } from '../components/clarification/types'
import { overviewScenarios } from './overview-fixtures'
import { clarificationConversations, clarificationScenarios } from './clarification-fixtures'
import { conversationPreview, createConversationAiPreview, type ConversationPreviewMode } from './conversation-ai-preview'
import './preview.css'

type SaveMode = 'normal' | 'delayed' | 'fail-once' | 'always-fail' | 'no-adapter'

const previewReceipt: FeedbackReceipt = { persistence: 'preview', analysis: 'not-requested' }
type ActionMode = Exclude<SaveMode, 'no-adapter'>

function usePreviewOperation<T>(makeReceipt: () => T) {
  const [mode, setMode] = useState<ActionMode>('normal')
  const [waitingCount, setWaitingCount] = useState(0)
  const modeRef = useRef<ActionMode>('normal')
  const failedOnce = useRef(false)
  const factoryRef = useRef(makeReceipt)
  factoryRef.current = makeReceipt
  const waiting = useRef<Array<{ resolve: (value: T) => void; reject: (reason: Error) => void }>>([])

  useEffect(() => () => {
    waiting.current.splice(0).forEach(item => item.reject(new Error('预览已关闭。')))
  }, [])

  const run = useCallback(async () => {
    if (modeRef.current === 'always-fail' || (modeRef.current === 'fail-once' && !failedOnce.current)) {
      failedOnce.current = true
      throw new Error('模拟操作失败。')
    }
    if (modeRef.current === 'delayed') return new Promise<T>((resolve, reject) => {
      waiting.current.push({ resolve, reject })
      setWaitingCount(waiting.current.length)
    })
    return factoryRef.current()
  }, [])

  function reset() {
    waiting.current.splice(0).forEach(item => item.reject(new Error('预览条件已切换。')))
    failedOnce.current = false
    setWaitingCount(0)
  }

  function changeMode(value: ActionMode) {
    reset()
    modeRef.current = value
    setMode(value)
  }

  function complete() {
    waiting.current.splice(0).forEach(item => item.resolve(factoryRef.current()))
    setWaitingCount(0)
  }

  return { mode, run, waitingCount, changeMode, complete, reset }
}

function SimulationOptions() {
  return <>
    <option value="normal">正常模拟</option>
    <option value="delayed">等待手动完成</option>
    <option value="fail-once">首次失败，重试成功</option>
    <option value="always-fail">始终失败</option>
  </>
}

function DevelopmentPreview() {
  const [page, setPage] = useState<'overview' | 'clarification' | 'conversation'>(() => {
    const value = new URLSearchParams(window.location.search).get('page')
    return value === 'clarification' || value === 'conversation' ? value : 'overview'
  })
  const [conversationMode, setConversationMode] = useState<ConversationPreviewMode>('normal')
  const [conversationAdapterMissing, setConversationAdapterMissing] = useState(false)
  const conversationAdapter = useMemo(() => createConversationAiPreview(conversationMode), [conversationMode])
  const [scenarioId, setScenarioId] = useState(overviewScenarios[0].id)
  const [clarificationId, setClarificationId] = useState(clarificationScenarios[0].id)
  const [saveMode, setSaveMode] = useState<SaveMode>('normal')
  const [waitingCount, setWaitingCount] = useState(0)
  const modeRef = useRef<SaveMode>('normal')
  const failedOnce = useRef(false)
  const waiting = useRef<Array<(receipt: FeedbackReceipt) => void>>([])
  const frameRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const scenario = overviewScenarios.find(item => item.id === scenarioId) ?? overviewScenarios[0]
  const clarificationScenario = clarificationScenarios.find(item => item.id === clarificationId) ?? clarificationScenarios[0]
  const client = useMemo(() => createPreviewClient(page === 'overview' ? scenario.conversations : page === 'conversation' ? conversationPreview : clarificationConversations), [page, scenario.conversations])
  const answerCount = useRef(0)
  const submission = usePreviewOperation<ClarificationReceipt>(() => ({ answerId: `preview-answer-${++answerCount.current}`, persistence: 'preview' }))
  const withdrawal = usePreviewOperation<ClarificationWithdrawal>(() => ({ persistence: 'preview' }))

  useLayoutEffect(() => {
    const updateSize = () => {
      frameRef.current?.style.setProperty('--preview-toolbar-height', `${toolbarRef.current?.offsetHeight ?? 0}px`)
      frameRef.current?.style.setProperty('--preview-stage-height', `${surfaceRef.current?.clientHeight ?? 0}px`)
    }
    updateSize()
    const observer = new ResizeObserver(updateSize)
    if (toolbarRef.current) observer.observe(toolbarRef.current)
    if (surfaceRef.current) observer.observe(surfaceRef.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => () => {
    waiting.current.splice(0).forEach(resolve => resolve(previewReceipt))
  }, [])

  const saveFeedback = useCallback<FeedbackSaver>(async () => {
    const mode = modeRef.current
    if (mode === 'always-fail' || (mode === 'fail-once' && !failedOnce.current)) {
      failedOnce.current = true
      throw new Error('模拟保存失败，请重试。')
    }
    if (mode === 'delayed') {
      return new Promise<FeedbackReceipt>(resolve => {
        waiting.current.push(resolve)
        setWaitingCount(waiting.current.length)
      })
    }
    return previewReceipt
  }, [])

  function completeWaiting() {
    waiting.current.splice(0).forEach(resolve => resolve(previewReceipt))
    setWaitingCount(0)
  }

  function changeScenario(id: string) {
    completeWaiting()
    failedOnce.current = false
    setScenarioId(id)
  }

  function changeMode(mode: SaveMode) {
    completeWaiting()
    failedOnce.current = false
    modeRef.current = mode
    setSaveMode(mode)
  }

  return <div className="preview-page" ref={frameRef}>
    <header className="preview-toolbar" ref={toolbarRef} aria-label="开发预览工具">
      <div className="preview-notice">
        <strong>开发预览</strong>
        <span>全部内容为虚构示例 · 未写入真实存储</span>
      </div>
      <details className="preview-controls">
        <summary>预览控制</summary>
        <div className="preview-controls-content">
          <label>
            <span>预览页面</span>
            <select value={page} onChange={event => {
              completeWaiting()
              submission.reset()
              withdrawal.reset()
              setPage(event.target.value as typeof page)
            }}>
              <option value="overview">个人总览</option>
              <option value="clarification">问一问</option>
              <option value="conversation">会话与 AI 对话</option>
            </select>
          </label>
          {page === 'overview' ? <><label>
            <span>预览场景</span>
            <select value={scenarioId} onChange={event => changeScenario(event.target.value)}>
              {overviewScenarios.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          <label>
            <span>反馈保存模拟</span>
            <select value={saveMode} onChange={event => changeMode(event.target.value as SaveMode)}>
              <option value="normal">正常模拟</option>
              <option value="delayed">等待手动完成</option>
              <option value="fail-once">首次失败，重试成功</option>
              <option value="always-fail">始终失败</option>
              <option value="no-adapter">无保存适配器</option>
            </select>
          </label>
          {saveMode === 'delayed' && <button type="button" onClick={completeWaiting} disabled={!waitingCount}>
            完成等待中的模拟保存{waitingCount > 0 && `（${waitingCount}）`}
          </button>}
          <p className="preview-scenario-hint">{scenario.description} 切换场景后，点击 Hello 进入总览。</p>
          {saveMode === 'delayed' && <p className="preview-save-hint" role="status">
            {waitingCount ? '保存正在等待。点击完成等待中的模拟保存继续。' : '提交反馈后，在这里手动完成模拟保存。'}
          </p>}
          {saveMode === 'no-adapter' && <p className="preview-save-hint">可编辑反馈草稿；当前无法提交。</p>}
          </> : page === 'conversation' ? <>
            <label><span>对话与分析模拟</span><select value={conversationMode} onChange={event => setConversationMode(event.target.value as ConversationPreviewMode)}>
              <option value="normal">正常流式模拟</option><option value="fail-once">首次失败，重试成功</option>
              <option value="slow">慢速，可停止</option><option value="no-usage">不提供统计</option>
            </select></label>
            <label><span>模型连接</span><select value={String(conversationAdapterMissing)} onChange={event => setConversationAdapterMissing(event.target.value === 'true')}>
              <option value="false">示例适配器</option><option value="true">无可用模型</option>
            </select></label>
            <p className="preview-scenario-hint">点击会话顶部光标开启消息选择，再向 AI 提问。回答、分析进度和统计均为模拟；切换条件会重置本轮预览。</p>
          </> : <>
            <label>
              <span>问一问场景</span>
              <select value={clarificationId} onChange={event => {
                submission.reset()
                withdrawal.reset()
                setClarificationId(event.target.value)
              }}>
                {clarificationScenarios.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <label>
              <span>回答提交模拟</span>
              <select value={submission.mode} onChange={event => submission.changeMode(event.target.value as ActionMode)}><SimulationOptions /></select>
            </label>
            <label>
              <span>回答撤回模拟</span>
              <select value={withdrawal.mode} onChange={event => withdrawal.changeMode(event.target.value as ActionMode)}><SimulationOptions /></select>
            </label>
            {submission.mode === 'delayed' && <button type="button" onClick={submission.complete} disabled={!submission.waitingCount}>完成模拟提交</button>}
            {withdrawal.mode === 'delayed' && <button type="button" onClick={withdrawal.complete} disabled={!withdrawal.waitingCount}>完成模拟撤回</button>}
            <p className="preview-scenario-hint">{clarificationScenario.description} 切换场景后，点击侧栏问一问进入。</p>
            {(submission.waitingCount > 0 || withdrawal.waitingCount > 0) && <p className="preview-save-hint" role="status">操作正在等待，请点击对应的完成模拟按钮。</p>}
          </>}
        </div>
      </details>
    </header>
    <div className="preview-surface" ref={surfaceRef}>
      <App key={`${page}-${page === 'overview' ? scenario.id : page === 'conversation' ? `${conversationMode}-${conversationAdapterMissing}` : clarificationScenario.id}`} displayName=""
        client={client}
        previewConversationId={page === 'conversation' ? conversationPreview[0].id : undefined}
        conversationAiAdapter={page === 'conversation' && !conversationAdapterMissing ? conversationAdapter : undefined}
        overview={page === 'overview' ? scenario.overview : undefined}
        saveFeedback={saveMode === 'no-adapter' ? undefined : saveFeedback}
        clarificationQuestion={page === 'clarification' ? clarificationScenario.question : undefined}
        clarificationModels={page === 'clarification' ? clarificationScenario.models : []}
        clarificationAdapter={page === 'clarification' && !clarificationScenario.noAdapter
          ? { submit: submission.run, withdraw: withdrawal.run } : undefined} preview />
    </div>
  </div>
}

if (import.meta.env.DEV) {
  const root = createRoot(document.getElementById('root')!)
  root.render(<StrictMode><DevelopmentPreview /></StrictMode>)
  import.meta.hot?.dispose(() => root.unmount())
}
