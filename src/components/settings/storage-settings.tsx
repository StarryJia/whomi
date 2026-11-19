import { useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import type { SettingsApi, StorageChoice, StorageLocation } from '../../shared/settings-contract'
import { errorText, Modal } from './common'
import { ExceptionNotice } from '../ui/exception-notices'

export function StorageSettings({ api, canManageData, onBusy, onRestartRequired }: { api: SettingsApi; canManageData: boolean; onBusy: (busy: boolean) => void; onRestartRequired: (required: boolean) => void }) {
  const [location, setLocation] = useState<StorageLocation | null>(null)
  const [choice, setChoice] = useState<StorageChoice | null>(null)
  const [pending, setPending] = useState<'open' | 'logs' | 'choose' | 'relocate' | 'restart' | null>(null)
  const busy = pending !== null
  const [error, setError] = useState('')
  const [logError, setLogError] = useState('')
  const [missedRecords, setMissedRecords] = useState(0)
  const [moveFailed, setMoveFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!canManageData) return
    let active = true
    setError('')
    api.getStorage().then(value => { if (active) { setLocation(value); onRestartRequired(value.restartRequired) } }).catch(cause => { if (active) setError(errorText(cause, '保存目录读取失败，请重试。')) })
    return () => { active = false }
  }, [api, canManageData, attempt, onRestartRequired])
  useEffect(() => { onBusy(busy); return () => onBusy(false) }, [busy, onBusy])
  async function openDirectory() {
    if (busy) return
    setPending('open'); setError('')
    try { await api.openStorageDirectory() }
    catch (cause) { setError(errorText(cause, '无法打开保存目录，请检查目录后重试。')) }
    finally { setPending(null) }
  }
  async function openLogs() {
    if (busy) return
    setPending('logs'); setLogError('')
    try { setMissedRecords((await api.openErrorLogDirectory()).missedRecords ?? 0) }
    catch (cause) { setLogError(errorText(cause, '无法打开错误日志目录，请重试。')) }
    finally { setPending(null) }
  }
  async function choose() {
    setPending('choose'); setError('')
    try { const result = await api.chooseStorage(); if (result) { setChoice(result); setMoveFailed(false) } }
    catch (cause) { setError(errorText(cause, '无法选择目录，请重试。')) }
    finally { setPending(null) }
  }
  async function relocate() {
    if (!choice) return
    setPending('relocate'); setError('')
    try { const result = await api.relocateStorage(choice.token); setLocation(result); onRestartRequired(result.restartRequired); setChoice(null); setMoveFailed(false) }
    catch (cause) {
      setError(errorText(cause, '迁移失败，请重试或重新选择目录。')); setMoveFailed(true)
      try {
        const current = await api.getStorage()
        setLocation(current); onRestartRequired(current.restartRequired)
        if (current.restartRequired) setChoice(null)
      } catch { setChoice(null); setLocation(null) }
    }
    finally { setPending(null) }
  }
  async function restart() { setPending('restart'); setError(''); try { await api.restart() } catch (cause) { setError(errorText(cause, '重启失败，请重试。')); setPending(null) } }
  return <div className="settings-storage mp-page"><header className="mp-page-heading"><h1 tabIndex={-1}>数据存储</h1><p>选择会话记录和分析数据的保存位置。</p></header>
    {canManageData && (!location ? <div className="mp-content-section">{error ? <><ExceptionNotice title="无法读取保存目录" detail={error} className="ms-error" /><button className="ms-button" onClick={() => setAttempt(value => value + 1)}>重新读取目录</button></> : <p role="status">正在读取保存目录…</p>}</div> : <section className="mp-content-section">
      <h2>{location.restartRequired && !moveFailed ? '新的保存目录' : '当前保存目录'}</h2>
      <p className="settings-path"><button type="button" className="settings-directory-link" aria-label={`打开保存目录 ${location.path}`}
        title="打开保存目录" aria-disabled={busy} onClick={() => void openDirectory()}>{location.path}</button></p>
      {location.restartRequired ? <><p role="status">{moveFailed ? '请重启 Whomi 继续使用。' : '数据已迁移，请重启 Whomi 继续使用。'}</p><button className="ms-button ms-primary" disabled={busy} onClick={() => void restart()}>{pending === 'restart' ? '正在重启…' : '立即重启'}</button></> : <><p className="ms-hint">迁移到空目录后，原目录会保留为备份。</p><button className="ms-button" disabled={busy} onClick={() => void choose()}><FolderOpen size={17} />选择保存目录</button></>}
      {error && !choice && <ExceptionNotice title="保存目录操作失败" detail={error} className="ms-error" />}
    </section>)}
    <div className="settings-log-action">
      <button type="button" className="ms-text-button" disabled={busy} onClick={() => void openLogs()}><FolderOpen size={16} aria-hidden="true" />打开错误日志目录</button>
      {logError && <ExceptionNotice title={logError} noticeKey="error-log-open" className="ms-error" />}
      {missedRecords > 0 && <p role="status" className="ms-hint">本次运行有 {missedRecords} 条错误日志未保存。</p>}
    </div>
    {choice && <Modal title="迁移数据" onClose={() => { if (!busy) { setChoice(null); setError(''); setMoveFailed(false) } }} busy={busy}><div className="ms-modal-body"><p>将已有会话和分析数据迁移到：</p><p className="settings-path">{choice.path}</p><p className="ms-hint">原目录会保留为备份。完成后需要重启 Whomi。</p>{busy && <p role="status">正在迁移，请保持应用打开…</p>}{error && <ExceptionNotice title="数据迁移失败" detail={error} className="ms-error" />}</div><footer className="ms-modal-footer"><button className="ms-button" disabled={busy} onClick={() => { setChoice(null); setError(''); setMoveFailed(false) }}>取消</button>{moveFailed && <button className="ms-button" disabled={busy} onClick={() => void choose()}>重新选择</button>}<button className="ms-button ms-primary" disabled={busy} onClick={() => void relocate()}>{busy ? '正在迁移…' : moveFailed ? '重试迁移' : '确认迁移'}</button></footer></Modal>}
  </div>
}
