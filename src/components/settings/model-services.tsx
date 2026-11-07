// Adapted from Cherry Studio ProviderSettings, fixed revision f19aa72 (AGPL-3.0).
import { useCallback, useEffect, useId, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { usePaneDivider } from '../ui/pane-divider'
import * as ContextMenu from '@radix-ui/react-context-menu'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ArrowLeft, Eye, EyeOff, Filter, Inbox, MoreVertical, Pencil, Plus, RefreshCw, Search, Trash2, UserPen, X } from 'lucide-react'
import type { Provider, ProviderInput, SettingsApi, SettingsModel, SettingsSnapshot } from '../../shared/settings-contract'
import { presetAccountId } from '../../shared/settings-contract'
import { cherryProviderPresets, type CherryProviderPreset } from '../../vendor/cherry-providers'
import { changePresetProtocol, PresetDetail, PresetLinks, ProviderAvatar, presetAccounts } from './provider-presets'
import { defaultModelProtocol, modelProtocols } from '../../shared/model-protocol'
import { errorText, isModelBusy, Modal, Switch, type LeaveGuard, type RegisterGuard } from './common'
import { ProtocolSelect, ProviderForm, providerErrors } from './provider-form'
import { ModelEditor, modelInput } from './model-editor'
import { ProviderAccount, unconfiguredAccount } from './chatgpt-account'
import { getSubscriptionId } from '../../shared/chatgpt-plan'
import { ModelPicker } from './model-picker'
import { ProviderSettingsDrawer } from './cherry-primitives'
import { useAutoSave } from './use-auto-save'

export const providerInput = (provider: Provider): ProviderInput => ({ id: provider.id, name: provider.name, baseUrl: provider.baseUrl, protocol: provider.protocol ?? defaultModelProtocol, enabled: provider.enabled, ...(provider.image ? { image: provider.image } : {}), ...(provider.avatarId ? { avatarId: provider.avatarId } : {}), ...(provider.endpointUrls ? { endpointUrls: provider.endpointUrls } : {}), ...(provider.notes === undefined ? {} : { notes: provider.notes }) })
type Props = { api: SettingsApi; snapshot: SettingsSnapshot; setSnapshot: Dispatch<SetStateAction<SettingsSnapshot | null>>; onChanged: () => void; registerGuard: RegisterGuard; onBusy: (busy: boolean) => void }

function ProviderListItem({ provider, selected, onSelect, onEdit, onNotes, onDelete }: { provider: Provider; selected: boolean; onSelect: () => void; onEdit: () => void; onNotes: () => void; onDelete: () => void }) {
  const openingPointerUp = useRef(false), openingTimer = useRef<number | null>(null), openingListener = useRef<(() => void) | null>(null)
  function clearOpeningPointerUp() { openingPointerUp.current = false; openingListener.current?.(); openingListener.current = null; if (openingTimer.current !== null) window.clearTimeout(openingTimer.current); openingTimer.current = null }
  useEffect(() => clearOpeningPointerUp, [])
  const items = [{ id: 'edit', label: '编辑', Icon: Pencil, action: onEdit }, { id: 'notes', label: '备注', Icon: UserPen, action: onNotes }, { id: 'delete', label: '删除', Icon: Trash2, action: onDelete }]
  if (getSubscriptionId(provider.id)) return <button type="button" className={`ms-provider ${selected ? 'is-selected' : ''}`} aria-label={provider.name} aria-pressed={selected} onClick={onSelect}>
    <ProviderAvatar name={provider.name} preset={presetAccounts.get(provider.id)} /><span className="ms-provider-copy"><strong>{provider.name}</strong></span>
    {provider.enabled && <span className="cherry-enabled-dot" aria-label="已启用" />}
  </button>
  return <ContextMenu.Root onOpenChange={open => { if (!open) clearOpeningPointerUp() }}><ContextMenu.Trigger asChild onContextMenu={() => {
    clearOpeningPointerUp(); openingPointerUp.current = true
    window.addEventListener('pointerup', clearOpeningPointerUp, { once: true }); openingListener.current = () => window.removeEventListener('pointerup', clearOpeningPointerUp)
    openingTimer.current = window.setTimeout(clearOpeningPointerUp, 1000)
  }}><div role="button" tabIndex={0} title={provider.notes || provider.name} aria-label={provider.name} aria-pressed={selected} className={`ms-provider ${selected ? 'is-selected' : ''}`} onClick={onSelect} onKeyDown={event => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect() } }}>
    <ProviderAvatar name={provider.name} image={provider.image} avatarId={provider.avatarId} preset={presetAccounts.get(provider.id)} />
    <span className="ms-provider-copy"><strong>{provider.name}</strong></span>{provider.enabled && <span className="cherry-enabled-dot" aria-label="已启用" />}
    <DropdownMenu.Root><DropdownMenu.Trigger asChild><button type="button" className="ms-icon cherry-provider-more" aria-label={`${provider.name}更多操作`} onClick={event => event.stopPropagation()}><MoreVertical size={14} /></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="cherry-context-menu" sideOffset={4} align="end">{items.map(({ id, label, Icon, action }) => <DropdownMenu.Item key={id} className="cherry-menu-item" data-destructive={id === 'delete'} onSelect={action}><Icon size={14} />{label}</DropdownMenu.Item>)}</DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
  </div></ContextMenu.Trigger><ContextMenu.Portal><ContextMenu.Content className="cherry-context-menu" onPointerUpCapture={event => {
    const opening = openingPointerUp.current; clearOpeningPointerUp()
    if (event.button === 2 || opening) { event.preventDefault(); event.stopPropagation() }
  }}>{items.map(({ id, label, Icon, action }) => <ContextMenu.Item key={id} className="cherry-menu-item" data-destructive={id === 'delete'} onSelect={action}><Icon size={14} />{label}</ContextMenu.Item>)}</ContextMenu.Content></ContextMenu.Portal></ContextMenu.Root>
}

