import { useEffect, useId, useState } from 'react'

export function capacityErrors(contextWindow: number, maxTokens: number): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 256 || contextWindow > 2000000) errors.contextWindow = '请输入 256～2000000 的整数。'
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 32 || maxTokens >= contextWindow) errors.maxTokens = '请输入至少 32 且小于上下文长度的整数。'
  return errors
}

export function ModelParameters({ contextWindow, maxTokens, onChange, errors, busy, multiple = false }: { contextWindow: number; maxTokens: number; onChange: (field: 'contextWindow' | 'maxTokens', value: number) => void; errors: Record<string, string>; busy: boolean; multiple?: boolean }) {
  const [open, setOpen] = useState(false)
  const prefix = useId()
  useEffect(() => { if (errors.contextWindow || errors.maxTokens) setOpen(true) }, [errors.contextWindow, errors.maxTokens])
  return <details className="settings-model-parameters" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>高级设置</summary>
    <p className="ms-hint">{multiple ? '按服务商说明填写，以下长度将应用到本次勾选的全部模型。' : '按服务商说明填写模型可接收和生成的词元数量。'}</p>
    <div className="ms-form-pair">{([{ field: 'contextWindow', title: '上下文长度', value: contextWindow }, { field: 'maxTokens', title: '最大输出长度', value: maxTokens }] as const).map(({ field, title, value }) => <div className="ms-field" key={field}><label htmlFor={`${prefix}-${field}`}>{title}</label><input id={`${prefix}-${field}`} type="number" required min={field === 'contextWindow' ? 256 : 32} max={field === 'contextWindow' ? 2000000 : contextWindow - 1} step={1} value={Number.isNaN(value) ? '' : value} disabled={busy} onChange={event => onChange(field, event.target.valueAsNumber)} aria-invalid={!!errors[field]} aria-describedby={errors[field] ? `${prefix}-${field}-error` : undefined} />{errors[field] && <p className="ms-error" id={`${prefix}-${field}-error`} role="alert">{errors[field]}</p>}</div>)}</div>
  </details>
}
