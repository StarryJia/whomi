import { useEffect, useId, useRef, useState } from 'react'
import type { ConversationSummary, DesktopApi, DesktopError, ImportPreview } from '../../shared/desktop-api'
import type { Candidate, Discovery, TargetDecision } from '../../shared/import-contract'
import { importError } from '../../data/use-import'

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
    <p className="import-muted">已发现 {discovery.entries.length} 个文件入口，解析后可确认会话和成员。</p>
    <ul className="import-entries">{discovery.entries.map(entry => <li key={entry.entryId}><label>
      <input type="checkbox" checked={selected.has(entry.entryId)} disabled={busy}
        onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(entry.entryId); else next.delete(entry.entryId); return next })} />
      <span>{entry.displayName}<small>{entry.formatId}</small></span>
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

type Choice = { target: string; aliasKey: string; accountKey: string }
function CandidateChoice({ candidate, choice, targets, onChange, preview }: {
  candidate: Candidate; choice: Choice; targets: ConversationSummary[]; onChange: (value: Choice) => void
  preview: (candidateId: string, after?: number) => Promise<ImportPreview | null>
}) {
  const targetId = useId(), aliasId = useId(), accountId = useId()
  const [page, setPage] = useState<ImportPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const blocked = candidate.status !== 'staged' || candidate.issues.some(issue => issue.severity === 'blocking')
  async function showPreview(after?: number) {
    setLoading(true)
    const next = await preview(candidate.candidateId, after)
    if (mounted.current) { setPage(next); setLoading(false) }
  }
  const existing = targets.find(target => `existing:${target.id}` === choice.target)
  return <fieldset className="import-candidate" disabled={blocked}>
    <legend>{candidate.title || '未命名会话'}</legend>
    <p className="import-muted">有效记录 {candidate.counts.validRecords} 条 · 异常 {candidate.counts.invalidRecords} 条 · 成员 {candidate.members.length} 名</p>
    {candidate.issues.map((issue, index) => <p className="import-error" key={index}>{issue.action}</p>)}
    {!blocked && <>
      <div className="import-field"><label htmlFor={targetId}>导入目标</label>
        <select id={targetId} value={choice.target} onChange={event => onChange({ ...choice, target: event.target.value })}>
          <option value="">请选择导入目标</option><option value="new">新建会话</option>
          {targets.map(target => <option key={target.id} value={`existing:${target.id}`}>{target.title || '未命名会话'} · 编号 {target.id}</option>)}
        </select>
      </div>
      {existing && <p className="import-target-confirm">将保存到：{existing.title || '未命名会话'}</p>}
      <details><summary>确认账号别名</summary>
        <p className="import-muted">仅在确认两个账号属于同一人时填写。来源账号：{candidate.identity.ownerKey ?? '未知'}。</p>
        <div className="import-field"><label htmlFor={aliasId}>来源账号</label><input id={aliasId} value={choice.aliasKey} onChange={event => onChange({ ...choice, aliasKey: event.target.value })} /></div>
        <div className="import-field"><label htmlFor={accountId}>对应账号</label><input id={accountId} value={choice.accountKey} onChange={event => onChange({ ...choice, accountKey: event.target.value })} /></div>
      </details>
      <button className="import-secondary" type="button" disabled={loading} onClick={() => { void showPreview() }}>预览消息</button>
      {loading && <p role="status">正在加载预览…</p>}
      {page && <div className="import-preview" aria-label={`${candidate.title} 消息预览`}>
        <p className="import-muted">{page.nextOrdinal !== null ? '消息预览 · 每页最多 50 条 · 尚未保存' : '消息预览 · 尚未保存'}</p>
        <ol>{page.messages.map(message => <li key={message.ordinal}>
          <small>{message.senderName || (message.senderKind === 'system' ? '系统消息' : '未知发送者')} · {message.sentAtMs !== null ? new Date(message.sentAtMs).toLocaleString() : (message.timeRaw || '时间未知')}</small>
          <p>{message.text || `［${message.kind}］`}</p>
          {message.attachments.map((item, index) => <small key={index}>附件：{item.name || item.kind} · {item.state === 'missing' ? '文件缺失' : '未读取'}</small>)}
        </li>)}</ol>
        {page.nextOrdinal !== null && <button type="button" className="import-secondary" disabled={loading} onClick={() => { void showPreview(page.nextOrdinal!) }}>下一页预览</button>}
      </div>}
    </>}
  </fieldset>
}

