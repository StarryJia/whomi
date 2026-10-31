// Adapted from Cherry Studio ModelDrawer/ModelContextWindowFields.tsx (AGPL-3.0).
import { useId } from 'react'

const CONTEXT_WINDOW_PRESETS = [{ label: '128K', value: 128000 }, { label: '200K', value: 200000 }, { label: '256K', value: 262144 }, { label: '400K', value: 400000 }, { label: '512K', value: 524288 }, { label: '1M', value: 1000000 }] as const
const MAX_INPUT_TOKEN_PRESETS = [{ label: '128K', value: 128000 }, { label: '200K', value: 200000 }, { label: '256K', value: 256000 }, { label: '512K', value: 512000 }, { label: '1M', value: 1000000 }] as const
const MAX_OUTPUT_TOKEN_PRESETS = [{ label: '16K', value: 16384 }, { label: '32K', value: 32768 }, { label: '64K', value: 65536 }, { label: '128K', value: 128000 }, { label: '256K', value: 256000 }] as const
export type CapacityField = 'contextWindow' | 'maxTokens' | 'maxInputTokens'
export function capacityErrors(contextWindow: number | null, maxTokens: number | null, maxInputTokens?: number | null): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const [field, value] of Object.entries({ contextWindow, maxTokens, maxInputTokens })) if (value != null && (!Number.isSafeInteger(value) || value < 1 || value > 2000000)) errors[field] = '请输入 1～2000000 的整数，或清空长度。'
  if (contextWindow != null && maxTokens != null && maxTokens >= contextWindow) errors.maxTokens = '请将最大输出长度设为小于上下文长度。'
  if (contextWindow != null && maxInputTokens != null && maxInputTokens > contextWindow) errors.maxInputTokens = '请将最大输入长度设为不超过上下文长度。'
  return errors
}
export function ModelParameters({ contextWindow, maxTokens, maxInputTokens = null, onChange, onCommit, errors, busy }: { contextWindow: number | null; maxTokens: number | null; maxInputTokens?: number | null; onChange: (field: CapacityField, value: number | null) => void; onCommit?: (field: CapacityField, value: number | null) => void; errors: Record<string, string>; busy: boolean; multiple?: boolean }) {
  const prefix = useId()
  return <div className="cherry-capacity-fields">{([{ field: 'contextWindow', title: '上下文长度', value: contextWindow, presets: CONTEXT_WINDOW_PRESETS }, { field: 'maxInputTokens', title: '最大输入长度', value: maxInputTokens, presets: MAX_INPUT_TOKEN_PRESETS }, { field: 'maxTokens', title: '最大输出长度', value: maxTokens, presets: MAX_OUTPUT_TOKEN_PRESETS }] as const).map(({ field, title, value, presets }) => {
    const settle = (next: number | null) => { onChange(field, next); onCommit?.(field, next) }
    return <div className="ms-field" key={field}><label htmlFor={`${prefix}-${field}`}>{title}</label><div className="cherry-presets" role="group" aria-label={`${title} 快捷预设`}>{presets.map(preset => <button type="button" className="cherry-preset" key={preset.value} disabled={busy} title={String(preset.value)} aria-label={`${title}: ${preset.label} (${preset.value})`} aria-pressed={value === preset.value} onClick={() => settle(preset.value)}>{preset.label}</button>)}</div>
      <input id={`${prefix}-${field}`} aria-label={title} type="number" min={1} max={2000000} step={1} value={value == null || Number.isNaN(value) ? '' : value} placeholder="未设置" disabled={busy} aria-invalid={!!errors[field]} aria-describedby={errors[field] ? `${prefix}-${field}-error` : undefined} onChange={event => onChange(field, event.target.value === '' ? null : event.target.valueAsNumber)} onBlur={event => settle(event.target.value === '' ? null : event.target.valueAsNumber)} />{errors[field] && <p id={`${prefix}-${field}-error`} className="ms-error" role="alert">{errors[field]}</p>}
    </div>
  })}</div>
}
