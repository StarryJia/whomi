import { useEffect, useRef, useState } from 'react'
import type { AnalysisTask } from '../../shared/ai-contract'
import { operationFailure, type OperationFailure } from '../../shared/operation-diagnostics'
import type { AnalysisProgress, AnalysisResult, ConversationAiAdapter } from './types'

type Phase = 'idle' | 'running' | 'done' | 'stopped' | 'failed' | 'interrupted'
type Request = Parameters<ConversationAiAdapter['analyze']>[0]
type TaskView = { phase: Phase; progress?: AnalysisProgress; result?: AnalysisResult; error: string; errorOperation?: OperationFailure; blocked: boolean }
type CreationFailure = { scope: Request['scope']; error: string; previous?: TaskView }
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
    case 'completed': return task.report ? 'done' : 'failed'
    case 'failed': case 'stopped': case 'interrupted': return task.state
    default: return 'running'
  }
}

export function useAnalysisTask(adapter: ConversationAiAdapter | undefined, conversationId: string, identityRevision: number, initialTaskId?: string, fromMemory = false) {
  const preferredTask = useRef(initialTaskId)
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState<AnalysisProgress>()
  const [result, setResult] = useState<AnalysisResult>()
  const [{ error, errorOperation }, setFailure] = useState<{ error: string; errorOperation?: OperationFailure }>({ error: '' })
  function setError(cause: unknown) {
    setFailure({ error: typeof cause === 'string' ? cause : failure(cause), errorOperation: operationFailure(cause) })
  }
  const [confirming, setConfirming] = useState(!initialTaskId)
  const [blocked, setBlocked] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [creationFailure, setCreationFailure] = useState<CreationFailure>()
  const [resuming, setResuming] = useState<'continue' | 'retry'>()
  const operation = useRef<AbortController | undefined>(undefined)
  const generation = useRef(0)
  const task = progress?.task
  const resumable = !!(task?.valid && adapter?.continueAnalysis && !blocked &&
    (phase === 'stopped' || phase === 'failed' || phase === 'interrupted'))

  function receive(snapshot: AnalysisTask) {
    setResuming(undefined)
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
    setError(''); setConfirming(!preferredTask.current); setBlocked(false); setStopping(false); setResuming(undefined); setCreationFailure(undefined)
    if (!fromMemory || preferredTask.current) void adapter?.watchAnalysis?.(conversationId, snapshot => {
      if (version === generation.current) receive(snapshot)
    }, observer.signal, preferredTask.current).catch(cause => {
      if (version !== generation.current) return
      setError(failure(cause))
      if (preferredTask.current || cannotResume(cause)) { setPhase('failed'); setConfirming(false); setBlocked(true) }
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
    const previous = creationFailure?.previous ?? (task || result?.taskId
      ? { phase, progress, result, error: error || task?.error || '', errorOperation, blocked } : undefined)
    let accepted = false
    setConfirming(false); setError(''); setBlocked(false); setCreationFailure(undefined)
    if (request) { setPhase('running'); setProgress(undefined); setResult(undefined) }
    else setResuming(phase === 'stopped' ? 'continue' : 'retry')
    function update(value: AnalysisProgress) {
      if (version !== generation.current) return
      if (value.task) { accepted = true; preferredTask.current = value.task.id; receive(value.task) }
      else if (request || accepted) setProgress(value)
    }
    try {
      const outcome = request
        ? await adapter.analyze(request, { signal: controller.signal, onProgress: update })
        : await adapter.continueAnalysis!(task!.id, controller.signal, update)
      if (version !== generation.current) return
      if (outcome?.task) receive(outcome.task)
      else if (outcome?.taskId) { setResult(outcome); setPhase('done') }
      else { setPhase('failed'); setError('报告尚未保存，请重试。') }
    } catch (cause) {
      if (version !== generation.current) return
      if (request && !accepted) {
        setCreationFailure({ scope: request.scope, error: failure(cause), previous })
        setProgress(undefined)
      } else {
        setError(cause)
        if (cannotResume(cause)) setBlocked(true)
      }
      if (request || accepted) setPhase('failed')
    } finally {
      if (operation.current === controller) operation.current = undefined
      if (version === generation.current) setResuming(undefined)
    }
  }

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

  function restorePrevious() {
    const previous = creationFailure?.previous
    if (!previous) return
    setCreationFailure(undefined)
    setPhase(previous.phase)
    setProgress(previous.progress)
    setResult(previous.result)
    setFailure({ error: previous.error, errorOperation: previous.errorOperation })
    setBlocked(previous.blocked)
  }

  return { phase, progress, result, error, errorOperation, setError, confirming, setConfirming, resumable, stopping, resuming,
    creationFailure, restorePrevious, run, stop }
}
