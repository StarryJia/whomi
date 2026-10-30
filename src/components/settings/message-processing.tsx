import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Minus, Plus } from 'lucide-react'
import { defaultProcessing, type ProcessingSettings, type RedactionRule, type SettingsApi } from '../../shared/settings-contract'
import { CheckBox, errorText, Modal, Switch } from './common'

const ruleGroups = [
  { id: 'credentials', label: '密码与访问凭据', rules: [{ id: 'key', label: '已知前缀的接口密钥' }, { id: 'token', label: 'Bearer 授权令牌' }] },
  { id: 'contact', label: '通用联系方式', rules: [{ id: 'email', label: '电子邮箱' }] },
  { id: 'finance', label: '通用金融信息', rules: [{ id: 'credit-card', label: '信用卡号' }] },
  { id: 'network', label: '通用网络信息', rules: [{ id: 'ipv4', label: '互联网协议第四版地址' }, { id: 'url', label: '网址' }] },
  { id: 'china', label: '中国大陆', rules: [{ id: 'mobile', label: '手机号' }, { id: 'identity', label: '身份证号' }, { id: 'bank-card', label: '银行卡号' }, { id: 'landline', label: '座机号' }] },
] as const

function Setting({ title, description, checked, busy, onChange, children }: { title: string; description: string; checked: boolean; busy: boolean; onChange: () => void; children?: ReactNode }) {
  return <section className="mp-setting"><div className="mp-setting-top"><div className="mp-setting-copy"><h3>{title}</h3><p>{description}</p></div><Switch label={title} checked={checked} disabled={busy} onChange={onChange} /></div>{checked && children && <div className="mp-setting-detail">{children}</div>}</section>
}

