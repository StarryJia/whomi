import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import type { Provider, SettingsApi, SettingsModel } from '../../shared/settings-contract'
import { CheckBox, errorText, Modal } from './common'
import { capacityErrors, ModelParameters } from './model-parameters'

export function ModelPicker({ api, provider, models, onClose, onAdded }: { api: SettingsApi; provider: Provider; models: SettingsModel[]; onClose: () => void; onAdded: (models: SettingsModel[]) => void }) {
  const [catalog, setCatalog] = useState<{ id: string }[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [savedIds, setSavedIds] = useState<string[]>([])
  const [attempt, setAttempt] = useState(0)
  const [capacity, setCapacity] = useState({ contextWindow: Number.NaN, maxTokens: Number.NaN })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const parameters = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let alive = true
    setLoading(true); setError('')
    api.syncModels(provider.id).then(value => { if (alive) setCatalog(value) }).catch(cause => { if (alive) setError(errorText(cause, '同步失败，请检查地址与密钥后重试。')) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [api, provider.id, attempt])
  const added = new Set([...models.filter(model => model.providerId === provider.id).map(model => model.model), ...savedIds])
  const filtered = catalog.filter(model => model.id.toLowerCase().includes(query.trim().toLowerCase()))
  const available = filtered.filter(model => !added.has(model.id))
  const count = available.filter(model => selected.includes(model.id)).length
  const remaining = selected.filter(id => !added.has(id))
  function toggleAll() { const ids = available.map(model => model.id); setSelected(current => count === available.length ? current.filter(id => !ids.includes(id)) : [...new Set([...current, ...ids])]) }
  async function save() {
    const validation = capacityErrors(capacity.contextWindow, capacity.maxTokens)
    setErrors(validation)
    if (Object.keys(validation).length) { requestAnimationFrame(() => parameters.current?.querySelector<HTMLInputElement>('[aria-invalid=true]')?.focus()); return }
    setBusy(true); setError('')
    const saved: SettingsModel[] = []
    try {
      for (const id of remaining) {
        const model = await api.saveModel({ providerId: provider.id, model: id, label: id, ...capacity, enabled: true })
        saved.push(model); setSavedIds(current => [...current, id])
      }
      onAdded(saved); onClose()
    } catch (cause) { if (saved.length) onAdded(saved); setError(`${saved.length ? `已添加 ${saved.length} 项。` : ''}${errorText(cause, '添加失败，请重试剩余模型。')}`) }
    finally { setBusy(false) }
  }
  return <Modal title="选择模型" onClose={onClose} busy={busy} className="ms-model-picker">
    <div className="ms-picker-top"><p className="ms-hint">{provider.name}</p><div className="ms-search"><Search size={17} aria-hidden="true" /><input aria-label="搜索模型" placeholder="搜索模型标识" value={query} onChange={event => setQuery(event.target.value)} />{query && <button className="ms-icon" aria-label="清空模型搜索" onClick={() => setQuery('')}><X size={16} /></button>}</div><div className="ms-picker-summary"><CheckBox checked={available.length > 0 && count === available.length} mixed={count > 0 && count < available.length} disabled={!available.length || busy} onChange={toggleAll}>全选当前结果</CheckBox><span role="status">已选 {remaining.length} 项</span></div></div>
    <div className="ms-picker-results">{loading ? <p role="status">正在读取模型…</p> : filtered.length ? filtered.map(model => <div key={model.id} className="ms-model-option"><CheckBox checked={added.has(model.id) || selected.includes(model.id)} disabled={added.has(model.id) || busy} onChange={() => setSelected(current => current.includes(model.id) ? current.filter(id => id !== model.id) : [...current, model.id])}><span className="ms-model-description"><strong>{model.id}</strong></span></CheckBox>{added.has(model.id) && <span className="ms-added">已添加</span>}</div>) : !error && <div className="ms-empty"><p>{query ? '未找到匹配的模型' : '服务商未返回模型，可取消后手动添加。'}</p>{query && <button className="ms-text-button" onClick={() => setQuery('')}>清空搜索</button>}</div>}
      {error && <div role="alert"><p className="ms-error">{error}</p>{!catalog.length && <button className="ms-button" onClick={() => setAttempt(value => value + 1)}>重试同步</button>}</div>}
      {!!catalog.length && <div ref={parameters}><ModelParameters contextWindow={capacity.contextWindow} maxTokens={capacity.maxTokens} errors={errors} busy={busy} multiple onChange={(field, value) => setCapacity(current => ({ ...current, [field]: value }))} /></div>}
    </div><footer className="ms-modal-footer"><button className="ms-button" disabled={busy} onClick={onClose}>取消</button><button className="ms-button ms-primary" disabled={!remaining.length || busy} onClick={() => void save()}>{busy ? '正在添加…' : `添加所选模型${remaining.length ? ` (${remaining.length})` : ''}`}</button></footer>
  </Modal>
}
