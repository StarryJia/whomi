import { useLayoutEffect, useRef, useState } from 'react'
import type { AnalysisTask, ResumeAnalysisModel } from '../../shared/ai-contract'
import { ModelSelector, ThinkingSelector, type ModelOption, type ThinkingLevel } from '../conversation-ai/model-selector'
import './insight-resume-model.css'

export function InsightResumeModel({ task, models, busy, onCancel, onContinue }: {
  task: AnalysisTask
  models: readonly ModelOption[]
  busy: boolean
  onCancel: () => void
  onContinue: (replacement: ResumeAnalysisModel) => void
}) {
  const [modelId, setModelId] = useState(() => models.find(model => model.id === task.modelId)?.id ?? models[0]?.id ?? '')
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | undefined>(task.thinkingLevel)
  const form = useRef<HTMLFormElement>(null)
  const selected = models.find(model => model.id === modelId)
  const levels = selected?.insightThinkingLevels ?? selected?.thinkingLevels
  const thinking = thinkingLevel && levels?.includes(thinkingLevel) ? thinkingLevel : undefined
  useLayoutEffect(() => { form.current?.querySelector<HTMLButtonElement>('[role=combobox]')?.focus() }, [])
  return <form ref={form} className="insight-resume-model" aria-label="更换模型并继续" aria-busy={busy}
    onSubmit={event => { event.preventDefault(); if (selected && !busy) onContinue({ modelId, ...(thinking && { thinkingLevel: thinking }) }) }}
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); if (!busy) onCancel() } }}>
    <div className="insight-resume-options">
      <ModelSelector label="接续模型" models={models} value={modelId} disabled={busy || !models.length}
        onSelect={id => { setModelId(id); setThinkingLevel(undefined) }} />
      {levels?.length ? <ThinkingSelector levels={levels} value={thinking} onSelect={setThinkingLevel} disabled={busy} /> : null}
      {selected?.providerName && <span className="insight-resume-provider">{selected.providerName}</span>}
    </div>
    <p className="analysis-notice">继续分析所需的聊天内容将发送至所选模型服务。</p>
    {!models.length && <p>请先在设置中添加可用模型。</p>}
    <div className="insight-resume-actions">
      <button type="button" className="analysis-secondary" disabled={busy} onClick={onCancel}>取消</button>
      <button type="submit" className="analysis-primary" disabled={busy || !selected}>{busy ? '正在继续…' : '确认并继续'}</button>
    </div>
  </form>
}