export function MessageProcessing({ api, value, onSaved, onBusy }: { api: SettingsApi; value: ProcessingSettings; onSaved: (next: ProcessingSettings) => void; onBusy: (busy: boolean) => void }) {
  const [current, setCurrent] = useState(value)
  const [seconds, setSeconds] = useState(String(value.mergeSeconds))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [failed, setFailed] = useState<ProcessingSettings | null>(null)
  const [restore, setRestore] = useState(false)
  const [expanded, setExpanded] = useState(new Set(['contact', 'china']))
  const saved = useRef(value)
  const saving = useRef(false)
  useEffect(() => { onBusy(busy); return () => onBusy(false) }, [busy, onBusy])
  const numericSeconds = Number(seconds)
  const validSeconds = seconds.trim() !== '' && Number.isSafeInteger(numericSeconds) && numericSeconds >= 1 && numericSeconds <= 600
  async function save(next: ProcessingSettings) {
    if (saving.current) return
    saving.current = true; setBusy(true); setError(''); setFailed(null); setCurrent(next)
    try { const result = await api.saveProcessing(next); saved.current = result; setCurrent(result); setSeconds(String(result.mergeSeconds)); onSaved(result) }
    catch (cause) { setCurrent(saved.current); setSeconds(String(saved.current.mergeSeconds)); setFailed(next); setError(errorText(cause, '保存失败，请重试。')) }
    finally { saving.current = false; setBusy(false) }
  }
  const toggle = (key: 'clean' | 'merge' | 'denoise' | 'anonymize' | 'redact') => void save({ ...current, [key]: !current[key] })
  const toggleRule = (rule: RedactionRule) => void save({ ...current, rules: current.rules.includes(rule) ? current.rules.filter(item => item !== rule) : [...current.rules, rule] })
  function saveSeconds() { if (validSeconds && numericSeconds !== current.mergeSeconds) void save({ ...current, mergeSeconds: numericSeconds }) }
  return <div className="mp-page"><header className="mp-page-heading"><h1 tabIndex={-1}>消息处理</h1><p>在发送给模型前整理聊天内容、处理隐私信息，聊天原文不变。</p></header>
    {error && <div className="settings-save-error" role="alert"><p className="ms-error">{error}</p>{failed && <button className="ms-button" disabled={busy} onClick={() => void save(failed)}>重试保存</button>}</div>}
    <span className="mp-visually-hidden" role="status">{busy ? '正在保存…' : ''}</span>
    <div className="mp-content-section"><h2>整理材料</h2>
      <Setting title="数据清洗" description="整理分享卡片中的链接、小程序等内容。" checked={current.clean} busy={busy} onChange={() => toggle('clean')} />
      <Setting title="合并连续发言" description="将同一人接连发送的文字合为一段，减少重复的姓名和时间。" checked={current.merge} busy={busy} onChange={() => toggle('merge')}>
        <label htmlFor="settings-merge-seconds" className="mp-field-label">合并时间窗口</label><div className="mp-number-field"><button type="button" className="mp-icon-button" aria-label="减少合并时间窗口 1 秒" disabled={busy || !validSeconds || numericSeconds <= 1} onClick={() => { const next = numericSeconds - 1; setSeconds(String(next)); void save({ ...current, mergeSeconds: next }) }}><Minus size={16} /></button><input id="settings-merge-seconds" type="number" inputMode="numeric" min={1} max={600} step={1} value={seconds} disabled={busy} aria-invalid={!validSeconds} aria-describedby="settings-merge-help" onChange={event => setSeconds(event.target.value)} onBlur={saveSeconds} onKeyDown={event => { if (event.key === 'Enter') saveSeconds() }} /><span>秒</span><button type="button" className="mp-icon-button" aria-label="增加合并时间窗口 1 秒" disabled={busy || !validSeconds || numericSeconds >= 600} onClick={() => { const next = numericSeconds + 1; setSeconds(String(next)); void save({ ...current, mergeSeconds: next }) }}><Plus size={16} /></button></div>
        <p id="settings-merge-help" className={validSeconds ? 'mp-field-help' : 'mp-error'} role={validSeconds ? undefined : 'alert'}>{validSeconds ? '相邻消息间隔不超过此时长时合并，范围 1～600 秒。' : '请输入 1～600 的整数秒数。'}</p>
      </Setting>
      <Setting title="智能去噪" description="过滤空内容和没有正文的系统占位消息，保留语气、否定和表情。" checked={current.denoise} busy={busy} onChange={() => toggle('denoise')} />
    </div><div className="mp-content-section"><h2>隐私处理</h2>
      <Setting title="昵称匿名化" description="在发送给模型的材料中，用人物编号代替真实昵称。" checked={current.anonymize} busy={busy} onChange={() => toggle('anonymize')}><p className="mp-field-help">原始聊天仍显示原昵称，可通过原文证据回查。</p></Setting>
      <Setting title="数据脱敏" description="替换所选类型的敏感信息。" checked={current.redact} busy={busy} onChange={() => toggle('redact')}>
        <div className="mp-rules-toolbar"><span className="mp-selected-count" aria-live="polite">已选 {current.rules.length}/10 项</span><button className="mp-text-button" disabled={busy} onClick={() => setRestore(true)}>恢复默认规则</button></div>
        <div className="mp-rule-list">{ruleGroups.map(group => {
          const count = group.rules.filter(rule => current.rules.includes(rule.id)).length
          return <fieldset className="mp-rule-group" key={group.id} disabled={busy}><legend className="mp-visually-hidden">{group.label}</legend><div className="mp-rule-group-heading"><CheckBox checked={count === group.rules.length} mixed={count > 0 && count < group.rules.length} disabled={busy} onChange={() => { const ids = new Set<RedactionRule>(group.rules.map(rule => rule.id)); void save({ ...current, rules: count === group.rules.length ? current.rules.filter(rule => !ids.has(rule)) : [...new Set([...current.rules, ...ids])] }) }}>{group.label}</CheckBox><span className="mp-group-count">已选 {count}/{group.rules.length}</span><button className="mp-icon-button" aria-label={`${expanded.has(group.id) ? '收起' : '展开'}${group.label}`} aria-expanded={expanded.has(group.id)} aria-controls={`settings-rules-${group.id}`} onClick={() => setExpanded(previous => { const next = new Set(previous); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next })}><ChevronDown size={18} className={expanded.has(group.id) ? 'mp-chevron-open' : undefined} /></button></div>{expanded.has(group.id) && <div className="mp-rule-items" id={`settings-rules-${group.id}`}>{group.rules.map(rule => <CheckBox key={rule.id} checked={current.rules.includes(rule.id)} disabled={busy} onChange={() => toggleRule(rule.id)}>{rule.label}</CheckBox>)}</div>}</fieldset>
        })}</div><p className="mp-caution">脱敏不保证识别全部敏感信息。使用云模型前，仍需确认发送哪些数据。</p>
      </Setting>
    </div>
    {restore && <Modal title="恢复默认规则" onClose={() => setRestore(false)} busy={busy}><div className="ms-modal-body"><p>恢复默认的 8 项规则？</p><p>将选中除网络地址和网址以外的全部规则。其他开关和合并时间保持不变。</p></div><footer className="ms-modal-footer"><button className="ms-button" onClick={() => setRestore(false)}>取消</button><button className="ms-button ms-primary" onClick={() => { setRestore(false); void save({ ...current, rules: [...defaultProcessing.rules] }) }}>确认恢复</button></footer></Modal>}
  </div>
}
