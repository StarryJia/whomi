import { useId } from 'react'
import { isInsightScope, type InsightScope } from '../../shared/conversation-insights'
import { formatInsightDate, formatInsightRange } from './insight-task'

const localTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

export function dateScope(start?: number | null, end?: number | null): Extract<InsightScope, { kind: 'dates' }> {
  const timezone = localTimezone()
  return {
    kind: 'dates', timezone,
    startDate: start == null ? '' : formatInsightDate(start, timezone).replaceAll('.', '-'),
    endDate: end == null ? '' : formatInsightDate(end, timezone).replaceAll('.', '-'),
  }
}

export function InsightScopeFields({ value, onChange, count, start, end, loading, available }: {
  value: InsightScope
  onChange: (scope: InsightScope) => void
  count?: number
  start?: number | null
  end?: number | null
  loading?: boolean
  available: boolean
}) {
  const id = useId()
  const reversed = value.kind === 'dates' && !!value.startDate && !!value.endDate && value.startDate > value.endDate
  return <fieldset className="insight-scope">
    <legend>范围</legend>
    <div className="insight-scope-options">
      <label><input type="radio" name={id} checked={value.kind === 'all'} onChange={() => onChange({ kind: 'all' })} /><span>全部记录</span></label>
      <label><input type="radio" name={id} checked={value.kind === 'dates'} onChange={() => onChange(dateScope(start, end))} /><span>日期范围</span></label>
    </div>
    {value.kind === 'dates' ? <div className="insight-date-inputs">
      <label>开始日期<input type="date" value={value.startDate} onChange={event => onChange({ ...value, startDate: event.currentTarget.value })}
        aria-invalid={reversed || undefined} aria-describedby={reversed ? id + '-dates' : undefined} /></label>
      <label>结束日期<input type="date" value={value.endDate} onChange={event => onChange({ ...value, endDate: event.currentTarget.value })}
        aria-invalid={reversed || undefined} aria-describedby={reversed ? id + '-dates' : undefined} /></label>
    </div> : start != null && end != null && <p className="analysis-description">{formatInsightRange(start, end)}</p>}
    {reversed && <p role="alert" id={id + '-dates'} className="conversation-error">开始日期不能晚于结束日期，请调整。</p>}
    {!reversed && isInsightScope(value) && <div aria-busy={loading}>
      {count !== undefined && <p className="analysis-description">{count.toLocaleString('zh-CN')} 条消息</p>}
      {count === 0 && available && <p className="analysis-description">此范围没有消息，请调整日期。</p>}
    </div>}
  </fieldset>
}
