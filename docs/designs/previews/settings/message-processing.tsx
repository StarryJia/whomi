import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronDown, Minus, Plus, X } from 'lucide-react'
import './message-processing.css'
import { keepDialogFocus } from './dialog-focus'

const ruleGroups = [
  { id: 'credentials', label: '密码与访问凭据', rules: [
    { id: 'key', label: '已知前缀的接口密钥' },
    { id: 'token', label: 'Bearer Token 授权令牌' },
  ] },
  { id: 'contact', label: '通用联系方式', rules: [
    { id: 'email', label: '电子邮箱' },
  ] },
  { id: 'finance', label: '通用金融信息', rules: [
    { id: 'credit-card', label: '信用卡号' },
  ] },
  { id: 'network', label: '通用网络信息', rules: [
    { id: 'ipv4', label: 'IPv4 地址' },
    { id: 'url', label: '网址' },
  ] },
  { id: 'china', label: '中国大陆', rules: [
    { id: 'mobile', label: '手机号' },
    { id: 'identity', label: '身份证号' },
    { id: 'bank-card', label: '银行卡号' },
    { id: 'landline', label: '座机号' },
  ] },
] as const

const initialRules = () => new Set<string>(['email', 'mobile'])

function Setting({ id, title, description, checked, onChange, children }: {
  id: string
  title: string
  description: string
  checked: boolean
  onChange: (next: boolean) => void
  children?: ReactNode
}) {
  return <section className="mp-setting">
    <div className="mp-setting-top">
      <div className="mp-setting-copy">
        <h3 id={`${id}-title`}>{title}</h3>
        <p id={`${id}-description`}>{description}</p>
      </div>
      <button type="button" className="mp-switch" role="switch" aria-checked={checked}
        aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
        onClick={() => onChange(!checked)}><span className="mp-switch-thumb" /></button>
    </div>
    {checked && children && <div className="mp-setting-detail">{children}</div>}
  </section>
}

function GroupSelection({ group, selected, expanded, onToggleGroup, onExpand, onToggleRule }: {
  group: typeof ruleGroups[number]
  selected: ReadonlySet<string>
  expanded: boolean
  onToggleGroup: () => void
  onExpand: () => void
  onToggleRule: (id: string) => void
}) {
  const checkbox = useRef<HTMLInputElement>(null)
  const count = group.rules.filter(rule => selected.has(rule.id)).length
  const partial = count > 0 && count < group.rules.length
  useEffect(() => {
    if (checkbox.current) checkbox.current.indeterminate = partial
  }, [partial])

  return <fieldset className="mp-rule-group">
    <legend className="mp-visually-hidden">{group.label}</legend>
    <div className="mp-rule-group-heading">
      <label className="mp-checkbox-label mp-group-label">
        <input ref={checkbox} type="checkbox" checked={count === group.rules.length}
          onChange={onToggleGroup} aria-describedby={`mp-${group.id}-count`} />
        <span>{group.label}</span>
      </label>
      <span className="mp-group-count" id={`mp-${group.id}-count`}>已选 {count}/{group.rules.length}</span>
      <button type="button" className="mp-icon-button" aria-label={`${expanded ? '收起' : '展开'}${group.label}`}
        aria-expanded={expanded} aria-controls={`mp-${group.id}-rules`} onClick={onExpand}>
        <ChevronDown size={18} aria-hidden="true" className={expanded ? 'mp-chevron-open' : undefined} />
      </button>
    </div>
    {expanded && <div className="mp-rule-items" id={`mp-${group.id}-rules`}>
      {group.rules.map(rule => <label className="mp-checkbox-label" key={rule.id}>
        <input type="checkbox" checked={selected.has(rule.id)} onChange={() => onToggleRule(rule.id)} />
        <span>{rule.label}</span>
      </label>)}
      {group.id === 'network' && <p className="mp-field-help">IPv4 指互联网协议第四版地址。</p>}
    </div>}
  </fieldset>
}

