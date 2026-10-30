// Adapted from Cherry Studio ModelListSyncDrawer / ModelListSyncContent (AGPL-3.0).
import { useEffect, useState } from 'react'
import { Minus, Plus, RefreshCw, Search, X } from 'lucide-react'
import type { CatalogModel, Provider, SettingsApi, SettingsModel } from '../../shared/settings-contract'
import { errorText, isModelBusy } from './common'
import { ProviderSettingsDrawer } from './cherry-primitives'
import { getDefaultGroupName } from './cherry-model-naming'

export function ModelPicker({ api, provider, models, onClose, onAdded, onRemoved, onBusy }: { api: SettingsApi; provider: Provider; models: SettingsModel[]; onClose: () => void; onAdded: (models: SettingsModel[]) => void; onRemoved: (ids: string[]) => void; onBusy: (busy: boolean) => void }) {
  const [catalog, setCatalog] = useState<CatalogModel[]>([]), [query, setQuery] = useState(''), [filter, setFilter] = useState<'all' | 'added' | 'stale'>('all')
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [attempt, setAttempt] = useState(0), [loaded, setLoaded] = useState(false)
  const [retry, setRetry] = useState<{ entries: CatalogModel[]; remove: boolean; stop: boolean } | null>(null)
  useEffect(() => { onBusy(busy); return () => onBusy(false) }, [busy, onBusy])
  useEffect(() => {
    let alive = true
    setLoading(true); setError('')
    api.syncModels(provider.id).then(value => { if (alive) { setCatalog(value); setLoaded(true) } }).catch(cause => { if (alive) setError(errorText(cause, '同步失败，请检查配置后重试。')) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [api, provider.id, attempt])
  const local = models.filter(model => model.providerId === provider.id), localIds = new Map(local.map(model => [model.model, model]))
  const catalogIds = new Set(catalog.map(model => model.id))
  const stale = loaded ? local.filter(model => !catalogIds.has(model.model)) : []
  const all: CatalogModel[] = [...catalog, ...stale.map(model => ({ id: model.model, label: model.label, group: model.group }))]
  const filtered = all.filter(model => `${model.id} ${model.label ?? ''} ${model.group ?? ''}`.toLowerCase().includes(query.toLowerCase()) && (filter === 'all' || filter === 'added' && localIds.has(model.id) || filter === 'stale' && !catalogIds.has(model.id)))
  const allAdded = filtered.length > 0 && filtered.every(model => localIds.has(model.id))
  const groupOf = (model: CatalogModel) => model.group || getDefaultGroupName(model.id, provider.id)
  const groups = [...new Set(filtered.map(groupOf))]
  async function apply(entries: CatalogModel[], remove: boolean, stop = false) {
    setBusy(true); setError(''); setRetry(null)
    const saved: SettingsModel[] = [], removed: string[] = []
    let completed = 0
    try {
      if (stop) await api.stopModelTasks(entries.map(model => localIds.get(model.id)?.id).filter((id): id is string => !!id))
      for (const model of entries) {
        if (remove) { const existing = localIds.get(model.id); if (existing) { await api.removeModel(existing.id); removed.push(existing.id); onRemoved([existing.id]) } }
        else if (!localIds.has(model.id)) {
          const value = await api.saveModel({ providerId: provider.id, model: model.id, label: model.label || model.id, group: groupOf(model), contextWindow: model.contextWindow ?? null, maxTokens: model.maxTokens ?? null, maxInputTokens: model.maxInputTokens ?? null, enabled: true })
          saved.push(value); onAdded([value])
        }
        completed++
      }
    } catch (cause) {
      setError(`${completed ? `已${remove ? '移除' : '添加'} ${completed} 项。` : ''}${errorText(cause)}`)
      setRetry({ entries: entries.slice(completed), remove, stop: isModelBusy(cause) })
    } finally { setBusy(false) }
  }
  return <ProviderSettingsDrawer title={`${provider.name} 模型`} onClose={onClose} busy={busy} wide>
    <section className="cherry-model-sync" aria-label="同步模型列表"><div className="cherry-sync-toolbar"><div className="ms-search"><Search size={14} /><input aria-label="搜索模型" placeholder="搜索模型" value={query} onChange={event => setQuery(event.target.value)} />{query && <button className="ms-icon" aria-label="清空模型搜索" onClick={() => setQuery('')}><X size={14} /></button>}</div><button className="ms-icon" aria-label="刷新模型列表" disabled={busy || loading} onClick={() => setAttempt(value => value + 1)}><RefreshCw size={14} /></button></div>
      <div className="cherry-sync-filters" aria-label="模型筛选">{([{ id: 'all', label: '全部', count: all.length }, { id: 'added', label: '已添加', count: local.length }, { id: 'stale', label: '已失效', count: stale.length }] as const).filter(item => item.id !== 'stale' || item.count > 0).map(item => <button type="button" key={item.id} className="ms-text-button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label} <span>{item.count}</span></button>)}<button className="ms-text-button" disabled={busy || loading || !filtered.length} onClick={() => void apply(allAdded ? filtered : filtered.filter(model => !localIds.has(model.id)), allAdded)}>{allAdded ? '移除当前列表' : '添加当前列表'}</button></div>
      {loading && <p role="status" className="ms-hint">正在读取模型…</p>}
      {error && <div role="alert"><p className="ms-error">{error}</p><button className="ms-button" disabled={busy || loading} onClick={() => { if (retry) void apply(retry.entries, retry.remove, retry.stop); else setAttempt(value => value + 1) }}>{retry?.stop ? '停止任务并重试' : retry ? '重试剩余模型' : '重试同步'}</button></div>}
      {!loading && !error && !filtered.length && <p className="ms-hint">{query ? '未找到匹配的模型' : '服务商未返回模型，请手动添加。'}</p>}
      {!loading && groups.map(group => <div key={group} className="cherry-model-group"><h4>{group}</h4>{filtered.filter(model => groupOf(model) === group).map(model => {
        const added = localIds.has(model.id), label = model.label || model.id
        return <div key={model.id} className="cherry-sync-row" data-added={added}><div className="ms-model-description"><strong title={label}>{label}</strong>{label !== model.id && <span title={model.id}>{model.id}</span>}</div>{!catalogIds.has(model.id) && <span className="ms-hint">已失效</span>}{model.contextWindow && <span className="cherry-catalog-capacity">{model.contextWindow.toLocaleString()}</span>}<button className="ms-icon" disabled={busy} aria-label={`${added ? '移除' : '添加'}${label}`} onClick={() => void apply([model], added)}>{added ? <Minus size={15} /> : <Plus size={15} />}</button></div>
      })}</div>)}
    </section>
  </ProviderSettingsDrawer>
}
