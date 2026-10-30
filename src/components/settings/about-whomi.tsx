import { useEffect, useState } from 'react'
import { ArrowUpRight, ChevronRight, Copy } from 'lucide-react'
import packageMetadata from '../../../package.json'
import thirdPartyNotices from '../../../THIRD_PARTY_NOTICES.md?raw'
import symbol from '../../../assets/branding/whomi-symbol.png'
import wordmark from '../../../assets/branding/whomi-wordmark.png'
import type { Diagnostics, SettingsApi } from '../../shared/settings-contract'
import { errorText, Modal, Switch } from './common'

function NoticeText({ text }: { text: string }) {
  return <>{text.split(/(\[[^\]]+\]\([^)]+\)|`[^`]+`)/g).map((part, index) => {
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
    if (link) return /^https?:\/\//.test(link[2]) ? <a key={index} href={link[2]} target="_blank" rel="noopener noreferrer">{link[1]}</a> : <span key={index}>{link[1]}</span>
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>
    return part
  })}</>
}
function Notices() {
  return <div className="aw-notices-text">{thirdPartyNotices.trim().split(/\n\s*\n/).map((block, index) => {
    if (block.startsWith('### ')) return <h4 key={index}>{block.slice(4)}</h4>
    if (block.startsWith('## ')) return <h3 key={index}>{block.slice(3)}</h3>
    if (block.startsWith('# ')) return <h2 key={index}>{block.slice(2)}</h2>
    return <p key={index}><NoticeText text={block} /></p>
  })}</div>
}

export function AboutWhomi({ api, debug, onDebug, onBusy }: { api: SettingsApi; debug: boolean; onDebug: (next: boolean) => void; onBusy: (busy: boolean) => void }) {
  const [notices, setNotices] = useState(false)
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [debugError, setDebugError] = useState('')
  const [failedDebug, setFailedDebug] = useState<boolean | null>(null)
  const [copied, setCopied] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!debug) return
    let active = true
    setLoading(true); setError('')
    api.getDiagnostics().then(result => { if (active) setDiagnostics(result) }).catch(cause => { if (active) setError(errorText(cause, '诊断信息读取失败，请重试。')) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [api, debug, attempt])
  async function changeDebug(next: boolean) {
    setBusy(true); onBusy(true); setDebugError(''); setFailedDebug(null)
    try { await api.setDebug(next); onDebug(next) }
    catch (cause) { setDebugError(errorText(cause, '保存失败，请重试。')); setFailedDebug(next) }
    finally { setBusy(false); onBusy(false) }
  }
  async function copy() {
    if (!diagnostics) return
    try { await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2)); setCopied(true); setError('') }
    catch { setError('复制失败，请选中诊断信息后手动复制。') }
  }
  return <div className="aw-page"><header className="aw-page-heading"><h1 tabIndex={-1}>关于whomi</h1></header>
    <section className="aw-identity" aria-label="Whomi 项目信息"><img className="aw-symbol" src={symbol} alt="Whomi 图形标识" /><span className="aw-wordmark"><img src={wordmark} alt="Whomi" /></span><p className="aw-version">版本 {packageMetadata.version}</p><p className="aw-introduction">一个了解你的程序</p></section>
    <section className="aw-information" aria-label="项目与许可"><a className="aw-information-row" href="https://github.com/StarryJia/whomi" target="_blank" rel="noopener noreferrer"><span>项目仓库</span><span className="aw-link-value">StarryJia/whomi <ArrowUpRight size={16} /></span></a><button className="aw-information-row" onClick={() => setNotices(true)}><span>第三方声明</span><ChevronRight size={17} /></button></section>
    <section className="aw-debug" aria-labelledby="settings-debug-title"><h2 id="settings-debug-title">调试面板</h2><div className="aw-debug-control"><span>调试模式</span><Switch label="调试模式" checked={debug} disabled={busy} onChange={() => void changeDebug(!debug)} /></div>
      {debugError && <div role="alert"><p className="ms-error">{debugError}</p>{failedDebug !== null && <button className="ms-button" disabled={busy} onClick={() => void changeDebug(failedDebug)}>重试保存</button>}</div>}
      {debug && <div className="aw-debug-content">{loading ? <p role="status">正在读取诊断信息…</p> : diagnostics && <><dl><div><dt>运行环境</dt><dd>{diagnostics.platform}</dd></div><div><dt>版本</dt><dd>{diagnostics.version}</dd></div></dl>{diagnostics.entries.length ? <ul className="settings-diagnostics">{diagnostics.entries.map((entry, index) => <li key={index}><strong>{entry.code}</strong><p>{entry.action}</p></li>)}</ul> : <p>暂无错误记录。</p>}<div className="settings-row"><button className="ms-button" onClick={() => void copy()}><Copy size={16} />复制诊断信息</button><span role="status">{copied ? '已复制。' : ''}</span></div></>}{error && <p className="ms-error" role="alert">{error}</p>}<button className="ms-text-button" disabled={loading} onClick={() => { setCopied(false); setAttempt(value => value + 1) }}>重新读取诊断信息</button></div>}
    </section>
    {notices && <Modal title="第三方声明" onClose={() => setNotices(false)} className="settings-notices"><div className="ms-modal-body"><Notices /></div></Modal>}
  </div>
}
