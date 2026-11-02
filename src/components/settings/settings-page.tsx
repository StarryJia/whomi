import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react'
import { ArrowLeft, ChevronDown } from 'lucide-react'
import type { SettingsApi, SettingsSnapshot } from '../../shared/settings-contract'
import { ModelServices } from './model-services'
import { MessageProcessing } from './message-processing'
import { AboutWhomi } from './about-whomi'
import { StorageSettings } from './storage-settings'
import { SystemPrompts } from './system-prompts'
import { errorText, type LeaveGuard } from './common'
import './settings.css'
import './model-services.css'
import './message-processing.css'
import './about-whomi.css'
import './cherry-settings.css'

const categories = [{ id: 'models', label: '模型服务' }, { id: 'messages', label: '消息处理' }, { id: 'prompts', label: '系统提示词' }, { id: 'storage', label: '数据存储' }, { id: 'about', label: '关于 Whomi' }] as const
type Category = typeof categories[number]['id']

export function SettingsPage({ api, onClose, onChanged, leaveRef, onLockChange }: {
  api: SettingsApi
  onClose: () => void
  onChanged?: () => void
  leaveRef?: Ref<LeaveGuard>
  onLockChange?: (locked: boolean) => void
}) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null)
  const [error, setError] = useState('')
  const [category, setCategory] = useState<Category>('models')
  const [menuOpen, setMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [restartRequired, setRestartRequired] = useState(false)
  const guard = useRef<LeaveGuard | null>(null)
  const main = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const registerGuard = useCallback((next: LeaveGuard | null) => { guard.current = next }, [])
  const load = useCallback(async () => {
    setError('')
    try { setSnapshot(await api.get()) } catch (cause) { setError(errorText(cause, '设置读取失败，请重试。')) }
  }, [api])
  useEffect(() => { void load() }, [load])
  const locked = busy || restartRequired
  const navigate = useCallback((action: () => void) => {
    if (locked) return
    if (guard.current) guard.current(action)
    else action()
  }, [locked])
  useImperativeHandle(leaveRef, () => navigate, [navigate])
  useLayoutEffect(() => { onLockChange?.(locked) }, [locked, onLockChange])
  useEffect(() => { heading.current?.focus({ preventScroll: true }) }, [])
  function changeCategory(next: Category) {
    if (next === category) { setMenuOpen(false); return }
    navigate(() => { setCategory(next); setMenuOpen(false); requestAnimationFrame(() => main.current?.focus({ preventScroll: true })) })
  }
  const changed = () => onChanged?.()
  const categoryLabel = categories.find(item => item.id === category)!.label
  return <div className="settings-page">
    <header className="sp-header sp-sidebar">
      <div className="sp-heading-row">
        <h1 ref={heading} tabIndex={-1}>设置</h1>
        <button type="button" className="sp-return" disabled={locked} onClick={() => navigate(onClose)}><ArrowLeft size={16} aria-hidden="true" />返回</button>
        <button type="button" className="sp-category-toggle" aria-description={categoryLabel} aria-expanded={menuOpen} aria-controls="settings-navigation" onClick={() => setMenuOpen(value => !value)}>分类<ChevronDown size={16} aria-hidden="true" /></button>
      </div>
      <nav id="settings-navigation" aria-label="设置分类" className={`sp-navigation ${menuOpen ? 'is-open' : ''}`}>{categories.map(({ id, label }) => <button key={id} type="button" aria-current={category === id ? 'page' : undefined} disabled={locked} onClick={() => changeCategory(id)}>{label}</button>)}</nav>
    </header>
    <div ref={main} role="region" aria-label={categoryLabel} tabIndex={-1} className="sp-main">{!snapshot ? <div className="settings-load">{error ? <><p role="alert">{error}</p><button className="ms-button" onClick={() => void load()}>重新读取设置</button></> : <p role="status">正在读取设置…</p>}</div> : <>
      {category === 'models' && <ModelServices api={api} snapshot={snapshot} setSnapshot={setSnapshot} onChanged={changed} registerGuard={registerGuard} onBusy={setBusy} />}
      {category === 'messages' && <MessageProcessing api={api} value={snapshot.processing} onSaved={processing => { setSnapshot(current => current && { ...current, processing }); changed() }} onBusy={setBusy} />}
      {category === 'about' && <AboutWhomi api={api} debug={snapshot.debug} onDebug={debug => setSnapshot(current => current && { ...current, debug })} onBusy={setBusy} />}
      {category === 'storage' && <StorageSettings api={api} onBusy={setBusy} onRestartRequired={setRestartRequired} />}
      {category === 'prompts' && <SystemPrompts api={api} registerGuard={registerGuard} onBusy={setBusy} />}
    </>}</div>
  </div>
}
