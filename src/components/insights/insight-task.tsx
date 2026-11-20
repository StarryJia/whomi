import { useEffect, useEffectEvent, useId, useMemo, useState } from 'react'
import { Check, ChevronDown, CircleAlert, Pause } from 'lucide-react'
import type { AnalysisTask, AiUsage } from '../../shared/ai-contract'
import { defaultInsightTitle, isInsightReport } from '../../shared/conversation-insights'
import { isMemoryReport } from '../../shared/memory'
import { thinkingLevelLabel } from '../conversation-ai/model-selector'
import { useUnresolvedExceptionNotices } from '../ui/exception-notices'

export const formatInsightNumber = (value: number) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value)

export function insightTaskFailed(task: AnalysisTask) {
  return !task.valid || task.state === 'failed' || task.state === 'interrupted'
}

export function insightTaskFailureKey(task: AnalysisTask) { return `insight-task:${task.id}` }

export function useInsightTaskFailureNotices(tasks: readonly AnalysisTask[]) {
  const unresolved = useMemo(() => new Set(tasks.filter(insightTaskFailed).map(insightTaskFailureKey)), [tasks])
  const resolve = useUnresolvedExceptionNotices(unresolved)
  return useEffectEvent((snapshot: AnalysisTask) => {
    if (insightTaskFailed(snapshot)) return
    const previous = tasks.find(task => task.id === snapshot.id)
    // 恢复与下一次失败可能在同一次渲染前到达。
    if (previous && insightTaskFailed(previous) && snapshot.eventSequence > previous.eventSequence) resolve?.(insightTaskFailureKey(snapshot))
  })
}

export function formatInsightDate(value: number, timezone?: string) {
  return new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: timezone }).format(value).replaceAll('-', '.')
}

export function formatInsightRange(start?: number | null, end?: number | null, timezone?: string) {
  return start == null || end == null ? '时间未记录' : formatInsightDate(start, timezone) + '—' + formatInsightDate(end, timezone)
}

export function insightReportRange(task: AnalysisTask) {
  const timezone = task.timezone ?? (task.scope?.kind === 'dates' ? task.scope.timezone : undefined)
  return formatInsightRange(task.sourceStartTimeMs, task.sourceEndTimeMs, timezone)
}

export function insightRange(task: AnalysisTask) {
  if (task.scope?.kind === 'dates') return task.scope.startDate.replaceAll('-', '.') + '—' + task.scope.endDate.replaceAll('-', '.')
  return insightReportRange(task)
}

export function insightCompletedAt(value?: number | null) {
  const time = value == null ? '' : new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(value)
  return value == null ? '时间未记录' : formatInsightDate(value) + ' ' + time
}

export function insightTaskTitle(task: AnalysisTask) {
  return task.title ?? (isInsightReport(task.report) || !task.report ? defaultInsightTitle : isMemoryReport(task.report) ? '我们的记忆' : '分析报告')
}

export function insightTaskNumber(task: AnalysisTask) {
  return '#' + (task.scope || isInsightReport(task.report) ? task.id : task.id.padStart(4, '0'))
}

export const known = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

export function useInsightRunDuration(task?: AnalysisTask) {
  const sampledAt = task?.state === 'running' && task.valid ? task.elapsedSampledAtMs : undefined
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (sampledAt === undefined) return
    setNow(Date.now())
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [sampledAt])
  const elapsed = task?.elapsedMs
  return sampledAt === undefined || elapsed === undefined ? elapsed : elapsed + Math.max(0, now - sampledAt)
}

export function insightElapsed(milliseconds?: number) {
  if (!known(milliseconds)) return '—'
  const elapsed = Math.floor(milliseconds / 1000)
  const minutes = Math.floor(elapsed / 60)
  return String(minutes).padStart(2, '0') + ':' + String(elapsed % 60).padStart(2, '0')
}

export function insightSpeed(count: number | undefined, milliseconds?: number) {
  return known(milliseconds) && milliseconds > 0 && known(count) && count > 0
    ? formatInsightNumber(count * 1000 / milliseconds) + ' 消息数/s' : '—'
}

export function insightPercentage(count?: number, total?: number) {
  return known(count) && known(total) && total > 0 ? Math.min(100, count / total * 100) : undefined
}

export function InsightRing({ percentage }: { percentage?: number }) {
  return <svg className="memory-coverage-ring" viewBox="0 0 24 24" aria-hidden="true">
    <circle className="memory-ring-track" cx="12" cy="12" r="9" />
    <circle className="memory-ring-value" cx="12" cy="12" r="9" pathLength="100" strokeDasharray={`${percentage ?? 0} 100`} transform="rotate(-90 12 12)" />
  </svg>
}

export function InsightStatus({ status }: { status: '生成中' | '已暂停' | '生成失败' | '已完成' | '正在暂停' | '正在重试' | '正在继续' | '已停止' }) {
  return <span className="insight-status" data-status={status} role="status">
    {status === '已暂停' ? <Pause aria-hidden="true" /> : status === '生成失败' ? <CircleAlert aria-hidden="true" />
      : status === '已完成' ? <Check aria-hidden="true" /> : <span className="insight-status-dot" aria-hidden="true" />}
    {status}
  </span>
}

export function InsightTaskDetails({ usage, range, outputSpeed }: { usage?: AiUsage; range?: string; outputSpeed?: number }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const input = usage?.totalInputTokens ?? (known(usage?.inputTokens) ? usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) : undefined)
  const partialInput = usage?.incomplete || usage?.totalInputTokens === undefined && (known(usage?.cacheReadTokens) !== known(usage?.cacheWriteTokens))
  const computed = known(usage?.outputTokens) && known(usage.durationMs) && usage.durationMs > 0
    ? usage.outputTokens * 1000 / usage.durationMs : outputSpeed ?? usage?.outputTokensPerSecond
  return <div className="insight-task-details">
    <button type="button" className="insight-details-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      详情<ChevronDown aria-hidden="true" />
    </button>
    <div id={id} hidden={!open}>
      <dl className="insight-usage" role="group" aria-label="分析用量">
        {range && <div className="insight-detail-wide"><dt>分析范围</dt><dd>{range}</dd></div>}
        <div><dt>输入词元</dt><dd>{known(input) ? (partialInput ? '至少 ' : '') + formatInsightNumber(input) : '—'}</dd></div>
        <div><dt>输出词元</dt><dd>{known(usage?.outputTokens) ? formatInsightNumber(usage.outputTokens) : '—'}</dd></div>
        <div className="insight-detail-wide"><dt>平均输出速度</dt><dd>{known(computed) ? formatInsightNumber(computed) + ' 词元/秒' : '—'}</dd></div>
        <div><dt>缓存读取</dt><dd>{known(usage?.cacheReadTokens) ? formatInsightNumber(usage.cacheReadTokens) + ' 词元' : '—'}</dd></div>
        <div><dt>缓存写入</dt><dd>{known(usage?.cacheWriteTokens) ? formatInsightNumber(usage.cacheWriteTokens) + ' 词元' : '—'}</dd></div>
      </dl>
    </div>
  </div>
}

export function InsightTaskModel({ task, model }: { task?: AnalysisTask; model?: string }) {
  return <dl className="insight-task-model">
    <div><dt>分析模型</dt><dd>{task?.modelIdentity?.label || task?.modelId || model || '—'}</dd></div>
    <div><dt>思考强度</dt><dd>{task ? thinkingLevelLabel(task.thinkingLevel) : '—'}</dd></div>
  </dl>
}