function ProviderEditor({ api, provider, preset, onClose, onSaved }: { api: SettingsApi; provider?: Provider; preset?: CherryProviderPreset; onClose: () => void; onSaved: (value: Provider) => void }) {
  const [draft, setDraft] = useState<ProviderInput>(() => provider ? providerInput(provider) : {
    name: preset?.name ?? '', baseUrl: preset?.baseUrl ?? '', protocol: preset?.protocol ?? defaultModelProtocol,
    enabled: true, ...(preset && { presetId: preset.id }),
  })
  const [errors, setErrors] = useState<Record<string, string>>({}), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const id = useId()
  async function submit() { const validation = providerErrors(draft); setErrors(validation); if (Object.keys(validation).length) return; setBusy(true); setError(''); try { onSaved(await api.saveProvider(draft)); onClose() } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) } }
  function changeDraft(next: ProviderInput) {
    setDraft(next)
    if (Object.keys(errors).length) setErrors(providerErrors(next))
  }
  const title = provider ? '编辑服务商' : preset ? '配置服务商' : '添加自定义服务商'
  const footer = <><button className="ms-button" disabled={busy} onClick={onClose}>取消</button>
    <button className="ms-button ms-primary" disabled={busy} type="submit" form={id}>{busy ? '保存中…' : '保存'}</button></>
  const form = <form id={id} className="ms-form" noValidate onSubmit={event => { event.preventDefault(); void submit() }}>
    <ProviderForm draft={draft} provider={provider} preset={preset ?? (provider && presetAccounts.get(provider.id))} errors={errors} busy={busy} onChange={changeDraft} />
    {error && <p className="ms-error" role="alert">{error}</p>}</form>
  if (!provider && !preset) return <Modal title={title} onClose={onClose} busy={busy} className="custom-provider-dialog">
    <div className="ms-modal-body">{form}</div><footer className="ms-modal-footer">{footer}</footer></Modal>
  return <ProviderSettingsDrawer title={title} busy={busy} onClose={onClose} footer={footer}>{form}</ProviderSettingsDrawer>
}

