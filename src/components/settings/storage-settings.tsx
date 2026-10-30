import { useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import type { SettingsApi, StorageChoice, StorageLocation } from '../../shared/settings-contract'
import { errorText, Modal } from './common'

export function StorageSettings({ api, onBusy, onRestartRequired }: { api: SettingsApi; onBusy: (busy: boolean) => void; onRestartRequired: (required: boolean) => void }) {
  const [location, setLocation] = useState<StorageLocation | null>(null)
  const [choice, setChoice] = useState<StorageChoice | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [moveFailed, setMoveFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    setError('')
    api.getStorage().then(value => { if (active) { setLocation(value); onRestartRequired(value.restartRequired) } }).catch(cause => { if (active) setError(errorText(cause, '保存目录读取失败，请重试。')) })
    return () => { active = false }
  }, [api, attempt, onRestartRequired])
  useEffect(() => { onBusy(busy); return () => onBusy(false) }, [busy, onBusy])
  async function choose() {
    setBusy(true); setError('')
    try { const result = await api.chooseStorage(); if (result) { setChoice(result); setMoveFailed(false) } }
    catch (cause) { setError(errorText(cause, '无法选择目录，请重试。')) }
    finally { setBusy(false) }
  }
  async function relocate() {
    if (!choice) return
    setBusy(true); setError('')
    try { const result = await api.relocateStorage(choice.token); setLocation(result); onRestartRequired(result.restartRequired); setChoice(null); setMoveFailed(false) }
    catch (cause) {
      setError(errorText(cause, '迁移失败，请重试或重新选择目录。')); setMoveFailed(true)
      try {
        const current = await api.getStorage()
        setLocation(current); onRestartRequired(current.restartRequired)
        if (current.restartRequired) setChoice(null)
      } catch { setChoice(null); setLocation(null) }
    }
    finally { setBusy(false) }
  }
  async function restart() { setBusy(true); setError(''); try { await api.restart() } catch (cause) { setError(errorText(cause, '重启失败，请重试。')); setBusy(false) } }
  return <div className="settings-storage mp-page"><header className="mp-page-heading"><h1 tabIndex={-1}>数据存储</h1><p>选择会话记录和分析数据的保存位置。</p></header>
    {!location ? <div className="mp-content-section">{error ? <><p role="alert" className="ms-error">{error}</p><button className="ms-button" onClick={() => setAttempt(value => value + 1)}>重新读取目录</button></> : <p role="status">正在读取保存目录…</p>}</div> : <section className="mp-content-section">
      <h2>{location.restartRequired && !moveFailed ? '新的保存目录' : '当前保存目录'}</h2><p className="settings-path">{location.path}</p>
      {location.restartRequired ? <><p role="status">{moveFailed ? '请重启 Whomi 继续使用。' : '数据已迁移，请重启 Whomi 继续使用。'}</p><button className="ms-button ms-primary" disabled={busy} onClick={() => void restart()}>{busy ? '正在重启…' : '立即重启'}</button></> : <><p className="ms-hint">迁移到空目录后，原目录会保留为备份。</p><button className="ms-button" disabled={busy} onClick={() => void choose()}><FolderOpen size={17} />选择保存目录</button></>}
      {error && !choice && <p className="ms-error" role="alert">{error}</p>}
    </section>}
    {choice && <Modal title="迁移数据" onClose={() => { if (!busy) { setChoice(null); setError(''); setMoveFailed(false) } }} busy={busy}><div className="ms-modal-body"><p>将已有会话和分析数据迁移到：</p><p className="settings-path">{choice.path}</p><p className="ms-hint">原目录会保留为备份。完成后需要重启 Whomi。</p>{busy && <p role="status">正在迁移，请保持应用打开…</p>}{error && <p className="ms-error" role="alert">{error}</p>}</div><footer className="ms-modal-footer"><button className="ms-button" disabled={busy} onClick={() => { setChoice(null); setError(''); setMoveFailed(false) }}>取消</button>{moveFailed && <button className="ms-button" disabled={busy} onClick={() => void choose()}>重新选择</button>}<button className="ms-button ms-primary" disabled={busy} onClick={() => void relocate()}>{busy ? '正在迁移…' : moveFailed ? '重试迁移' : '确认迁移'}</button></footer></Modal>}
  </div>
}
