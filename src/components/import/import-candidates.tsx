import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Candidate, DiscoveryEntry } from '../../shared/import-contract'

function nameChoices(candidates: readonly Candidate[], entries?: readonly DiscoveryEntry[]) {
  const sources = new Map(entries?.map(entry => [entry.entryId, entry.displayName]))
  const rows = candidates.map(candidate => ({
    id: candidate.candidateId,
    title: candidate.title.trim() || '未命名会话',
    source: sources.get(candidate.entryId) ?? '',
    detail: '',
  }))
  const byTitle = new Map<string, Array<typeof rows[number]>>()
  for (const row of rows) {
    const group = byTitle.get(row.title)
    if (group) group.push(row)
    else byTitle.set(row.title, [row])
  }
  for (const group of byTitle.values()) {
    if (group.length === 1) continue
    const bySource = new Map<string, Array<typeof rows[number]>>()
    for (const row of group) {
      const sameSource = bySource.get(row.source)
      if (sameSource) sameSource.push(row)
      else bySource.set(row.source, [row])
    }
    for (const [source, sameSource] of bySource) {
      sameSource.forEach((row, index) => {
        const position = sameSource.length > 1 ? `${index + 1} / ${sameSource.length}` : ''
        row.detail = [source, position].filter(Boolean).join(' · ')
      })
    }
  }
  return rows
}

export function ConversationChoices({ candidates, entries, busy, onImport, onCancel }: {
  candidates: readonly Candidate[]
  entries?: readonly DiscoveryEntry[]
  busy: boolean
  onImport: (ids: string[]) => void
  onCancel: () => void
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const choices = useMemo(() => nameChoices(candidates, entries), [candidates, entries])
  const titleId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  useLayoutEffect(() => { heading.current?.focus({ preventScroll: true }) }, [])

  function choose(id: string, checked: boolean) {
    setSelected(previous => {
      const next = new Set(previous)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  return <section className="import-step" aria-labelledby={titleId}>
    <h2 id={titleId} ref={heading} tabIndex={-1}>选择要导入的会话</h2>
    <ul className="import-entries">
      {choices.map(({ id, title, detail }) => <li key={id}>
        <label>
          <input type="checkbox" checked={selected.has(id)} disabled={busy}
            onChange={event => choose(id, event.target.checked)} />
          <span>{title}{detail && <small> {detail}</small>}</span>
        </label>
      </li>)}
    </ul>
    <div className="import-step-actions">
      <button className="import-primary" type="button" disabled={busy || !selected.size} onClick={() => onImport([...selected])}>
        导入所选会话
      </button>
      <button className="import-secondary" type="button" onClick={onCancel}>取消导入</button>
    </div>
  </section>
}
