// Adapted from Cherry Studio ModelDrawer/EditModelDrawer.tsx and AddModelFormPanel.tsx (AGPL-3.0).
import { useId, useRef, useState } from 'react'
import type { Provider, SettingsApi, SettingsModel, SettingsModelInput, SettingsModelWrite } from '../../shared/settings-contract'
import { errorText, isModelBusy, Switch } from './common'
import { ProviderSettingsDrawer } from './cherry-primitives'
import { ExceptionNotice } from '../ui/exception-notices'
import { capacityErrors, ModelParameters, type CapacityField } from './model-parameters'
import { useAutoSave } from './use-auto-save'
import { getDefaultGroupName } from './cherry-model-naming'

export const modelInput = (value: SettingsModel): SettingsModelInput => ({ id: value.id, providerId: value.providerId, label: value.label, model: value.model, contextWindow: value.contextWindow, maxTokens: value.maxTokens, enabled: value.enabled, ...(value.group === undefined ? {} : { group: value.group }), maxInputTokens: value.maxInputTokens ?? null })
type ModelEdits = Partial<Pick<SettingsModelInput, 'model' | 'label' | 'group' | 'enabled' | CapacityField>>
type FieldEdits = Map<keyof ModelEdits, { value: ModelEdits[keyof ModelEdits] }>

function applyEdits(base: SettingsModelInput, edits: FieldEdits): SettingsModelInput {
  return { ...base, ...Object.fromEntries(Array.from(edits, ([field, edit]) => [field, edit.value])) }
}

export function modelChanges(input: SettingsModelInput, previous: SettingsModelInput): SettingsModelWrite {
  const update: SettingsModelWrite = { ...input }
  if (input.model === previous.model) {
    for (const field of ['contextWindow', 'maxTokens', 'maxInputTokens'] as const) {
      if (input[field] === previous[field]) delete update[field]
    }
  }
  return update
}

