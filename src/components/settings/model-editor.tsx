// Adapted from Cherry Studio ModelDrawer/EditModelDrawer.tsx and AddModelFormPanel.tsx (AGPL-3.0).
import { useId, useRef, useState } from 'react'
import type { Provider, SettingsApi, SettingsModel, SettingsModelInput } from '../../shared/settings-contract'
import { errorText, isModelBusy, Switch } from './common'
import { ProviderSettingsDrawer } from './cherry-primitives'
import { capacityErrors, ModelParameters, type CapacityField } from './model-parameters'
import { useAutoSave } from './use-auto-save'
import { getDefaultGroupName } from './cherry-model-naming'

export const modelInput = (value: SettingsModel): SettingsModelInput => ({ id: value.id, providerId: value.providerId, label: value.label, model: value.model, contextWindow: value.contextWindow, maxTokens: value.maxTokens, enabled: value.enabled, ...(value.group === undefined ? {} : { group: value.group }), ...(value.maxInputTokens === undefined ? {} : { maxInputTokens: value.maxInputTokens }) })

export function ModelEditor({ api, provider, models, existing, onClose, onSaved }: { api: SettingsApi; provider: Provider; models: SettingsModel[]; existing?: SettingsModel; onClose: () => void; onSaved: (model: SettingsModel) => void }) {
  const initial: SettingsModelInput = existing ? modelInput(existing) : { providerId: provider.id, label: '', model: '', contextWindow: null, maxTokens: null, maxInputTokens: null, enabled: true, group: '' }
  const [draft, setDraft] = useState(initial), latest = useRef(draft); latest.current = draft
  const savedInput = useRef(initial)
  const [errors, setErrors] = useState<Record<string, string>>({}), [localError, setLocalError] = useState(''), [stopRequired, setStopRequired] = useState(false)
  const [showMore, setShowMore] = useState(true)
  const form = useRef<HTMLFormElement>(null), prefix = useId()
  const saver = useAutoSave<SettingsModelInput>(async input => {
    try { const saved = await api.saveModel(input); savedInput.current = input; setStopRequired(false); onSaved(saved) }
    catch (cause) { setStopRequired(isModelBusy(cause)); throw cause }
  })
  function validate(next: SettingsModelInput) {
    const validation = capacityErrors(next.contextWindow, next.maxTokens, next.maxInputTokens)
    if (!next.model.trim()) validation.model = '请输入模型标识。'
    if (!next.label.trim()) validation.label = '请输入显示名称。'
    if (models.some(model => model.providerId === provider.id && model.model === next.model.trim() && model.id !== existing?.id)) validation.model = '该模型已添加，请修改已有模型。'
    setErrors(validation)
    return !Object.keys(validation).length
  }
  async function commit(next = latest.current) {
    if (!validate(next)) return false
    if (existing && JSON.stringify(next) === JSON.stringify(savedInput.current)) return saver.flush()
    return saver.save({ ...next, model: next.model.trim(), label: next.label.trim() })
  }
  async function close() {
    if (!existing) { if (!saver.pending) onClose(); return }
    if (await commit()) onClose()
  }
  function changeCapacity(field: CapacityField, value: number | null, commitNow = false) {
    const next = { ...latest.current, [field]: value }; latest.current = next; setDraft(next)
    if (commitNow && existing) void commit(next)
  }
  return <ProviderSettingsDrawer title={existing ? '编辑模型' : '手动添加模型'} onClose={() => void close()} busy={saver.pending} footer={!existing ? <><button type="button" className="ms-button" disabled={saver.pending} onClick={onClose}>取消</button><button type="submit" form={`${prefix}-form`} className="ms-button ms-primary" disabled={saver.pending}>添加模型</button></> : undefined}>
    <form id={`${prefix}-form`} ref={form} className="ms-form" noValidate onSubmit={event => { event.preventDefault(); void commit().then(ok => { if (ok && !existing) onClose() }) }}>
      {([{ field: 'model', title: '模型标识' }, { field: 'label', title: '显示名称' }, { field: 'group', title: '分组' }] as const).map(({ field, title }) => <div className="ms-field" key={field}><label htmlFor={`${prefix}-${field}`}>{title}</label><input id={`${prefix}-${field}`} value={draft[field] ?? ''} disabled={field === 'model' && !!existing} onChange={event => { const value = event.target.value; setDraft(current => field === 'model' ? { ...current, model: value, label: value, group: getDefaultGroupName(value, provider.id) } : { ...current, [field]: value }) }} onBlur={() => { if (existing) void commit() }} aria-invalid={!!errors[field]} />{errors[field] && <p className="ms-error" role="alert">{errors[field]}</p>}</div>)}
      <button className="ms-text-button" type="button" aria-expanded={showMore} onClick={() => setShowMore(value => !value)}>更多设置</button>
      {showMore && <ModelParameters contextWindow={draft.contextWindow} maxTokens={draft.maxTokens} maxInputTokens={draft.maxInputTokens} errors={errors} busy={false} onChange={(field, value) => changeCapacity(field, value)} onCommit={(field, value) => changeCapacity(field, value, true)} />}
      <div className="settings-row"><span>启用模型</span><Switch label="启用模型" checked={draft.enabled} disabled={saver.pending} onChange={() => { const next = { ...draft, enabled: !draft.enabled }; setDraft(next); if (existing) void commit(next) }} /></div>
      {(saver.error || localError) && <div role="alert"><p className="ms-error">{saver.error || localError}</p><button type="button" className="ms-button" disabled={saver.pending} onClick={() => { void (async () => { try { if (stopRequired && existing) await api.stopModelTasks([existing.id]); setLocalError(''); await commit() } catch (cause) { setLocalError(errorText(cause)) } })() }}>{stopRequired ? '停止任务并重试' : '重试保存'}</button></div>}
    </form>
  </ProviderSettingsDrawer>
}