export function ImportCandidates({ api, candidates, busy, onCommit, preview, onCancel, error: externalError }: {
  api: DesktopApi; candidates: Candidate[]; busy: boolean
  onCommit: (decisions: TargetDecision[]) => void; preview: (id: string, after?: number) => Promise<ImportPreview | null>
  onCancel?: () => void; error?: DesktopError | null
}) {
  const [choices, setChoices] = useState<Record<string, Choice>>({})
  const [targets, setTargets] = useState<ConversationSummary[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<DesktopError | null>(null)
  const alive = useRef(true)
  async function loadTargets(after?: string) {
    setLoading(true); setError(null)
    try {
      const page = await api.listConversations({ limit: 200, ...(after ? { cursor: after } : {}) })
      if (alive.current) { setTargets(previous => after ? [...previous, ...page.items.filter(item => !previous.some(old => old.id === item.id))] : page.items); setCursor(page.nextCursor) }
    } catch (value) { if (alive.current) setError(importError(value)) }
    finally { if (alive.current) setLoading(false) }
  }
  useEffect(() => { alive.current = true; void loadTargets(); return () => { alive.current = false } }, [api]) // eslint-disable-line react-hooks/exhaustive-deps
  const choiceFor = (id: string): Choice => choices[id] ?? { target: '', aliasKey: '', accountKey: '' }
  function save() {
    const eligible = candidates.filter(candidate => candidate.status === 'staged' && !candidate.issues.some(issue => issue.severity === 'blocking'))
    if (eligible.some(candidate => !choiceFor(candidate.candidateId).target)) { setError({ code: 'TARGET_REQUIRED', action: '请选择导入目标。' }); return }
    const decisions: TargetDecision[] = []
    for (const candidate of eligible) {
      const choice = choiceFor(candidate.candidateId)
      if ((choice.aliasKey || choice.accountKey) && (!choice.aliasKey || !choice.accountKey || choice.aliasKey === choice.accountKey)) {
        setError({ code: 'ALIAS_REQUIRED', action: '请填写两个不同的账号，或清空账号别名。' }); return
      }
      decisions.push({ candidateId: candidate.candidateId,
        target: choice.target === 'new' ? { kind: 'new' } : { kind: 'existing', conversationId: choice.target.slice(9) },
        confirmedAliases: choice.aliasKey ? [{ platform: candidate.identity.platform, aliasKey: choice.aliasKey, accountKey: choice.accountKey }] : [] })
    }
    setError(null); onCommit(decisions)
  }
  return <section className="import-step" aria-label="确认会话">
    <h2>确认后保存</h2>
    {candidates.map(candidate => <CandidateChoice key={candidate.candidateId} candidate={candidate} choice={choiceFor(candidate.candidateId)} targets={targets}
      onChange={choice => setChoices(previous => ({ ...previous, [candidate.candidateId]: choice }))} preview={preview} />)}
    {error && <p className="import-error" role="alert">{error.action}</p>}
    {externalError && <p className="import-error" role="alert" data-error-code={externalError.code}>{externalError.action}</p>}
    {loading && <p className="import-muted" role="status">正在加载已有会话…</p>}
    {cursor && <button className="import-secondary" type="button" disabled={loading} onClick={() => { void loadTargets(cursor) }}>加载更多已有会话</button>}
    {error && error.code !== 'TARGET_REQUIRED' && <button type="button" className="import-secondary" disabled={loading} onClick={() => { void loadTargets() }}>重新加载已有会话</button>}
    <div className="import-step-actions">
      <button className="import-primary" type="button" disabled={busy || !candidates.some(candidate => candidate.status === 'staged' && !candidate.issues.some(issue => issue.severity === 'blocking'))} onClick={save}>确认保存</button>
      {onCancel && <button className="import-secondary" type="button" disabled={busy} onClick={onCancel}>取消导入</button>}
    </div>
  </section>
}
