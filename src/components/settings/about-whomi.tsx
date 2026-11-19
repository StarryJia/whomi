import { useEffect, useState } from 'react'
import { ArrowUpRight, Copy, FolderOpen } from 'lucide-react'
import packageMetadata from '../../../package.json'
import symbol from '../../../assets/branding/whomi-symbol.png'
import wordmark from '../../../assets/branding/whomi-wordmark.png'
import type { Diagnostics, ErrorLogArchive, ErrorLogTarget, SettingsApi } from '../../shared/settings-contract'
import { ExceptionNotice } from '../ui/exception-notices'
import { errorText, Switch } from './common'

export function AboutWhomi({ api, debug, onDebug, onBusy }: { api: SettingsApi; debug?: boolean; onDebug: (next: boolean) => void; onBusy: (busy: boolean) => void }) {
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [debugError, setDebugError] = useState('')
  const [failedDebug, setFailedDebug] = useState<boolean | null>(null)
  const [copied, setCopied] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [loading, setLoading] = useState(false)
  const [logOpening, setLogOpening] = useState(false)
  const [logError, setLogError] = useState('')
  const [missedRecords, setMissedRecords] = useState(0)
  const [archives, setArchives] = useState<ErrorLogArchive[]>([])
  useEffect(() => {
    if (logOpening) return
    let active = true
    void api.getErrorLogArchives().then(value => { if (active) setArchives(value) }, () => {})
    return () => { active = false }
  }, [api, logOpening])
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
  async function openLog(target: ErrorLogTarget) {
    if (logOpening) return
    setLogOpening(true); setLogError('')
    try {
      const location = await api.openErrorLogDirectory(target)
      if (target === 'current') setMissedRecords(location.missedRecords ?? 0)
    }
    catch (cause) { setLogError(errorText(cause, '无法打开错误日志目录，请重试。')) }
    finally { setLogOpening(false) }
  }
  return <div className="aw-page"><header className="aw-page-heading"><h1 tabIndex={-1}>关于 Whomi</h1></header>
    <section className="aw-identity" aria-label="Whomi 项目信息"><img className="aw-symbol" src={symbol} alt="Whomi 图形标识" /><span className="aw-wordmark"><img src={wordmark} alt="Whomi" /></span><p className="aw-version">版本 {packageMetadata.version}</p><p className="aw-introduction">从对话中找出你不曾注意的细节</p></section>
    <section className="aw-information" aria-label="项目与诊断"><a className="aw-information-row" href="https://github.com/StarryJia/whomi" target="_blank" rel="noopener noreferrer"><span>项目仓库</span><span className="aw-link-value">StarryJia/whomi <ArrowUpRight size={16} /></span></a>
      <button type="button" className="aw-information-row" disabled={logOpening} onClick={() => void openLog('current')}>打开错误日志目录<FolderOpen size={16} aria-hidden="true" /></button>
      {archives.includes('legacy-import') && <button type="button" className="aw-information-row" disabled={logOpening} onClick={() => void openLog('legacy-import')}>打开旧版导入日志目录<FolderOpen size={16} aria-hidden="true" /></button>}
      {archives.includes('profile') && <button type="button" className="aw-information-row" disabled={logOpening} onClick={() => void openLog('profile')}>打开用户目录中的日志<FolderOpen size={16} aria-hidden="true" /></button>}
      {archives.includes('data') && <button type="button" className="aw-information-row" disabled={logOpening} onClick={() => void openLog('data')}>打开数据目录中的日志<FolderOpen size={16} aria-hidden="true" /></button>}
      {archives.filter(archive => archive.startsWith('retained:')).map(archive =>
        <button key={archive} type="button" className="aw-information-row" disabled={logOpening} onClick={() => void openLog(archive)}>
          <span>打开迁移前的日志目录 {archive.slice('retained:'.length)}</span><FolderOpen size={16} aria-hidden="true" />
        </button>)}
      {missedRecords > 0 && <p role="status" className="aw-muted">本次运行有 {missedRecords} 条错误日志未保存。请检查磁盘空间和目录权限。</p>}
      {logError && <ExceptionNotice title={logError} noticeKey="error-log-open" className="ms-error" />}
    </section>
    {debug !== undefined && <section className="aw-debug" aria-labelledby="settings-debug-title"><h2 id="settings-debug-title">调试面板</h2><div className="aw-debug-control"><span>调试模式</span><Switch label="调试模式" checked={debug} disabled={busy} onChange={() => void changeDebug(!debug)} /></div>
      {debugError && <div><ExceptionNotice className="ms-error" title={debugError} noticeKey="debug-setting" />{failedDebug !== null && <button className="ms-button" disabled={busy} onClick={() => void changeDebug(failedDebug)}>重试保存</button>}</div>}
      {debug && <div className="aw-debug-content">{loading ? <p role="status">正在读取诊断信息…</p> : diagnostics && <><dl><div><dt>运行环境</dt><dd>{diagnostics.platform}</dd></div><div><dt>版本</dt><dd>{diagnostics.version}</dd></div></dl>{diagnostics.entries.length ? <ul className="settings-diagnostics">{diagnostics.entries.map((entry, index) => <li key={index}><strong>{entry.code}</strong><p>{entry.action}</p></li>)}</ul> : <p>暂无错误记录。</p>}<div className="settings-row"><button className="ms-button" onClick={() => void copy()}><Copy size={16} />复制诊断信息</button><span role="status">{copied ? '已复制。' : ''}</span></div></>}{error && <ExceptionNotice className="ms-error" title={error} noticeKey="debug-diagnostics" />}<button className="ms-text-button" disabled={loading} onClick={() => { setCopied(false); setAttempt(value => value + 1) }}>重新读取诊断信息</button></div>}
    </section>}
  </div>
}