function ProviderNotes({ api, provider, onSaved, onClose }: { api: SettingsApi; provider: Provider; onSaved: (value: Provider) => void; onClose: () => void }) {
  const [notes, setNotes] = useState(provider.notes ?? ''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  return <Modal title="备注" onClose={onClose} busy={busy}><div className="ms-modal-body"><textarea className="cherry-notes" aria-label="服务商备注" maxLength={10000} value={notes} onChange={event => setNotes(event.target.value)} />{error && <p className="ms-error" role="alert">{error}</p>}</div><footer className="ms-modal-footer"><button className="ms-button" disabled={busy} onClick={onClose}>取消</button><button className="ms-button ms-primary" disabled={busy} onClick={() => { setBusy(true); setError(''); void api.saveProvider({ ...providerInput(provider), notes }).then(value => { onSaved(value); onClose() }).catch(cause => setError(errorText(cause))).finally(() => setBusy(false)) }}>保存</button></footer></Modal>
}

export function ModelServices({ api, snapshot, setSnapshot, onChanged, registerGuard, onBusy }: Props) {
  const listPane = usePaneDivider('providers')
  const configuredAccounts = [...snapshot.providers].sort((a, b) => Number(presetAccounts.has(a.id)) - Number(presetAccounts.has(b.id)))
  const [selectedId, setSelectedId] = useState(configuredAccounts[0]?.id ?? presetAccountId(cherryProviderPresets[0].id)), [showDetail, setShowDetail] = useState(false), [query, setQuery] = useState(''), [filter, setFilter] = useState('all')
  const [editor, setEditor] = useState<Provider | 'new' | 'preset' | null>(null), [notes, setNotes] = useState<Provider | null>(null), [removal, setRemoval] = useState<Provider | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [stopRequired, setStopRequired] = useState(false)
  const detailGuard = useRef<LeaveGuard | null>(null), filterId = useId()
  const selectedAccount = getSubscriptionId(selectedId)
  const provider = snapshot.providers.find(item => item.id === selectedId) ?? (selectedAccount ? unconfiguredAccount(selectedAccount) : undefined)
  async function refreshAccount(isCurrent: () => boolean) {
    const next = await api.get()
    if (!isCurrent()) return
    setSnapshot(current => current && {
      ...current,
      providers: [...current.providers.filter(item => item.id !== selectedId), ...next.providers.filter(item => item.id === selectedId)],
      models: [...current.models.filter(item => item.providerId !== selectedId), ...next.models.filter(item => item.providerId === selectedId)],
    })
    onChanged()
  }
  function navigate(action: () => void) { if (busy) return; if (detailGuard.current) detailGuard.current(action); else action() }
  useEffect(() => { registerGuard(navigate); return () => registerGuard(null) })
  useEffect(() => { onBusy(busy); return () => onBusy(false) }, [busy, onBusy])
  function savedProvider(saved: Provider) { setSnapshot(current => current && { ...current, providers: current.providers.some(item => item.id === saved.id) ? current.providers.map(item => item.id === saved.id ? saved : item) : [...current.providers, saved] }); onChanged() }
  const selectedPreset = presetAccounts.get(selectedId)
  const configuredIds = new Set(snapshot.providers.map(item => item.id))
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean)
  const visiblePresets = (filter === 'all' || filter === 'unconfigured' ? cherryProviderPresets : []).filter(preset => {
    if (configuredIds.has(presetAccountId(preset.id))) return false
    const searchable = [preset.id, preset.name, preset.sourceName].join(' ').toLowerCase()
    return keywords.every(word => searchable.includes(word))
  })
  const filtered = configuredAccounts.filter(item => {
    if (filter !== 'all' && (filter === 'unconfigured' || item.enabled !== (filter === 'enabled'))) return false
    if (!keywords.length) return true
    const preset = presetAccounts.get(item.id)
    const names = snapshot.models.filter(model => model.providerId === item.id).map(model => model.label + ' ' + model.model)
    const searchable = [item.id, item.name, item.notes, preset?.name, preset?.sourceName, ...names].join(' ').toLowerCase()
    return keywords.every(word => searchable.includes(word))
  })
  async function remove() {
    if (!removal) return
    setBusy(true); setError('')
    try {
      if (stopRequired) await api.stopModelTasks(snapshot.models.filter(model => model.providerId === removal.id).map(model => model.id))
      await api.removeProvider(removal.id)
      setSnapshot(current => current && { ...current, providers: current.providers.filter(item => item.id !== removal.id), models: current.models.filter(model => model.providerId !== removal.id) })
      if (selectedId === removal.id) setSelectedId(presetAccounts.has(removal.id) ? removal.id : snapshot.providers.find(item => item.id !== removal.id)?.id ?? presetAccountId(cherryProviderPresets[0].id))
      setRemoval(null); onChanged()
    } catch (cause) { setError(errorText(cause)); setStopRequired(isModelBusy(cause)) } finally { setBusy(false) }
  }
  return <div style={listPane.style} className={`ms-workspace cherry-settings ${listPane.dragging ? 'pane-resizing' : ''} ${showDetail ? 'ms-show-detail' : ''}`}>
    <aside className="ms-provider-list" aria-label="服务商列表"><div className="ms-list-heading"><h2>服务商</h2><DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="ms-icon" aria-label="筛选服务商"><Filter size={14} /></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="cherry-context-menu" sideOffset={4}><DropdownMenu.RadioGroup value={filter} onValueChange={setFilter}>{[{ id: 'all', label: '全部' }, { id: 'enabled', label: '已启用' }, { id: 'disabled', label: '已停用' }, { id: 'unconfigured', label: '未配置' }].map(item => <DropdownMenu.RadioItem className="cherry-menu-item" key={item.id} value={item.id}>{item.label}</DropdownMenu.RadioItem>)}</DropdownMenu.RadioGroup></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root></div>
      <div className="ms-search"><Search size={14} /><input aria-label="搜索服务商" placeholder="搜索服务商或模型" value={query} onChange={event => setQuery(event.target.value)} />{query && <button className="ms-icon" aria-label="清空服务商搜索" onClick={() => setQuery('')}><X size={14} /></button>}</div>
      <div className="ms-provider-results" id={filterId}>{filtered.map(item => <ProviderListItem key={item.id} provider={item} selected={item.id === selectedId} onSelect={() => navigate(() => { setSelectedId(item.id); setShowDetail(true) })} onEdit={() => navigate(() => setEditor(item))} onNotes={() => navigate(() => setNotes(item))} onDelete={() => navigate(() => { setRemoval(item); setError(''); setStopRequired(false) })} />)}{visiblePresets.map(preset => {
        const id = presetAccountId(preset.id)
        return <button type="button" key={id} aria-pressed={id === selectedId} className={`ms-provider ${id === selectedId ? 'is-selected' : ''}`}
          onClick={() => navigate(() => { setSelectedId(id); setShowDetail(true) })}>
          <ProviderAvatar name={preset.name} preset={preset} /><span className="ms-provider-copy"><strong>{preset.name}</strong></span>
        </button>
      })}{!filtered.length && !visiblePresets.length && <p className="ms-list-empty">未找到服务商</p>}</div>
      <button className="ms-button ms-add-provider" disabled={busy} onClick={() => navigate(() => setEditor('new'))}><Plus size={14} />添加服务商</button>
      {listPane.divider}
    </aside>
    {provider ? <ProviderDetail key={`${provider.id}:${editor ? 'editing' : 'detail'}`} api={api} provider={provider} refreshAccount={refreshAccount} models={snapshot.models.filter(model => model.providerId === provider.id)} savedProvider={savedProvider} savedModels={models => { setSnapshot(current => current && { ...current, models: [...current.models.filter(model => !models.some(saved => saved.id === model.id)), ...models] }); onChanged() }} removedModels={ids => { setSnapshot(current => current && { ...current, models: current.models.filter(model => !ids.includes(model.id)) }); onChanged() }} onBusy={onBusy} registerGuard={guard => { detailGuard.current = guard }} onBack={() => setShowDetail(false)} /> : selectedPreset ? <PresetDetail preset={selectedPreset} onConfigure={() => setEditor('preset')} onBack={() => setShowDetail(false)} /> : <section className="ms-detail ms-empty ms-empty-detail"><p className="ms-hint">添加服务商以配置模型。</p></section>}
    {editor && <ProviderEditor api={api} provider={typeof editor === 'object' ? editor : undefined} preset={editor === 'preset' ? selectedPreset : undefined} onClose={() => setEditor(null)} onSaved={value => { savedProvider(value); setSelectedId(value.id); setShowDetail(true) }} />}
    {notes && <ProviderNotes api={api} provider={notes} onSaved={savedProvider} onClose={() => setNotes(null)} />}
    {removal && <Modal title="删除服务商" busy={busy} onClose={() => setRemoval(null)}><div className="ms-modal-body"><p>删除 {removal.name} 及其模型配置？</p><p className="ms-hint">已有分析报告和对话记录会保留。</p>{error && <p role="alert" className="ms-error">{error}</p>}</div><footer className="ms-modal-footer"><button className="ms-button" disabled={busy} onClick={() => setRemoval(null)}>取消</button><button className="ms-button ms-primary" disabled={busy} onClick={() => void remove()}>{stopRequired ? '停止任务并重试' : '确认删除'}</button></footer></Modal>}
  </div>
}

