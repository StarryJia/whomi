import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { ArrowLeft, Check, Pencil, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react'
import type { Provider, ProviderInput, SettingsApi, SettingsModel, SettingsSnapshot } from '../../shared/settings-contract'
import { errorText, isModelBusy, LeaveDialog, Modal, Switch, type RegisterGuard } from './common'
import { ProviderForm, providerErrors } from './provider-form'
import { ModelEditor } from './model-editor'
import { ModelPicker } from './model-picker'

const toDraft = (provider?: Provider): ProviderInput => provider ? { id: provider.id, name: provider.name, baseUrl: provider.baseUrl, enabled: provider.enabled, ...(provider.image ? { image: provider.image } : {}) } : { name: '', baseUrl: '', enabled: true }
type Removal = { kind: 'provider' | 'model'; id: string; name: string }

export function ModelServices({ api, snapshot, setSnapshot, onChanged, registerGuard, onBusy }: { api: SettingsApi; snapshot: SettingsSnapshot; setSnapshot: Dispatch<SetStateAction<SettingsSnapshot | null>>; onChanged: () => void; registerGuard: RegisterGuard; onBusy: (busy: boolean) => void }) {
  const [selectedId, setSelectedId] = useState(snapshot.providers[0]?.id ?? '')
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState(() => toDraft(snapshot.providers[0]))
  const [query, setQuery] = useState('')
  const [showDetail, setShowDetail] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState('')
  const [stopRequired, setStopRequired] = useState(false)
  const [pending, setPending] = useState<{ action: () => void } | null>(null)
  const [picker, setPicker] = useState(false)
  const [editor, setEditor] = useState<SettingsModel | 'new' | null>(null)
  const [removal, setRemoval] = useState<Removal | null>(null)
  const [detections, setDetections] = useState<Record<string, string>>({})
  const form = useRef<HTMLFormElement>(null)
  const workspace = useRef<HTMLDivElement>(null)
  const provider = snapshot.providers.find(item => item.id === selectedId)
  const dirty = (adding || !!provider) && JSON.stringify(toDraft(adding ? undefined : provider)) !== JSON.stringify(draft)
  const models = snapshot.models.filter(model => model.providerId === provider?.id)
  const filtered = snapshot.providers.filter(item => item.name.toLowerCase().includes(query.trim().toLowerCase()))
  function requestLeave(action: () => void) { if (busy) return; if (dirty) setPending({ action }); else action() }
  useEffect(() => { registerGuard(requestLeave); return () => registerGuard(null) })
  useEffect(() => { onBusy(busy); return () => onBusy(false) }, [busy, onBusy])
  function resetFeedback() { setError(''); setErrors({}); setNotice(''); setStopRequired(false) }
  function select(next?: Provider) {
    requestLeave(() => {
      setSelectedId(next?.id ?? ''); setAdding(!next); setDraft(toDraft(next)); setShowDetail(true); setPicker(false); resetFeedback()
      requestAnimationFrame(() => workspace.current?.querySelector<HTMLElement>('[data-ms-title]')?.focus())
    })
  }
  async function save(stop = false): Promise<boolean> {
    const validation = providerErrors(draft)
    setErrors(validation)
    if (Object.keys(validation).length) { setPending(null); requestAnimationFrame(() => form.current?.querySelector<HTMLInputElement>('[aria-invalid=true]')?.focus()); return false }
    setBusy(true); setError(''); setStopRequired(false)
    try {
      if (stop) await api.stopModelTasks(models.map(model => model.id))
      const saved = await api.saveProvider({ ...draft, name: draft.name.trim(), baseUrl: draft.baseUrl.trim() })
      setSnapshot(current => current && { ...current, providers: [...current.providers.filter(item => item.id !== saved.id), saved] })
      setSelectedId(saved.id); setDraft(toDraft(saved)); setAdding(false); setDetections({}); setNotice('服务商已保存。'); onChanged()
      return true
    } catch (cause) { setError(isModelBusy(cause) ? '请先停止使用此服务商的任务。' : errorText(cause)); setStopRequired(isModelBusy(cause)); setPending(null); return false }
    finally { setBusy(false) }
  }
  function modelSaved(saved: SettingsModel) { setSnapshot(current => current && { ...current, models: [...current.models.filter(item => item.id !== saved.id), saved] }); setDetections(current => { const next = { ...current }; delete next[saved.id]; return next }); setEditor(null); onChanged() }
  async function remove(stop = false) {
    if (!removal) return
    setBusy(true); setError(''); setStopRequired(false)
    try {
      if (stop) await api.stopModelTasks(removal.kind === 'provider' ? models.map(model => model.id) : [removal.id])
      if (removal.kind === 'provider') {
        await api.removeProvider(removal.id)
        const next = snapshot.providers.find(item => item.id !== removal.id)
        setSnapshot(current => current && { ...current, providers: current.providers.filter(item => item.id !== removal.id), models: current.models.filter(model => model.providerId !== removal.id) })
        setSelectedId(next?.id ?? ''); setDraft(toDraft(next)); setShowDetail(false)
      } else { await api.removeModel(removal.id); setSnapshot(current => current && { ...current, models: current.models.filter(model => model.id !== removal.id) }) }
      setRemoval(null); setNotice('已移除。'); onChanged()
    } catch (cause) { setError(isModelBusy(cause) ? '请先停止相关任务。' : errorText(cause)); setStopRequired(isModelBusy(cause)) }
    finally { setBusy(false) }
  }
  async function test(model: SettingsModel) {
    setBusy(true); setDetections(current => ({ ...current, [model.id]: '检测中…' })); setError('')
    try { await api.testModel(model.id); setDetections(current => ({ ...current, [model.id]: '连接成功' })) }
    catch (cause) { setDetections(current => ({ ...current, [model.id]: '检测失败' })); setError(errorText(cause, '连接失败，请检查地址、密钥和模型标识后重试。')) }
    finally { setBusy(false) }
  }
  return <div ref={workspace} className={`ms-workspace ${showDetail ? 'ms-show-detail' : ''} ${!snapshot.providers.length && !adding ? 'ms-workspace-empty' : ''}`}>
    {!snapshot.providers.length && !adding ? <div className="ms-empty ms-empty-workspace"><h2 tabIndex={-1}>模型服务</h2><p>添加服务商，配置本地或云端模型。</p><button className="ms-button ms-primary" onClick={() => select()}><Plus size={17} />添加服务商</button></div> : <>
      <aside className="ms-provider-list" aria-label="服务商列表"><div className="ms-list-heading"><h2 tabIndex={-1}>服务商</h2><button className="ms-icon" aria-label="添加自定义服务商" disabled={busy} onClick={() => select()}><Plus size={19} /></button></div>
        <div className="ms-search"><Search size={17} aria-hidden="true" /><input aria-label="搜索服务商" placeholder="搜索服务商" value={query} onChange={event => setQuery(event.target.value)} />{query && <button className="ms-icon" aria-label="清空服务商搜索" onClick={() => setQuery('')}><X size={16} /></button>}</div>
        <div className="ms-provider-results">{filtered.map(item => <button key={item.id} title={item.name} className={`ms-provider ${item.id === selectedId ? 'is-selected' : ''}`} aria-pressed={item.id === selectedId} disabled={busy} onClick={() => select(item)}>{item.image && <img className="ms-provider-image" src={item.image} alt="" />}<span className="ms-provider-copy"><strong>{item.name}</strong><span>{item.enabled ? '已启用' : '已停用'}</span></span>{item.id === selectedId && <Check size={16} className="ms-selected-mark" />}</button>)}{!filtered.length && <div className="ms-list-empty"><p>{query ? '未找到服务商' : '尚未添加服务商'}</p>{query && <button className="ms-text-button" onClick={() => setQuery('')}>清空搜索</button>}</div>}</div>
        <button className="ms-button ms-add-provider" disabled={busy} onClick={() => select()}><Plus size={16} />添加自定义服务商</button></aside>
      <section className="ms-detail" aria-label="服务商配置">{provider || adding ? <>
        <button className="ms-mobile-back ms-text-button" onClick={() => requestLeave(() => { setDraft(toDraft(provider)); setAdding(false); setShowDetail(false); requestAnimationFrame(() => workspace.current?.querySelector<HTMLElement>('.ms-provider.is-selected')?.focus()) })}><ArrowLeft size={16} />返回服务商</button>
        <div className="ms-detail-header"><div className="ms-detail-title">{draft.image && <img className="ms-provider-image" src={draft.image} alt="" />}<h2 tabIndex={-1} data-ms-title>{adding ? '添加服务商' : provider?.name}</h2></div><Switch label="启用服务商" checked={draft.enabled} disabled={busy} onChange={() => { setDraft(current => ({ ...current, enabled: !current.enabled })); setPicker(false); resetFeedback() }} /></div>
        <p className="ms-data-note">使用云模型时，数据会发送给所配置的模型服务商。</p>
        <form ref={form} noValidate onSubmit={event => { event.preventDefault(); void save() }}><ProviderForm key={adding ? 'new' : provider?.id} draft={draft} provider={adding ? undefined : provider} errors={errors} busy={busy} onChange={next => { setDraft(next); setPicker(false); resetFeedback() }} />
          {error && !removal && <div role="alert"><p className="ms-error">{error}</p>{stopRequired && <button type="button" className="ms-button" disabled={busy} onClick={() => void save(true)}>停止任务并重试</button>}</div>}
          <div className="settings-save-row"><span className="mp-visually-hidden" role="status">{notice}</span><button type="submit" className="ms-button ms-primary" disabled={busy || (!dirty && !adding)}>{busy ? '处理中…' : '保存服务商'}</button></div>
        </form>
        {!adding && provider && <section className="ms-models"><div className="ms-models-heading"><div><h3>模型 <span>{models.length}</span></h3><p className="ms-hint">检测连接会发送一条简短测试内容。</p></div><div className="ms-model-actions"><button className="ms-button" disabled={dirty || busy} onClick={() => setEditor('new')}><Plus size={16} />手动添加</button><button className="ms-button ms-primary" disabled={dirty || busy} onClick={() => setPicker(true)}><RefreshCw size={16} />同步模型</button></div></div>
          {dirty && <p className="ms-hint">保存服务商后可管理模型。</p>}
          {picker && <ModelPicker key={provider.id} api={api} provider={provider} models={snapshot.models} onBusy={setBusy} onClose={() => { setPicker(false); requestAnimationFrame(() => workspace.current?.querySelector<HTMLButtonElement>('.ms-model-actions button:last-child')?.focus()) }} onAdded={added => { setSnapshot(current => current && { ...current, models: [...current.models.filter(model => !added.some(item => item.id === model.id)), ...added] }); onChanged() }} />}
          {!picker && !models.length && <p className="ms-hint">尚未添加模型，可同步列表或手动添加。</p>}
          {!picker && models.map(model => <div className="ms-model-row" key={model.id}><div className="ms-model-description"><strong>{model.label}</strong><span>{provider.name} · {model.model}</span><span role="status">{!model.enabled || !provider.enabled ? '已停用' : detections[model.id] || '未检测'}</span></div><div className="settings-model-actions"><button className="ms-text-button" disabled={busy || dirty || !model.enabled || !provider.enabled} onClick={() => void test(model)}>{detections[model.id] === '检测失败' ? '重试检测' : '检测连接'}</button><button className="ms-icon" aria-label={`编辑${model.label}`} disabled={busy || dirty} onClick={() => setEditor(model)}><Pencil size={17} /></button><button className="ms-icon" aria-label={`移除${model.label}`} disabled={busy || dirty} onClick={() => { resetFeedback(); setRemoval({ kind: 'model', id: model.id, name: model.label }) }}><Trash2 size={17} /></button></div></div>)}
          <div className="settings-provider-remove"><button className="ms-text-button" disabled={busy} onClick={() => requestLeave(() => { setDraft(toDraft(provider)); resetFeedback(); setRemoval({ kind: 'provider', id: provider.id, name: provider.name }) })}>移除服务商</button></div>
        </section>}
      </> : <div className="ms-empty"><p>选择服务商以查看配置。</p></div>}</section>
    </>}
    {pending && <LeaveDialog busy={busy} error={error} onContinue={() => setPending(null)} onDiscard={() => { const action = pending.action; setDraft(toDraft(provider)); setPending(null); action() }} onSave={() => { const action = pending.action; void save().then(saved => { if (saved) { setPending(null); action() } }) }} />}
    {editor && provider && <ModelEditor api={api} provider={provider} models={snapshot.models} existing={editor === 'new' ? undefined : editor} onClose={() => setEditor(null)} onSaved={modelSaved} />}
    {removal && <Modal title={`移除${removal.kind === 'provider' ? '服务商' : '模型'}`} onClose={() => { setRemoval(null); resetFeedback() }} busy={busy}><div className="ms-modal-body"><p>移除 {removal.name}？</p><p className="ms-hint">已有分析报告和对话记录会保留。</p>{error && <p className="ms-error" role="alert">{error}</p>}</div><footer className="ms-modal-footer"><button className="ms-button" disabled={busy} onClick={() => { setRemoval(null); resetFeedback() }}>取消</button><button className="ms-button ms-primary" disabled={busy} onClick={() => void remove(stopRequired)}>{busy ? '处理中…' : stopRequired ? '停止任务并重试' : '确认移除'}</button></footer></Modal>}
  </div>
}
