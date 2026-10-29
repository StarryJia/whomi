import { useId } from 'react'
import type { Candidate, TargetDecision } from '../../shared/import-contract'

export function IdentityChoice({ candidate, value, onChange }: {
  candidate: Candidate; value: TargetDecision['selfMemberKey']; onChange: (key: string | null | undefined) => void
}) {
  const id = useId()
  return <div className="import-field">
    <label htmlFor={id}>本人身份</label>
    <select id={id} value={value === undefined ? 'reuse' : value === null ? 'none' : `member:${value}`}
      onChange={event => onChange(event.target.value === 'reuse' ? undefined : event.target.value === 'none' ? null : event.target.value.slice(7))}>
      <option value="reuse">沿用已确认身份，未确认时保留来源名</option>
      <option value="none">本次不指定本人</option>
      {candidate.members.map(member => <option key={member.sourceKey} value={`member:${member.sourceKey}`}>
        {member.displayName || '未命名成员'} · {member.sourceKey}{member.selfHint === true ? ' · 来源提示本人' : ''}
      </option>)}
    </select>
  </div>
}
