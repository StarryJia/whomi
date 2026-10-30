import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Database, Info, MessageSquare, SlidersHorizontal } from 'lucide-react'
import symbol from '../../../assets/branding/whomi-symbol.png'
import wordmark from '../../../assets/branding/whomi-wordmark.png'
import type { SettingsApi, SettingsSnapshot } from '../../shared/settings-contract'
import { ModelServices } from './model-services'
import { MessageProcessing } from './message-processing'
import { AboutWhomi } from './about-whomi'
import { StorageSettings } from './storage-settings'
import { errorText, type LeaveGuard } from './common'
import './settings.css'
import './model-services.css'
import './message-processing.css'
import './about-whomi.css'

const categories = [{ id: 'models', label: '模型服务', icon: SlidersHorizontal }, { id: 'messages', label: '消息处理', icon: MessageSquare }, { id: 'storage', label: '数据存储', icon: Database }, { id: 'about', label: '关于whomi', icon: Info }] as const
type Category = typeof categories[number]['id']

export function SettingsPage({ api, onClose, onChanged }: { api: SettingsApi; onClose: () => void; onChanged?: () => void }) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null)
  const [error, setError] = useState('')
  const [category, setCategory] = useState<Category>('models')
  const [menuOpen, setMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [restartRequired, setRestartRequired] = useState(false)
  const guard = useRef<LeaveGuard | null>(null)
  const main = useRef<HTMLElement>(null)
  const registerGuard = useCallback((next: LeaveGuard | null) => { guard.current = next }, [])
  const load = useCallback(async () => {
    setError('')
    try { setSnapshot(await api.get()) } catch (cause) { setError(errorText(cause, '设置读取失败，请重试。')) }
  }, [api])
  useEffect(() => { void load() }, [load])
  function navigate(action: () => void) { if (busy || restartRequired) return; if (guard.current) guard.current(action); else action() }
  function changeCategory(next: Category) {
    if (next === category) { setMenuOpen(false); return }
    navigate(() => { setCategory(next); setMenuOpen(false); requestAnimationFrame(() => main.current?.querySelector<HTMLElement>('h1,h2')?.focus({ preventScroll: true })) })
  }
  const changed = () => onChanged?.()
  return <div className="settings-page sp-workspace">
    <aside className="sp-sidebar"><div className="sp-brand" aria-label="Whomi"><span className="brand-symbol"><img src={symbol} alt="" /></span><span className="brand-wordmark"><img src={wordmark} alt="Whomi" /></span></div>
      <button type="button" className="sp-return" disabled={busy || restartRequired} onClick={() => navigate(onClose)}><ArrowLeft aria-hidden="true" />返回</button>
      <div className="sp-sidebar-heading"><h1>设置</h1><button type="button" className="sp-category-toggle" aria-expanded={menuOpen} aria-controls="settings-navigation" onClick={() => setMenuOpen(value => !value)}>分类</button></div>
      <nav id="settings-navigation" aria-label="设置分类" className={`sp-navigation ${menuOpen ? 'is-open' : ''}`}>{categories.map(({ id, label, icon: Icon }) => <button key={id} type="button" aria-current={category === id ? 'page' : undefined} disabled={busy || restartRequired} onClick={() => changeCategory(id)}><Icon aria-hidden="true" />{label}</button>)}</nav>
    </aside>
    <main ref={main} className="sp-main">{!snapshot ? <div className="settings-load">{error ? <><p role="alert">{error}</p><button className="ms-button" onClick={() => void load()}>重新读取设置</button></> : <p role="status">正在读取设置…</p>}</div> : <>
      {category === 'models' && <ModelServices api={api} snapshot={snapshot} setSnapshot={setSnapshot} onChanged={changed} registerGuard={registerGuard} onBusy={setBusy} />}
      {category === 'messages' && <MessageProcessing api={api} value={snapshot.processing} onSaved={processing => { setSnapshot(current => current && { ...current, processing }); changed() }} onBusy={setBusy} />}
      {category === 'about' && <AboutWhomi api={api} debug={snapshot.debug} onDebug={debug => setSnapshot(current => current && { ...current, debug })} onBusy={setBusy} />}
      {category === 'storage' && <StorageSettings api={api} onBusy={setBusy} onRestartRequired={setRestartRequired} />}
    </>}</main>
  </div>
}
