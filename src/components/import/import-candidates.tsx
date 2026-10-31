import { useState } from 'react'
import type { DesktopError } from '../../shared/desktop-api'
import type { Discovery } from '../../shared/import-contract'

export function DiscoveryChoices({ discovery, busy, onStage, onCancel, onRechoose, error }: {
  discovery: Discovery; busy: boolean; onStage: (ids: string[]) => void; onCancel?: () => void; onRechoose?: () => void; error?: DesktopError | null
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  if (discovery.entries.length === 0) {
    return <section className="import-step" aria-label="未识别到文件入口">
      <h2>未识别到可导入的聊天记录</h2>
      <p className="import-muted">请选择其他文件。</p>
      {discovery.unrecognized.length > 0 && <ul className="import-unrecognized-list">
        {discovery.unrecognized.map((item, index) => <li key={index}><small>{item.displayName}</small></li>)}
      </ul>}
      {discovery.issues.map((issue, index) => <p className="import-error" key={index}>{issue.action}</p>)}
      {error && <p className="import-error" role="alert" data-error-code={error.code}>{error.action}</p>}
      <div className="import-step-actions">
        {onRechoose && <button className="import-primary" type="button" disabled={busy} onClick={onRechoose}>重新选择文件</button>}
        {onCancel && <button className="import-secondary" type="button" disabled={busy} onClick={onCancel}>取消导入</button>}
      </div>
    </section>
  }
  return <section className="import-step" aria-label="发现的文件入口">
    <h2>选择要解析的入口</h2>
    <p className="import-muted">已发现 {discovery.entries.length} 个文件入口。</p>
    <ul className="import-entries">{discovery.entries.map(entry => <li key={entry.entryId}><label>
      <input type="checkbox" checked={selected.has(entry.entryId)} disabled={busy}
        onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(entry.entryId); else next.delete(entry.entryId); return next })} />
      <span>{entry.displayName}</span>
    </label></li>)}</ul>
    {discovery.unrecognized.length > 0 && <details><summary>未识别文件 {discovery.unrecognized.length} 项</summary>
      <ul>{discovery.unrecognized.map((item, index) => <li key={index}>{item.displayName}</li>)}</ul></details>}
    {discovery.issues.map((issue, index) => <p className="import-error" key={index}>{issue.action}</p>)}
    {error && <p className="import-error" role="alert" data-error-code={error.code}>{error.action}</p>}
    <div className="import-step-actions">
      <button className="import-primary" type="button" disabled={busy || !selected.size} onClick={() => onStage([...selected])}>解析所选入口</button>
      {onCancel && <button className="import-secondary" type="button" disabled={busy} onClick={onCancel}>取消导入</button>}
    </div>
  </section>
}