export function MessageProcessing() {
  const [clean, setClean] = useState(true)
  const [merge, setMerge] = useState(true)
  const [noise, setNoise] = useState(false)
  const [anonymous, setAnonymous] = useState(true)
  const [mask, setMask] = useState(true)
  const [seconds, setSeconds] = useState('180')
  const [selected, setSelected] = useState(initialRules)
  const [expanded, setExpanded] = useState(() => new Set(['contact', 'china']))
  const [notice, setNotice] = useState('')
  const restoreDialog = useRef<HTMLDialogElement>(null)
  const restoreButton = useRef<HTMLButtonElement>(null)
  const numericSeconds = Number(seconds)
  const validSeconds = seconds.trim() !== '' && Number.isSafeInteger(numericSeconds) && numericSeconds > 0

  function toggleRule(id: string) {
    setSelected(previous => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setNotice('')
  }

  function toggleGroup(group: typeof ruleGroups[number]) {
    setSelected(previous => {
      const next = new Set(previous)
      const allSelected = group.rules.every(rule => previous.has(rule.id))
      group.rules.forEach(rule => {
        if (allSelected) next.delete(rule.id)
        else next.add(rule.id)
      })
      return next
    })
    setNotice('')
  }

  function toggleExpanded(id: string) {
    setExpanded(previous => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return <div className="mp-page">
    <header className="mp-page-heading">
      <h1 tabIndex={-1}>消息处理</h1>
      <p>整理发送给模型的聊天材料，原始记录保持不变。</p>
    </header>
    <aside className="mp-preview-note" aria-label="预览说明">
      <strong>演示初始状态</strong>
      <p>以下开关、180 秒和规则选择仅供演示。默认状态、有效范围与保存方式待确认。</p>
    </aside>

    <div className="mp-content-section">
      <h2>整理材料</h2>
      <Setting id="mp-clean" title="数据清洗" description="整理分享卡片中的链接、小程序等内容。"
        checked={clean} onChange={setClean}>
        <details className="mp-help">
          <summary>哪些内容需要整理？</summary>
          <p>部分导出记录用 XML 保存分享卡片。XML 是一种结构化文本格式，整理后可减少不便阅读的标记。</p>
        </details>
      </Setting>
      <Setting id="mp-merge" title="合并连续发言" description="合并同一说话者在短时间内连续发送的消息。"
        checked={merge} onChange={setMerge}>
        <label htmlFor="mp-seconds" className="mp-field-label">合并时间窗口</label>
        <div className="mp-number-field">
          <button type="button" className="mp-icon-button" aria-label="减少合并时间窗口 1 秒"
            disabled={!validSeconds || numericSeconds <= 1} onClick={() => setSeconds(String(numericSeconds - 1))}>
            <Minus size={16} aria-hidden="true" />
          </button>
          <input id="mp-seconds" type="number" inputMode="numeric" min={1} step={1} value={seconds}
            aria-invalid={!validSeconds} aria-describedby="mp-seconds-help mp-seconds-error"
            onChange={event => setSeconds(event.target.value)} />
          <span aria-hidden="true">秒</span>
          <button type="button" className="mp-icon-button" aria-label="增加合并时间窗口 1 秒"
            disabled={!validSeconds || numericSeconds >= Number.MAX_SAFE_INTEGER}
            onClick={() => setSeconds(String(numericSeconds + 1))}>
            <Plus size={16} aria-hidden="true" />
          </button>
        </div>
        <p id="mp-seconds-help" className="mp-field-help">每次增减 1 秒，最小 1 秒。</p>
        <p id="mp-seconds-error" className="mp-error" role="status">{!validSeconds ? '请输入大于 0 的整数秒数。' : ''}</p>
      </Setting>
      <Setting id="mp-noise" title="智能去噪" description="过滤可能无效的语气词、纯表情或系统占位消息。可能减少分析材料，语气和表情也可能影响理解。"
        checked={noise} onChange={setNoise} />
    </div>

    <div className="mp-content-section">
      <h2>隐私处理</h2>
      <Setting id="mp-anonymous" title="昵称匿名化" description="在发送给模型的材料中，用 U1、U2 等编号代替真实昵称。"
        checked={anonymous} onChange={setAnonymous}>
        <p className="mp-field-help">原始聊天仍显示原昵称，说话者和原文证据的对应关系保持不变。</p>
      </Setting>
      <Setting id="mp-mask" title="数据脱敏" description="替换所选类型的敏感信息。"
        checked={mask} onChange={setMask}>
        <div className="mp-rules-toolbar">
          <span className="mp-selected-count" aria-live="polite">已选 {selected.size}/10 项</span>
          <button ref={restoreButton} type="button" className="mp-text-button"
            onClick={() => { restoreDialog.current?.showModal(); restoreDialog.current?.querySelector<HTMLButtonElement>('[data-cancel]')?.focus() }}>恢复演示选择</button>
        </div>
        <div className="mp-rule-list">
          {ruleGroups.map(group => <GroupSelection key={group.id} group={group} selected={selected}
            expanded={expanded.has(group.id)} onToggleGroup={() => toggleGroup(group)}
            onExpand={() => toggleExpanded(group.id)} onToggleRule={toggleRule} />)}
        </div>
        <p className="mp-caution">脱敏不保证识别全部敏感信息。使用云模型前，仍需确认发送哪些数据。</p>
        <p className="mp-status" role="status">{notice}</p>
      </Setting>
    </div>

    <dialog ref={restoreDialog} className="mp-dialog" aria-labelledby="mp-restore-title" onKeyDown={keepDialogFocus}
      aria-describedby="mp-restore-description" onClose={() => restoreButton.current?.focus()}
      onClick={event => { if (event.target === event.currentTarget) restoreDialog.current?.close() }}>
      <div className="mp-dialog-content">
        <div className="mp-dialog-titlebar">
          <h2 id="mp-restore-title">恢复规则选择</h2>
          <button type="button" className="mp-icon-button" aria-label="关闭恢复规则选择"
            onClick={() => restoreDialog.current?.close()}><X size={20} aria-hidden="true" /></button>
        </div>
        <p id="mp-restore-description">默认规则尚未确认。本预览可恢复为演示初始选择：电子邮箱、手机号。</p>
        <p>只调整规则选择，其余开关与合并时间保持不变。</p>
        <div className="mp-dialog-actions">
          <button type="button" className="mp-secondary-button" data-cancel onClick={() => restoreDialog.current?.close()}>取消</button>
          <button type="button" className="mp-primary-button" onClick={() => {
            setSelected(initialRules())
            setNotice('规则已恢复为演示初始选择。')
            restoreDialog.current?.close()
          }}>恢复演示初始选择</button>
        </div>
      </div>
    </dialog>
  </div>
}
