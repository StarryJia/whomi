import { useEffect, useRef, useState } from 'react'
import type { AnalysisTask } from '../../shared/ai-contract'
import type { AnalysisProgress, AnalysisResult, ConversationAiAdapter } from './types'

type Phase = 'idle' | 'running' | 'done' | 'stopped' | 'failed' | 'interrupted'
type Request = Parameters<ConversationAiAdapter['analyze']>[0]
const incompatible = new Set(['MODEL_CHANGED', 'INVALID_MODEL', 'IDENTITY_CHANGED', 'PROMPT_CHANGED', 'PROCESSING_CHANGED', 'INVALID_TASK', 'INVALID_OWNER'])

function cannotResume(error: unknown) {
  return !!error && typeof error === 'object' && 'code' in error && incompatible.has(String(error.code))
}

function failure(error: unknown) {
  if (error && typeof error === 'object' && 'action' in error && typeof error.action === 'string') return error.action
  return error instanceof Error ? error.message : '操作失败，请重试。'
}

function phaseOf(task: AnalysisTask): Phase {
  if (!task.valid) return 'failed'
  switch (task.state) {
    case 'completed': return 'done'
    case 'failed': case 'stopped': case 'interrupted': return task.state
    default: return 'running'
  }
}

export function useAnalysisTask(adapter: ConversationAiAdapter | undefined, conversationId: string, identityRevision: number, initialTaskId?: string, fromMemory = false) {
  const resumeOnEntry = useRef(fromMemory ? initialTaskId : undefined)
  const preferredTask = useRef(initialTaskId)
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState<AnalysisProgress>()
  const [result, setResult] = useState<AnalysisResult>()
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(true)
  const [blocked, setBlocked] = useState(false)
  const [stopping, setStopping] = useState(false)
  const operation = useRef<AbortController | undefined>(undefined)
  const generation = useRef(0)
  const task = progress?.task
  const resumable = !!(task?.valid && adapter?.continueAnalysis && !blocked &&
    (phase === 'stopped' || phase === 'failed' || phase === 'interrupted'))

  function receive(snapshot: AnalysisTask) {
    setProgress({ task: snapshot, analyzedMessages: snapshot.analyzedMessages, totalMessages: snapshot.totalMessages, usage: snapshot.usage })
    setResult({ taskId: snapshot.id, usage: snapshot.usage, task: snapshot })
    setPhase(phaseOf(snapshot))
    setError(snapshot.valid ? snapshot.error ?? '' : '本人或资料范围已变化，请重新分析。')
    setConfirming(false)
  }

  useEffect(() => {
    const observer = new AbortController()
    const version = ++generation.current
    setPhase('idle'); setProgress(undefined); setResult(undefined)
    setError(''); setConfirming(true); setBlocked(false); setStopping(false)
    if (!fromMemory || preferredTask.current) void adapter?.watchAnalysis?.(conversationId, snapshot => {
      if (version === generation.current) receive(snapshot)
    }, observer.signal, preferredTask.current).catch(cause => {
      if (version !== generation.current) return
      setError(failure(cause))
      if (cannotResume(cause)) { setPhase('failed'); setBlocked(true) }
    })
    return () => {
      generation.current++
      observer.abort('detach')
      operation.current?.abort('detach')
      operation.current = undefined
    }
  }, [adapter, conversationId, identityRevision, fromMemory])

  async function run(request?: Request) {
    if (!adapter || stopping || operation.current || (!request && !resumable)) return
    const controller = new AbortController()
    operation.current = controller
    const version = ++generation.current
    let accepted = false
    setPhase('running'); setConfirming(false); setError(''); setBlocked(false)
    if (request) { setProgress(undefined); setResult(undefined) }
    function update(value: AnalysisProgress) {
      if (version !== generation.current) return
      if (value.task) { accepted = true; preferredTask.current = value.task.id; receive(value.task) }
      else setProgress(value)
    }
    try {
      const outcome = request
        ? await adapter.analyze(request, { signal: controller.signal, onProgress: update })
        : await adapter.continueAnalysis!(task!.id, controller.signal, update)
      if (version !== generation.current) return
      if (outcome?.task) receive(outcome.task)
      else { setResult(outcome || undefined); setPhase('done') }
    } catch (cause) {
      if (version !== generation.current) return
      // 新分析在创建前失败时，原任务的断点仍应可用。
      if (request && !accepted && task) receive(task)
      else setPhase('failed')
      setError(failure(cause))
      if ((!request || accepted) && cannotResume(cause)) setBlocked(true)
    } finally {
      if (operation.current === controller) operation.current = undefined
    }
  }

  useEffect(() => {
    if (!task || task.id !== resumeOnEntry.current) return
    resumeOnEntry.current = undefined
    if (resumable) void run()
  }, [task, resumable])

  async function stop() {
    if (stopping || phase !== 'running') return
    if (!task || !adapter?.stopAnalysis) {
      if (adapter?.continueAnalysis) return
      generation.current++
      operation.current?.abort()
      operation.current = undefined
      setPhase('stopped')
      return
    }
    setStopping(true)
    const version = generation.current
    try {
      const saved = await adapter.stopAnalysis(task.id)
      if (version !== generation.current) return
      generation.current++
      operation.current?.abort('detach')
      operation.current = undefined
      if (saved) receive(saved)
      else setPhase('stopped')
      setStopping(false)
    } catch (cause) {
      if (version === generation.current) { setError(failure(cause)); setStopping(false) }
    }
  }

  return { phase, progress, result, error, setError, confirming, setConfirming, resumable, stopping, run, stop }
}