function ProviderDetail({ api, provider, refreshAccount, models, savedProvider, savedModels, removedModels, registerGuard, onBusy, onBack }: { api: SettingsApi; provider: Provider; refreshAccount: (isCurrent: () => boolean) => Promise<void>; models: SettingsModel[]; savedProvider: (value: Provider) => void; savedModels: (value: SettingsModel[]) => void; removedModels: (ids: string[]) => void; registerGuard: RegisterGuard; onBusy: (value: boolean) => void; onBack: () => void }) {
  const subscriptionId = getSubscriptionId(provider.id)
  const [account, setAccount] = useState<{ state: 'disconnected' | 'pending' | 'connected' | 'unknown'; id?: string }>({ state: 'unknown' })
  const accountState = account.state
  const boundAccount = accountState === 'connected' && account.id && account.id === provider.planAccount ? account.id : undefined
  const accountUnavailable = !!subscriptionId && (!provider.enabled || !boundAccount)
  const visibleModels = subscriptionId ? boundAccount ? models.filter(model => model.planAccount === boundAccount) : [] : models
  const owner = subscriptionId ? boundAccount : provider.id
  const scope = useMemo(() => ({}), [owner])
  const currentScope = useRef(scope), mounted = useRef(true)
  currentScope.current = scope
  const isCurrent = useCallback(() => mounted.current && currentScope.current === scope, [scope])
  const [draft, setDraft] = useState(() => providerInput(provider)), latest = useRef(draft); latest.current = draft
  const saved = useRef(providerInput(provider)), [showKey, setShowKey] = useState(false), [errors, setErrors] = useState<Record<string, string>>({}), [error, setError] = useState('')
  const [picker, setPicker] = useState(false), [editor, setEditor] = useState<SettingsModel | 'new' | null>(null), [busy, setBusy] = useState(false), [stopRequired, setStopRequired] = useState(false)
  const modelSearch = useRef<HTMLInputElement>(null)
  const [detections, setDetections] = useState<Record<string, string>>({}), [modelQuery, setModelQuery] = useState('')
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { setPicker(false); setEditor(null); setBusy(false); setError(''); setDetections({}); setModelQuery('') }, [scope])
  const modelBusy = useCallback((value: boolean) => { if (isCurrent()) setBusy(value) }, [isCurrent])
  const id = useId()
  const saver = useAutoSave<ProviderInput>(async input => {
    try {
      const result = await api.saveProvider(input); saved.current = providerInput(result); savedProvider(result); setStopRequired(false)
      if (JSON.stringify(latest.current) === JSON.stringify(input)) { latest.current = saved.current; setDraft(saved.current) }
      setDetections({})
    } catch (cause) { setStopRequired(isModelBusy(cause)); throw cause }
  })
  useEffect(() => {
    const next = providerInput(provider)
    if (JSON.stringify(latest.current) === JSON.stringify(saved.current)) { latest.current = next; setDraft(next) }
    saved.current = next
  }, [provider])
  const preset = presetAccounts.get(provider.id)
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved.current)
  async function commit(next = latest.current) {
    const validation = providerErrors(next); setErrors(validation); if (Object.keys(validation).length) return false
    if (JSON.stringify(next) === JSON.stringify(saved.current)) return saver.flush()
    setPicker(false)
    return saver.save(next)
  }
  function navigate(action: () => void) { if (busy) return; void commit().then(ok => { if (ok) action() }) }
  useEffect(() => { registerGuard(navigate); return () => registerGuard(null) })
  useEffect(() => { onBusy(busy); return () => onBusy(false) }, [busy, onBusy])
  async function test(model: SettingsModel) { if (accountUnavailable || !await commit() || !isCurrent()) return; setBusy(true); setError(''); setDetections(current => ({ ...current, [model.id]: '检测中…' })); try { await api.testModel(model.id); if (isCurrent()) setDetections(current => ({ ...current, [model.id]: '连接成功' })) } catch (cause) { if (isCurrent()) { setDetections(current => ({ ...current, [model.id]: '检测失败' })); setError(errorText(cause, '检测失败，请检查配置后重试。')) } } finally { modelBusy(false) } }
  async function toggle(model: SettingsModel) { if (accountUnavailable) return; setBusy(true); setError(''); try { const saved = await api.saveModel({ ...modelInput(model), enabled: !model.enabled }); if (isCurrent()) savedModels([saved]) } catch (cause) { if (isCurrent()) setError(errorText(cause)) } finally { modelBusy(false) } }
  const filtered = visibleModels.filter(model => `${model.label} ${model.model}`.toLowerCase().includes(modelQuery.toLowerCase()))
  const groups = [...new Set(filtered.map(model => model.group || '模型'))]
  return <section className="ms-detail" aria-label="服务商配置"><div className="ms-detail-body"><button className="ms-mobile-back ms-text-button" onClick={() => navigate(onBack)}><ArrowLeft size={14} />返回服务商</button>
    {subscriptionId ? <ProviderAccount id={subscriptionId} api={api} provider={provider} refresh={refreshAccount} onConnection={(state, id) => setAccount({ state, id })} /> : <>
    <div className="ms-detail-header"><div className="ms-detail-title">{(provider.image || provider.avatarId || preset) && <ProviderAvatar name={provider.name} image={provider.image} avatarId={provider.avatarId} preset={preset} />}<h2>{provider.name}</h2></div><Switch label="启用服务商" checked={draft.enabled} disabled={busy || saver.pending} onChange={() => { const next = { ...draft, enabled: !draft.enabled }; setDraft(next); void commit(next) }} /></div>
    {preset && <PresetLinks preset={preset} />}
    <p className="ms-data-note">使用云模型时，数据会发送给所配置的模型服务商。</p>
    <div className="ms-form ms-connection"><div className="ms-field"><label htmlFor={`${id}-protocol`}>连接协议</label><ProtocolSelect id={`${id}-protocol`} value={draft.protocol} choices={draft.endpointUrls ? modelProtocols.filter(type => draft.endpointUrls?.[type]) : undefined} disabled={busy || saver.pending} onChange={protocol => { const next = changePresetProtocol(draft, protocol, preset); setDraft(next); void commit(next) }} /></div>
      <div className="ms-field"><label htmlFor={`${id}-key`}>{provider.hasCredential ? '替换密钥' : '密钥'}</label><div className="settings-key"><input id={`${id}-key`} type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={draft.apiKey ?? ''} placeholder={provider.hasCredential ? '已保存密钥' : '输入密钥'} onChange={event => { setDraft(current => ({ ...current, apiKey: event.target.value || undefined })); setPicker(false) }} onBlur={() => { void commit() }} /><button className="ms-icon" type="button" aria-label={showKey ? '隐藏输入的密钥' : '显示输入的密钥'} onClick={() => setShowKey(value => !value)}>{showKey ? <EyeOff size={14} /> : <Eye size={14} />}</button></div>{provider.hasCredential && <button className="ms-text-button settings-fit" disabled={saver.pending} onClick={() => { const next = { ...draft, apiKey: null }; setDraft(next); void commit(next) }}>清除密钥</button>}</div>
      <div className="ms-field"><label htmlFor={`${id}-address`}>接口地址</label><input id={`${id}-address`} value={draft.baseUrl} type="url" aria-invalid={!!errors.baseUrl} onChange={event => { setDraft(current => ({ ...current, baseUrl: event.target.value, ...(current.endpointUrls && { endpointUrls: { ...current.endpointUrls, [current.protocol ?? defaultModelProtocol]: event.target.value } }) })); setPicker(false) }} onBlur={() => { void commit() }} />{errors.baseUrl && <p role="alert" className="ms-error">{errors.baseUrl}</p>}</div>
      {(saver.error || error) && <div role="alert"><p className="ms-error">{saver.error || error}</p>{saver.error && <button className="ms-button" disabled={saver.pending} onClick={() => { void (async () => { try { if (stopRequired) await api.stopModelTasks(models.map(model => model.id)); setError(''); await commit() } catch (cause) { setError(errorText(cause)) } })() }}>{stopRequired ? '停止任务并重试' : '重试保存'}</button>}</div>}
    </div>
    </>}
    <section className="ms-models"><div className="ms-models-heading"><h3>模型 <span>{visibleModels.length}</span></h3><div className="ms-model-actions"><button className="ms-text-button" disabled={busy || saver.pending || dirty || accountUnavailable} onClick={() => setEditor('new')}>手动添加</button><button className="ms-button" disabled={busy || saver.pending || dirty || accountUnavailable} onClick={() => setPicker(true)}><RefreshCw size={14} />同步模型</button><button className="ms-icon" aria-label="添加模型" title="添加模型" disabled={busy || saver.pending || dirty || accountUnavailable} onClick={() => setPicker(true)}><Plus size={14} /></button></div></div>
      {subscriptionId && error && <p className="ms-error" role="alert">{error}</p>}
      {!!visibleModels.length && <div className="ms-search"><Search size={14} /><input ref={modelSearch} aria-label="搜索已添加模型" placeholder="搜索模型" value={modelQuery} onChange={event => setModelQuery(event.target.value)} /></div>}
      {!visibleModels.length && (subscriptionId ? <div className="account-empty-models">
        <Inbox size={38} strokeWidth={1.25} aria-hidden="true" />
        <p>尚未添加模型</p><p>{accountState === 'unknown' ? '请先核对账户状态。' : accountState === 'pending' ? '授权完成后可同步模型。'
          : accountState === 'disconnected' ? '登录后可同步账户模型。' : !provider.enabled ? '启用服务商后可同步模型。' : '点击上方的“同步模型”添加模型。'}</p>
      </div> : <p className="ms-hint">添加模型或同步模型列表。</p>)}
      {!!visibleModels.length && !filtered.length && <div className="ms-filter-empty"><Search size={22} aria-hidden="true" /><p>没有匹配的已添加模型</p><button type="button" className="ms-text-button" onClick={() => { setModelQuery(''); modelSearch.current?.focus() }}>清除模型搜索</button></div>}
      {groups.map(group => <div className="cherry-model-group" key={group}><h4>{group}</h4>{filtered.filter(model => (model.group || '模型') === group).map(model => <div className="ms-model-row" key={model.id}><button className="cherry-model-name" title={`${model.label} · ${model.model}`} disabled={busy || saver.pending || accountUnavailable} onClick={() => setEditor(model)}><strong>{model.label}</strong>{model.label !== model.model && <span>{model.model}</span>}</button><div className="settings-model-actions"><span className="cherry-health" role="status">{detections[model.id]}</span><button className="ms-icon" aria-label={`检测${model.label}`} title="检测连接" disabled={busy || saver.pending || !provider.enabled || !model.enabled || accountUnavailable} onClick={() => void test(model)}><RefreshCw size={14} /></button><button className="ms-icon" aria-label={`编辑${model.label}`} disabled={busy || saver.pending || accountUnavailable} onClick={() => setEditor(model)}><Pencil size={14} /></button><Switch label={`启用${model.label}`} checked={model.enabled} disabled={busy || saver.pending || accountUnavailable} onChange={() => void toggle(model)} /></div></div>)}</div>)}
    </section>
    </div>
    {picker && !accountUnavailable && <ModelPicker api={api} provider={provider} models={visibleModels} onClose={() => { if (isCurrent()) setPicker(false) }} onAdded={values => { if (isCurrent()) savedModels(values) }} onRemoved={ids => { if (isCurrent()) removedModels(ids) }} onBusy={modelBusy} />}
    {editor && !accountUnavailable && <ModelEditor api={api} provider={provider} models={visibleModels} existing={editor === 'new' ? undefined : editor} onClose={() => { if (isCurrent()) setEditor(null) }} onSaved={value => { if (isCurrent()) savedModels([value]) }} />}
  </section>
}
