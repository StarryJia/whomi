import { Box } from 'lucide-react'
import { useLayoutEffect, useRef } from 'react'

import { messagePerformance } from '../../../../components/conversation-ai/message-performance'
import type { MessageListItem } from '../types'

const PRIMARY_METRIC_FONT_SIZES = [16, 14, 12, 10] as const

function fitPrimaryMetricValue(element: HTMLElement) {
  element.style.whiteSpace = 'nowrap'
  element.style.overflowWrap = 'normal'

  for (const fontSize of PRIMARY_METRIC_FONT_SIZES) {
    element.style.fontSize = `${fontSize}px`
    if (element.scrollWidth <= element.clientWidth) return
  }

  element.style.whiteSpace = 'normal'
  element.style.overflowWrap = 'anywhere'
}

function PrimaryMetric({ label, value, testId }: { label: string; value: string; testId: string }) {
  const valueRef = useRef<HTMLElement>(null)

  useLayoutEffect(() => {
    const element = valueRef.current
    if (!element) return

    let frame = 0
    let lastWidth = -1
    const fit = () => {
      frame = 0
      const width = element.clientWidth
      if (width === lastWidth) return
      lastWidth = width
      fitPrimaryMetricValue(element)
    }
    fit()
    // The popover receives its collision width after the metrics have mounted.
    const observer = new ResizeObserver(() => {
      if (!frame && element.clientWidth !== lastWidth) frame = requestAnimationFrame(fit)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [value])

  return (
    <div data-testid={testId} className="min-w-0 rounded-md bg-muted px-3 py-2.5">
      <dt className="truncate text-[11px] text-muted-foreground leading-4" title={label}>{label}</dt>
      <dd
        ref={valueRef}
        className="mt-1 ml-0 whitespace-nowrap font-semibold text-base text-foreground tabular-nums leading-5"
        title={value}>
        {value}
      </dd>
    </div>
  )
}

function DetailMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[11px] text-muted-foreground leading-4">{label}</dt>
      <dd className="ml-0 truncate text-muted-foreground text-xs tabular-nums leading-5" title={value}>{value}</dd>
    </div>
  )
}

const numberFormatter = new Intl.NumberFormat('zh-CN')
const decimalFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })
const dateFormatter = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' })

const formatTokens = (value: number) => `${numberFormatter.format(value)} Tokens`
const formatSpeed = (value: number) => `${decimalFormatter.format(value)} Token/秒`
const formatMilliseconds = (value: number) => `${decimalFormatter.format(value / 1000)} 秒`

function knownMetric(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0
}

function optionalMetric(value: number | undefined, format: (value: number) => string) {
  return knownMetric(value) ? format(value) : '—'
}

const MessageTokenDetailsCard = ({ message }: { message: MessageListItem }) => {
  const stats = message.stats
  const model = message.model
  if (!stats) return null

  const performance = messagePerformance(stats)
  const { inputTokens, uncachedTokens, modelTokensPerSecond, endToEndTokensPerSecond } = performance
  const { outputTokens, cacheReadTokens, cacheWriteTokens, firstTokenMs, durationMs, completedAt } = stats
  const completed = knownMetric(completedAt) ? new Date(completedAt) : undefined
  const completedAtLabel = completed && Number.isFinite(completed.getTime()) ? dateFormatter.format(completed) : undefined
  const detailMetrics = [
    knownMetric(cacheReadTokens) && cacheReadTokens > 0
      ? { id: 'cache-read', label: '缓存读取', value: formatTokens(cacheReadTokens) }
      : undefined,
    knownMetric(cacheWriteTokens) && cacheWriteTokens > 0
      ? { id: 'cache-write', label: '缓存写入', value: formatTokens(cacheWriteTokens) }
      : undefined,
    knownMetric(uncachedTokens)
      ? { id: 'uncached', label: '未缓存', value: formatTokens(uncachedTokens) }
      : undefined,
    knownMetric(firstTokenMs)
      ? { id: 'time-to-first-token', label: '首 Token 耗时', value: formatMilliseconds(firstTokenMs) }
      : undefined,
    knownMetric(endToEndTokensPerSecond)
      ? { id: 'end-to-end-throughput', label: '端到端吞吐', value: formatSpeed(endToEndTokensPerSecond) }
      : undefined,
    knownMetric(durationMs)
      ? { id: 'total-duration', label: '端到端耗时', value: formatMilliseconds(durationMs) }
      : undefined
  ].filter((metric) => metric !== undefined)

  return (
    <div role="region" aria-label="生成统计" className="text-popover-foreground">
      <header className="flex min-w-0 items-center gap-2.5 p-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
          <Box size={16} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-foreground text-sm leading-5" title={model?.label}>
            {model?.label ?? '未知模型'}
          </div>
          {model?.model && (
            <div className="truncate text-muted-foreground text-xs leading-5" title={model.model}>
              {model.model}
            </div>
          )}
          {model?.providerName && (
            <div className="truncate text-muted-foreground text-xs leading-5" title={model.providerName}>
              {model.providerName}
            </div>
          )}
        </div>
        <div className="min-w-0 text-right text-xs text-muted-foreground">
          <div>本轮汇总</div>
          {completed && completedAtLabel && (
            <time dateTime={completed.toISOString()} className="block max-w-40 truncate" title={completedAtLabel}>
              结束于 {completedAtLabel}
            </time>
          )}
        </div>
      </header>

      <div className="space-y-3 border-t border-border p-3">
        <dl className="m-0 grid grid-cols-3 gap-2" data-testid="message-primary-metrics">
          <PrimaryMetric testId="message-metric-input" label="输入" value={optionalMetric(inputTokens, formatTokens)} />
          <PrimaryMetric testId="message-metric-output" label="输出" value={optionalMetric(outputTokens, formatTokens)} />
          <PrimaryMetric testId="message-metric-speed" label="模型生成速度" value={optionalMetric(modelTokensPerSecond, formatSpeed)} />
        </dl>
        {detailMetrics.length > 0 && (
          <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-2" data-testid="message-secondary-metrics">
            {detailMetrics.map((metric) => <DetailMetric key={metric.id} label={metric.label} value={metric.value} />)}
          </dl>
        )}
      </div>
    </div>
  )
}

export default MessageTokenDetailsCard
