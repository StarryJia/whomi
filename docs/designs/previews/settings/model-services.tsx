import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Check, ChevronDown, Eye, EyeOff, LoaderCircle, Pencil, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react'
import './model-services.css'
import { keepDialogFocus } from './dialog-focus'

type Model = { id: string; name: string }
type Provider = { id: string; name: string; kind: 'cloud' | 'local'; protocol: string; address: string; key: string; enabled: boolean; image?: string; models: Model[] }
type Detection = 'idle' | 'checking' | 'success' | 'failure'
const CATALOG: Model[] = [{ id: 'demo-model-a', name: '示例模型 A' }, { id: 'demo-model-b', name: '示例模型 B' }, { id: 'demo-model-c', name: '示例模型 C · 较长名称的多语言对话演示模型' }]
const blankProvider = (): Provider => ({ id: '', name: '', kind: 'cloud', protocol: 'OpenAI 兼容', address: '', key: '', enabled: true, models: [] })
function fixtures(scenario: string): Provider[] {
  if (scenario === 'empty-providers') return []
  return [
    { id: 'demo-cloud', name: scenario === 'long' ? '示例云服务 · 用于检查窄窗口与服务商长名称的独立演示' : '示例云服务', kind: 'cloud', protocol: 'OpenAI 兼容', address: scenario === 'long' ? 'https://model.example.invalid/a-very-long-example-service-path/compatible/v1' : 'https://model.example.invalid/v1', key: 'DEMO_PLACEHOLDER_NOT_A_KEY', enabled: true, models: scenario === 'empty-models' ? [] : [CATALOG[0]] },
    { id: 'demo-local', name: '示例本地服务', kind: 'local', protocol: 'Ollama', address: 'http://127.0.0.1:11434', key: '', enabled: false, models: [CATALOG[0]] },
  ]
}
function addressError(address: string) {
  if (!address.trim()) return '请输入接口地址。'
  try { if (!['http:', 'https:'].includes(new URL(address).protocol)) return '请输入以 http:// 或 https:// 开头的地址。' } catch { return '请输入完整地址，例如 https://model.example.invalid/v1。' }
  return ''
}
function Modal({ title, children, onClose, className = '' }: { title: string; children: ReactNode; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = ref.current
    const opener = document.activeElement
    const fallback = [...(dialog?.closest('.ms-workspace')?.querySelectorAll<HTMLElement>('h2[tabindex]') ?? [])].find((element) => element.getClientRects().length > 0)
    dialog?.showModal()
    dialog?.querySelector<HTMLInputElement>('input:not([type=file]),select,textarea')?.focus()
    return () => { dialog?.close(); if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true }); else fallback?.focus({ preventScroll: true }) }
  }, [])
  return <dialog ref={ref} className={`ms-dialog ${className}`} aria-labelledby={titleId} onKeyDown={keepDialogFocus} onCancel={(event) => { event.preventDefault(); onClose() }}>
    <header className="ms-modal-header"><h2 id={titleId}>{title}</h2><button className="ms-icon" onClick={onClose} aria-label={`关闭${title}`}><X size={19} /></button></header>{children}
  </dialog>
}
function CheckBox({ checked, mixed = false, children, onChange, disabled = false }: { checked: boolean; mixed?: boolean; children: ReactNode; onChange: () => void; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed }, [mixed])
  return <label className={`ms-check ${disabled ? 'is-disabled' : ''}`}><input ref={ref} type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />{children}</label>
}
function ProviderDialog({ onClose, onAdd }: { onClose: () => void; onAdd: (provider: Provider) => void }) {
  const [draft, setDraft] = useState(blankProvider)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const prefix = useId()
  const change = (field: keyof Provider, value: string) => { setDraft((current) => ({ ...current, [field]: value })); setErrors((current) => ({ ...current, [field]: '' })) }
  function submit() {
    const nextErrors = { name: draft.name.trim() ? '' : '请输入服务商名称。', address: addressError(draft.address) }
    setErrors(nextErrors)
    const invalid = Object.entries(nextErrors).find(([, value]) => value)
    if (invalid) { document.getElementById(`${prefix}-${invalid[0]}`)?.focus(); return }
    onAdd({ ...draft, id: `custom-${Date.now()}`, name: draft.name.trim() })
  }
  function imageSelected(file?: File) {
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setErrors((current) => ({ ...current, image: '请选择 PNG、JPEG 或 WebP 图片。' })); return }
    const reader = new FileReader()
    reader.onload = () => { setDraft((current) => ({ ...current, image: String(reader.result) })); setErrors((current) => ({ ...current, image: '' })) }
    reader.onerror = () => setErrors((current) => ({ ...current, image: '图片读取失败，请重新选择。' }))
    reader.readAsDataURL(file)
  }
  return <Modal title="添加自定义服务商" onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); submit() }}>
    <div className="ms-modal-body ms-form">
      <p className="ms-hint">使用示例地址和密钥体验配置。</p>
      <div className="ms-field"><label htmlFor={`${prefix}-name`}>服务商名称</label><input id={`${prefix}-name`} autoFocus value={draft.name} onChange={(event) => change('name', event.target.value)} aria-invalid={!!errors.name} aria-describedby={errors.name ? `${prefix}-name-error` : undefined} placeholder="例如：我的示例服务" />{errors.name && <p className="ms-error" id={`${prefix}-name-error`}>{errors.name}</p>}</div>
      <div className="ms-form-pair"><div className="ms-field"><label htmlFor={`${prefix}-kind`}>服务位置</label><select id={`${prefix}-kind`} value={draft.kind} onChange={(event) => change('kind', event.target.value)}><option value="cloud">云服务</option><option value="local">本地服务</option></select></div><div className="ms-field"><label htmlFor={`${prefix}-protocol`}>连接协议</label><select id={`${prefix}-protocol`} value={draft.protocol} onChange={(event) => change('protocol', event.target.value)}><option>OpenAI 兼容</option><option>Ollama</option><option>Anthropic</option></select></div></div>
      <div className="ms-field"><label htmlFor={`${prefix}-address`}>接口地址</label><input id={`${prefix}-address`} value={draft.address} onChange={(event) => change('address', event.target.value)} aria-invalid={!!errors.address} aria-describedby={errors.address ? `${prefix}-address-error` : undefined} placeholder={draft.kind === 'local' ? 'http://127.0.0.1:11434' : 'https://model.example.invalid/v1'} />{errors.address && <p className="ms-error" id={`${prefix}-address-error`}>{errors.address}</p>}</div>
      <div className="ms-field"><label htmlFor={`${prefix}-key`}>密钥{draft.kind === 'local' && <span className="ms-optional">可选</span>}</label><input id={`${prefix}-key`} type="password" value={draft.key} onChange={(event) => change('key', event.target.value)} autoComplete="off" placeholder="仅填写示例密钥" /><p className="ms-hint">{draft.kind === 'local' ? '本地服务未设置认证时可留空。' : '数据会发送给所配置的模型服务商。'}</p></div>
      <div className="ms-field"><label htmlFor={`${prefix}-image`}>服务商图片<span className="ms-optional">可选</span></label><div className="ms-image-picker">{draft.image && <img className="ms-provider-image" src={draft.image} alt="已选服务商图片" />}<input id={`${prefix}-image`} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => imageSelected(event.target.files?.[0])} />{draft.image && <button type="button" className="ms-text-button" onClick={() => setDraft((current) => ({ ...current, image: undefined }))}>移除图片</button>}</div><p className="ms-hint">选择 PNG、JPEG 或 WebP 图片，仅在本次演示中显示。</p>{errors.image && <p className="ms-error">{errors.image}</p>}</div>
    </div><footer className="ms-modal-footer"><button type="button" className="ms-button" onClick={onClose}>取消</button><button type="submit" className="ms-button ms-primary">添加服务商</button></footer>
  </form></Modal>
}
function ModelPicker({ provider, onClose, onAdd }: { provider: Provider; onClose: () => void; onAdd: (models: Model[]) => void }) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const added = new Set(provider.models.map((model) => model.id))
  const filtered = CATALOG.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(query.trim().toLowerCase()))
  const available = filtered.filter((model) => !added.has(model.id))
  const count = available.filter((model) => selected.includes(model.id)).length
  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  function toggleAll() { const ids = available.map((model) => model.id); setSelected((current) => count === available.length ? current.filter((id) => !ids.includes(id)) : [...new Set([...current, ...ids])]) }
  return <Modal title="选择模型" onClose={onClose} className="ms-model-picker"><div className="ms-picker-top"><p className="ms-hint ms-provider-subtitle">{provider.name} · 演示模型目录</p><div className="ms-search"><Search size={17} /><input autoFocus aria-label="搜索模型" placeholder="搜索模型名称或标识" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button className="ms-icon" aria-label="清空模型搜索" onClick={() => setQuery('')}><X size={16} /></button>}</div><div className="ms-picker-summary"><CheckBox checked={available.length > 0 && count === available.length} mixed={count > 0 && count < available.length} disabled={!available.length} onChange={toggleAll}>全选当前结果</CheckBox><span>已选 {selected.length} 项</span></div></div>
    <div className="ms-picker-results">{filtered.length ? filtered.map((model) => <div className="ms-model-option" key={model.id}><CheckBox checked={added.has(model.id) || selected.includes(model.id)} disabled={added.has(model.id)} onChange={() => toggle(model.id)}><span className="ms-model-description"><strong>{model.name}</strong><span>{provider.name} · {model.id}</span></span></CheckBox>{added.has(model.id) && <span className="ms-added">已添加</span>}</div>) : <div className="ms-empty"><p>未找到匹配的模型</p><button className="ms-text-button" onClick={() => setQuery('')}>清空搜索</button></div>}</div>
    <footer className="ms-modal-footer"><span className="ms-footer-note" role="status">演示目录，不发送请求</span><button className="ms-button" onClick={onClose}>取消</button><button className="ms-button ms-primary" disabled={!selected.length} onClick={() => onAdd(CATALOG.filter((model) => selected.includes(model.id)))}>添加所选模型{selected.length > 0 ? ` (${selected.length})` : ''}</button></footer>
  </Modal>
}
function ModelEditor({ provider, existing, onClose, onApply }: { provider: Provider; existing?: Model; onClose: () => void; onApply: (model: Model) => void }) {
  const [draft, setDraft] = useState<Model>(existing ?? { id: '', name: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const prefix = useId()
  function apply() {
    const nextErrors = { id: !draft.id.trim() ? '请输入模型标识。' : provider.models.some((model) => model.id === draft.id.trim() && model.id !== existing?.id) ? '此服务商已添加该模型，请使用不同标识。' : '', name: draft.name.trim() ? '' : '请输入显示名称。' }
    setErrors(nextErrors)
    const invalid = Object.entries(nextErrors).find(([, value]) => value)
    if (invalid) { document.getElementById(`${prefix}-${invalid[0]}`)?.focus(); return }
    onApply({ id: draft.id.trim(), name: draft.name.trim() })
  }
  return <Modal title={existing ? '编辑模型' : '手动添加模型'} onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); apply() }}><div className="ms-modal-body ms-form"><p className="ms-hint ms-provider-subtitle">{provider.name}</p>{([{ field: 'id', title: '模型标识', placeholder: '例如：demo-model-d' }, { field: 'name', title: '显示名称', placeholder: '例如：示例模型 D' }] as const).map(({ field, title, placeholder }) => <div className="ms-field" key={field}><label htmlFor={`${prefix}-${field}`}>{title}</label><input id={`${prefix}-${field}`} autoFocus={field === 'id'} value={draft[field]} placeholder={placeholder} onChange={(event) => { setDraft((current) => ({ ...current, [field]: event.target.value })); setErrors((current) => ({ ...current, [field]: '' })) }} aria-invalid={!!errors[field]} aria-describedby={errors[field] ? `${prefix}-${field}-error` : undefined} />{errors[field] && <p className="ms-error" id={`${prefix}-${field}-error`}>{errors[field]}</p>}</div>)}</div><footer className="ms-modal-footer"><button type="button" className="ms-button" onClick={onClose}>取消</button><button type="submit" className="ms-button ms-primary">{existing ? '应用修改' : '添加模型'}</button></footer></form></Modal>
}
export function ModelServices({ scenario }: { scenario: string }) {
  const [providers, setProviders] = useState(() => fixtures(scenario))
  const [selectedId, setSelectedId] = useState(() => fixtures(scenario)[0]?.id)
  const [query, setQuery] = useState('')
  const [showDetail, setShowDetail] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [detection, setDetection] = useState<Detection>('idle')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [modal, setModal] = useState<'provider' | 'picker' | 'add-model' | null>(null)
  const [editing, setEditing] = useState<Model | null>(null)
  const [removing, setRemoving] = useState<Model | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const workspace = useRef<HTMLDivElement>(null)
  const prefix = useId()
  const provider = providers.find((item) => item.id === selectedId)
  const filtered = providers.filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase()))
  const detectionLabel = detection === 'idle' ? '未检测' : detection === 'checking' ? '检测中 · 演示' : detection === 'success' ? '连接成功 · 演示' : '连接失败 · 演示'
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  function resetDetection() { if (timer.current) clearTimeout(timer.current); setDetection('idle'); setError('') }
  function change(field: keyof Provider, value: string | boolean) { setProviders((current) => current.map((item) => item.id === selectedId ? { ...item, [field]: value } : item)); resetDetection(); setNotice('') }
  function select(id: string) {
    setSelectedId(id); setShowDetail(true); setShowKey(false); resetDetection(); setNotice('')
    requestAnimationFrame(() => workspace.current?.querySelector<HTMLElement>('[data-ms-title]')?.focus())
  }
  function returnToProviders() {
    setShowDetail(false)
    requestAnimationFrame(() => workspace.current?.querySelector<HTMLElement>('.ms-provider.is-selected')?.focus())
  }
  function updateModels(models: Model[]) { setProviders((current) => current.map((item) => item.id === selectedId ? { ...item, models } : item)) }
  function checkConnection() {
    if (!provider) return
    const validation = addressError(provider.address)
    setError(validation)
    if (validation) { document.getElementById(`${prefix}-address`)?.focus(); return }
    setDetection('checking')
    timer.current = setTimeout(() => setDetection(scenario === 'failure' ? 'failure' : 'success'), 750)
  }
  if (!providers.length) {
    return <div ref={workspace} className="ms-workspace ms-workspace-empty">
      <div className="ms-empty ms-empty-workspace">
        <h2 tabIndex={-1}>模型服务</h2>
        <p>尚未添加模型服务商。添加服务商后即可配置与同步模型。</p>
        <button className="ms-button ms-primary" onClick={() => setModal('provider')}>
          <Plus size={17} />添加服务商
        </button>
      </div>
      {modal === 'provider' && <ProviderDialog onClose={() => setModal(null)} onAdd={(item) => { setProviders([item]); select(item.id); setQuery(''); setModal(null); setNotice('已添加服务商 · 仅本次演示') }} />}
    </div>
  }

  return <div ref={workspace} className={`ms-workspace ${showDetail ? 'ms-show-detail' : ''}`}>
    <aside className="ms-provider-list" aria-label="服务商列表"><div className="ms-list-heading"><h2 tabIndex={-1}>服务商</h2><button className="ms-icon" aria-label="添加自定义服务商" onClick={() => setModal('provider')}><Plus size={19} /></button></div><div className="ms-search"><Search size={17} /><input aria-label="搜索服务商" placeholder="搜索服务商" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button className="ms-icon" aria-label="清空服务商搜索" onClick={() => setQuery('')}><X size={15} /></button>}</div><div className="ms-provider-results">{filtered.map((item) => <button key={item.id} title={item.name} className={`ms-provider ${item.id === selectedId ? 'is-selected' : ''}`} aria-pressed={item.id === selectedId} onClick={() => select(item.id)}>{item.image && <img className="ms-provider-image" src={item.image} alt="" />}<span className="ms-provider-copy"><strong>{item.name}</strong><span>{item.kind === 'cloud' ? '云服务' : '本地服务'} · {item.enabled ? '已启用' : '已停用'}</span></span>{item.id === selectedId && <Check size={16} className="ms-selected-mark" />}</button>)}{!filtered.length && <div className="ms-list-empty"><p>{providers.length ? '未找到服务商' : '尚未添加服务商'}</p>{providers.length ? <button className="ms-text-button" onClick={() => setQuery('')}>清空搜索</button> : <button className="ms-text-button" onClick={() => setModal('provider')}>添加服务商</button>}</div>}</div><button className="ms-button ms-add-provider" onClick={() => setModal('provider')}><Plus size={16} />添加自定义服务商</button></aside>
    <section className="ms-detail" aria-label="服务商配置">{provider ? <>
      <button className="ms-mobile-back ms-text-button" onClick={returnToProviders}><ArrowLeft size={16} />返回服务商</button>
      <div className="ms-detail-header"><div className="ms-detail-title">{provider.image && <img className="ms-provider-image" src={provider.image} alt="" />}<div><h2 tabIndex={-1} data-ms-title>{provider.name}</h2><p>{provider.kind === 'cloud' ? '云服务' : '本地服务'} · 示例配置</p></div></div><button role="switch" aria-checked={provider.enabled} aria-label={`启用${provider.name}`} className={`ms-toggle ${provider.enabled ? 'is-on' : ''}`} onClick={() => change('enabled', !provider.enabled)}><span /></button></div>
      <div className="ms-service-status"><p className="ms-enabled-label">服务商{provider.enabled ? '已启用' : '已停用'}</p><p className={`ms-detection-status ms-${detection}`} role="status">连接检测：{detectionLabel}</p></div>
      {provider.kind === 'cloud' && <p className="ms-data-note">数据会发送给所配置的模型服务商。</p>}
      <div className="ms-form ms-connection"><h3>连接配置</h3><div className="ms-form-pair"><div className="ms-field"><label htmlFor={`${prefix}-name`}>服务商名称</label><input id={`${prefix}-name`} value={provider.name} onChange={(event) => change('name', event.target.value)} /></div><div className="ms-field"><label htmlFor={`${prefix}-protocol`}>连接协议</label><div className="ms-select-wrap"><select id={`${prefix}-protocol`} value={provider.protocol} onChange={(event) => change('protocol', event.target.value)}><option>OpenAI 兼容</option><option>Ollama</option><option>Anthropic</option></select><ChevronDown size={15} /></div></div></div>
        <div className="ms-field"><label htmlFor={`${prefix}-address`}>接口地址</label><input id={`${prefix}-address`} value={provider.address} onChange={(event) => change('address', event.target.value)} onBlur={() => setError(addressError(provider.address))} aria-invalid={!!error} aria-describedby={error ? `${prefix}-address-error` : undefined} />{error && <p id={`${prefix}-address-error`} className="ms-error">{error}</p>}</div>
        <div className="ms-field"><label htmlFor={`${prefix}-key`}>密钥{provider.kind === 'local' && <span className="ms-optional">可选</span>}</label><div className="ms-key"><input id={`${prefix}-key`} type={showKey ? 'text' : 'password'} autoComplete="off" value={provider.key} onChange={(event) => change('key', event.target.value)} placeholder={provider.kind === 'local' ? '未设置认证时可留空' : '仅填写示例密钥'} /><button className="ms-icon" aria-label={showKey ? '隐藏密钥' : '显示密钥'} aria-pressed={showKey} onClick={() => setShowKey((current) => !current)}>{showKey ? <EyeOff size={18} /> : <Eye size={18} />}</button></div>{provider.kind === 'local' && <p className="ms-hint">本地服务未设置认证时可留空。</p>}</div>
        <div className="ms-detection"><button className="ms-button" disabled={detection === 'checking'} onClick={checkConnection}>{detection === 'checking' ? <LoaderCircle className="ms-spinning" size={16} /> : <RefreshCw size={16} />}检测连接</button></div>{detection === 'failure' && <p className="ms-error">请检查接口地址和密钥后重新检测。此结果为演示。</p>}
      </div>
      <section className="ms-models" aria-label="已添加模型"><header><div><h3>模型<span>{provider.models.length}</span></h3></div><div className="ms-model-actions"><button className="ms-button" onClick={() => setModal('add-model')}><Plus size={15} />手动添加</button><button className="ms-button ms-primary" onClick={() => setModal('picker')}><RefreshCw size={15} />同步模型</button></div></header>{provider.models.length ? <div className="ms-model-rows">{provider.models.map((model) => <div className="ms-model-row" key={model.id}><div className="ms-model-description"><strong>{model.name}</strong><span>{provider.name} · {model.id}</span></div><button className="ms-icon" aria-label={`编辑${model.name}`} onClick={() => setEditing(model)}><Pencil size={17} /></button><button className="ms-icon" aria-label={`移除${model.name}`} onClick={() => setRemoving(model)}><Trash2 size={17} /></button></div>)}</div> : <div className="ms-empty ms-model-empty"><p>尚未添加模型</p><span>同步演示目录，或手动添加模型。</span><button className="ms-text-button" onClick={() => setModal('picker')}>选择模型</button></div>}</section><p className="ms-inline-notice" role="status">{notice}</p>
    </> : <div className="ms-empty ms-empty-detail"><h2 tabIndex={-1}>添加你的模型服务</h2><p>配置一个示例服务商，再选择可用模型。</p><button className="ms-button ms-primary" onClick={() => setModal('provider')}><Plus size={17} />添加服务商</button></div>}</section>
    {modal === 'provider' && <ProviderDialog onClose={() => setModal(null)} onAdd={(item) => { setProviders((current) => [...current, item]); select(item.id); setQuery(''); setModal(null); setNotice('已添加服务商 · 仅本次演示') }} />}
    {provider && modal === 'picker' && <ModelPicker provider={provider} onClose={() => setModal(null)} onAdd={(models) => { updateModels([...provider.models, ...models.filter((model) => !provider.models.some((item) => item.id === model.id))]); setModal(null); setNotice(`已添加 ${models.length} 个模型 · 仅本次演示`) }} />}
    {provider && (modal === 'add-model' || editing) && <ModelEditor provider={provider} existing={editing ?? undefined} onClose={() => { setModal(null); setEditing(null) }} onApply={(model) => { updateModels(editing ? provider.models.map((item) => item.id === editing.id ? model : item) : [...provider.models, model]); setModal(null); setEditing(null); setNotice('模型已更新 · 仅本次演示') }} />}
    {provider && removing && <Modal title="移除模型" onClose={() => setRemoving(null)}><div className="ms-modal-body"><p>从{provider.name}中移除{removing.name}？</p><p className="ms-hint">其他服务商的同名模型将保留。</p></div><footer className="ms-modal-footer"><button className="ms-button" onClick={() => setRemoving(null)}>取消</button><button className="ms-button ms-danger" onClick={() => { updateModels(provider.models.filter((item) => item.id !== removing.id)); setRemoving(null); setNotice('模型已移除 · 仅本次演示') }}>移除模型</button></footer></Modal>}
  </div>
}
