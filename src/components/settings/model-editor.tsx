import { useId, useRef, useState } from 'react'
import type { Provider, SettingsApi, SettingsModel, SettingsModelInput } from '../../shared/settings-contract'
import { errorText, isModelBusy, LeaveDialog, Modal, Switch } from './common'
import { capacityErrors, ModelParameters } from './model-parameters'

export function ModelEditor({ api, provider, models, existing, onClose, onSaved }: { api: SettingsApi; provider: Provider; models: SettingsModel[]; existing?: SettingsModel; onClose: () => void; onSaved: (model: SettingsModel) => void }) {
  const initial: SettingsModelInput = existing ? { id: existing.id, providerId: provider.id, label: existing.label, model: existing.model, contextWindow: existing.contextWindow, maxTokens: existing.maxTokens, enabled: existing.enabled } : { providerId: provider.id, label: '', model: '', contextWindow: Number.NaN, maxTokens: Number.NaN, enabled: true }
  const [draft, setDraft] = useState(initial)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [stopRequired, setStopRequired] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const form = useRef<HTMLFormElement>(null)
  const prefix = useId()
  const dirty = JSON.stringify(initial) !== JSON.stringify(draft)
  function close() { if (busy) return; if (dirty) setLeaving(true); else onClose() }
  async function save(stop = false) {
    const nextErrors = capacityErrors(draft.contextWindow, draft.maxTokens)
    if (!draft.model.trim()) nextErrors.model = '请输入模型标识。'
    else if (models.some(model => model.providerId === provider.id && model.model === draft.model.trim() && model.id !== existing?.id)) nextErrors.model = '此服务商已添加该模型，请使用不同标识。'
    if (!draft.label.trim()) nextErrors.label = '请输入显示名称。'
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) { setLeaving(false); requestAnimationFrame(() => form.current?.querySelector<HTMLInputElement>('[aria-invalid=true]')?.focus()); return }
    setBusy(true); setError(''); setStopRequired(false)
    try {
      if (stop && existing) await api.stopModelTasks([existing.id])
      const saved = await api.saveModel({ ...draft, model: draft.model.trim(), label: draft.label.trim() })
      onSaved(saved)
    } catch (cause) { setError(isModelBusy(cause) ? '请先停止使用此模型的任务。' : errorText(cause)); setStopRequired(isModelBusy(cause)); setLeaving(false) }
    finally { setBusy(false) }
  }
  return <><Modal title={existing ? '编辑模型' : '手动添加模型'} onClose={close} busy={busy}><form ref={form} onSubmit={event => { event.preventDefault(); void save() }} noValidate>
    <div className="ms-modal-body ms-form"><p className="ms-hint">{provider.name}</p>{([{ field: 'model', title: '模型标识' }, { field: 'label', title: '显示名称' }] as const).map(({ field, title }) => <div className="ms-field" key={field}><label htmlFor={`${prefix}-${field}`}>{title}</label><input id={`${prefix}-${field}`} value={draft[field]} disabled={busy} onChange={event => setDraft(current => ({ ...current, [field]: event.target.value }))} aria-invalid={!!errors[field]} aria-describedby={errors[field] ? `${prefix}-${field}-error` : undefined} />{errors[field] && <p id={`${prefix}-${field}-error`} className="ms-error" role="alert">{errors[field]}</p>}</div>)}
      <ModelParameters contextWindow={draft.contextWindow} maxTokens={draft.maxTokens} errors={errors} busy={busy} onChange={(field, value) => setDraft(current => ({ ...current, [field]: value }))} />
      <div className="settings-row"><span>启用模型</span><Switch label="启用模型" checked={draft.enabled} disabled={busy} onChange={() => setDraft(current => ({ ...current, enabled: !current.enabled }))} /></div>
      {error && <div role="alert"><p className="ms-error">{error}</p>{stopRequired && <button type="button" className="ms-button" disabled={busy} onClick={() => void save(true)}>停止任务并重试</button>}</div>}
    </div><footer className="ms-modal-footer"><button type="button" className="ms-button" disabled={busy} onClick={close}>取消</button><button type="submit" className="ms-button ms-primary" disabled={busy}>{busy ? '保存中…' : existing ? '保存模型' : '添加模型'}</button></footer>
  </form></Modal>{leaving && <LeaveDialog busy={busy} error={error} onSave={() => void save()} onDiscard={onClose} onContinue={() => setLeaving(false)} />}</>
}