export function ModelEditor({ api, provider, models, existing, onClose, onSaved }: { api: SettingsApi; provider: Provider; models: SettingsModel[]; existing?: SettingsModel; onClose: () => void; onSaved: (model: SettingsModel) => void }) {
  const initial: SettingsModelInput = existing ? modelInput(existing) : { providerId: provider.id, label: '', model: '', contextWindow: null, maxTokens: null, maxInputTokens: null, enabled: true, group: '' }
  const savedInput = useRef(initial), observedModel = useRef(existing)
  if (observedModel.current !== existing) { observedModel.current = existing; savedInput.current = initial }
  const [edits, setEdits] = useState<FieldEdits>(() => new Map()), latestEdits = useRef(edits)
  const acknowledged = useRef<FieldEdits>(new Map())
  const draft = applyEdits(savedInput.current, edits)
  const [errors, setErrors] = useState<Record<string, string>>({}), [localError, setLocalError] = useState(''), [stopRequired, setStopRequired] = useState(false)
  const [showMore, setShowMore] = useState(true)
  const form = useRef<HTMLFormElement>(null), prefix = useId()
  const saver = useAutoSave<FieldEdits>(async patch => {
    const previous = savedInput.current
    // 连续失焦会排队保存；前一回执已经确认的字段不能再次覆盖目录更新。
    const pending = new Map([...patch].filter(([field, edit]) => acknowledged.current.get(field) !== edit))
    const input = applyEdits(previous, pending)
    input.model = input.model.trim()
    input.label = input.label.trim()
    try {
      if (!existing || [...pending.keys()].some(field => input[field] !== previous[field])) {
        const saved = await api.saveModel(existing ? modelChanges(input, previous) : input)
        if (saved.version >= (observedModel.current?.version ?? 0)) {
          savedInput.current = modelInput(saved)
          onSaved(saved)
        }
      }
      const remaining = new Map(latestEdits.current)
      for (const [field, edit] of pending) {
        acknowledged.current.set(field, edit)
        if (remaining.get(field) === edit) remaining.delete(field)
      }
      latestEdits.current = remaining
      setEdits(remaining)
      setStopRequired(false)
    }
    catch (cause) { setStopRequired(isModelBusy(cause)); throw cause }
  })
  function change(patch: ModelEdits) {
    const next = new Map(latestEdits.current)
    for (const field of Object.keys(patch) as (keyof ModelEdits)[]) next.set(field, { value: patch[field] })
    latestEdits.current = next
    setEdits(next)
  }
  function validate(next: SettingsModelInput) {
    const validation = capacityErrors(next.contextWindow, next.maxTokens, next.maxInputTokens)
    if (!next.model.trim()) validation.model = '请输入模型标识。'
    if (!next.label.trim()) validation.label = '请输入显示名称。'
    if (models.some(model => model.providerId === provider.id && model.model === next.model.trim() && model.id !== existing?.id)) validation.model = '该模型已添加，请修改已有模型。'
    setErrors(validation)
    return !Object.keys(validation).length
  }
  async function commit() {
    const next = applyEdits(savedInput.current, latestEdits.current)
    if (!validate(next)) return false
    if (existing && !latestEdits.current.size) return saver.flush()
    return saver.save(latestEdits.current)
  }
  async function close() {
    if (!existing) { if (!saver.pending) onClose(); return }
    if (saver.pending && !await saver.flush()) return
    if (await commit()) onClose()
  }
  function changeCapacity(field: CapacityField, value: number | null, commitNow = false) {
    if (draft[field] !== value) change({ [field]: value })
    if (commitNow && existing) void commit()
  }
  return <ProviderSettingsDrawer title={existing ? '编辑模型' : '手动添加模型'} onClose={() => void close()} busy={!existing && saver.pending} footer={!existing ? <><button type="button" className="ms-button" disabled={saver.pending} onClick={onClose}>取消</button><button type="submit" form={`${prefix}-form`} className="ms-button ms-primary" disabled={saver.pending}>添加模型</button></> : undefined}>
    <form id={`${prefix}-form`} ref={form} className="ms-form" noValidate onSubmit={event => { event.preventDefault(); void commit().then(ok => { if (ok && !existing) onClose() }) }}>
      {([{ field: 'model', title: '模型标识' }, { field: 'label', title: '显示名称' }, { field: 'group', title: '分组' }] as const).map(({ field, title }) => <div className="ms-field" key={field}><label htmlFor={`${prefix}-${field}`}>{title}</label><input id={`${prefix}-${field}`} value={draft[field] ?? ''} disabled={field === 'model' && !!existing} onChange={event => { const value = event.target.value; change(field === 'model' ? { model: value, label: value, group: getDefaultGroupName(value, provider.id) } : { [field]: value }) }} onBlur={() => { if (existing) void commit() }} aria-invalid={!!errors[field]} />{errors[field] && <p className="ms-error" role="alert">{errors[field]}</p>}</div>)}
      <button className="ms-text-button" type="button" aria-expanded={showMore} onClick={() => setShowMore(value => !value)}>更多设置</button>
      {showMore && <ModelParameters contextWindow={draft.contextWindow} maxTokens={draft.maxTokens} maxInputTokens={draft.maxInputTokens} errors={errors} busy={false} onChange={(field, value) => changeCapacity(field, value)} onCommit={(field, value) => changeCapacity(field, value, true)} />}
      <div className="settings-row"><span>启用模型</span><Switch label="启用模型" checked={draft.enabled} disabled={saver.pending} onChange={() => { change({ enabled: !draft.enabled }); if (existing) void commit() }} /></div>
      {(saver.error || localError) && <div><ExceptionNotice title="无法保存模型" detail={saver.error || localError} className="ms-error" /><button type="button" className="ms-button" disabled={saver.pending} onClick={() => { void (async () => { try { if (stopRequired && existing) await api.stopModelTasks([existing.id]); setLocalError(''); await commit() } catch (cause) { setLocalError(errorText(cause)) } })() }}>{stopRequired ? '停止任务并重试' : '重试保存'}</button></div>}
    </form>
  </ProviderSettingsDrawer>
}
