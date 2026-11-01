import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, Eye, EyeOff, ImagePlus, RotateCcw } from 'lucide-react'
import * as Select from '@radix-ui/react-select'
import type { Provider, ProviderEndpoints, ProviderInput } from '../../shared/settings-contract'
import { defaultModelProtocol, isModelProtocol, isValidModelBaseUrl, modelProtocolLabels, modelProtocols, modelRequestPreview, type ModelProtocol } from '../../shared/model-protocol'
import { cherryProviderPresets, type CherryProviderPreset } from '../../vendor/cherry-providers'
import { cherryProviderIcon } from '../../vendor/cherry-providers/icons'
import { changePresetProtocol } from './provider-presets'
import './provider-form.css'

export function ProtocolSelect({ value, onChange, disabled = false, id, choices = modelProtocols }: { value?: ModelProtocol; onChange: (value: ModelProtocol) => void; disabled?: boolean; id?: string; choices?: readonly ModelProtocol[] }) {
  return <Select.Root value={value ?? defaultModelProtocol} onValueChange={value => { if (isModelProtocol(value)) onChange(value) }} disabled={disabled}>
    <Select.Trigger id={id} className="ms-protocol-trigger" aria-label="连接协议"><Select.Value /><Select.Icon><ChevronDown size={14} /></Select.Icon></Select.Trigger>
    <Select.Portal><Select.Content className="ms-protocol-menu cherry-context-menu" position="popper" sideOffset={4} onEscapeKeyDown={event => event.stopPropagation()}><Select.Viewport>
      {choices.map(protocol => <Select.Item key={protocol} value={protocol} className="cherry-menu-item ms-protocol-option"><Select.ItemText>{modelProtocolLabels[protocol]}</Select.ItemText><Select.ItemIndicator><Check size={14} /></Select.ItemIndicator></Select.Item>)}
    </Select.Viewport></Select.Content></Select.Portal>
  </Select.Root>
}

export function providerErrors(input: ProviderInput) {
  const errors: Record<string, string> = {}
  if (input.protocol !== undefined && !isModelProtocol(input.protocol)) errors.protocol = '请选择连接协议。'
  if (!input.name.trim()) errors.name = '请输入服务商名称。'
  try {
    const url = new URL(input.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) errors.baseUrl = '请输入不含账号密码的 http:// 或 https:// 地址。'
    else if (url.search || url.hash) errors.baseUrl = '请移除地址中的查询参数和片段。'
    else if (input.baseUrl.length > 2048) errors.baseUrl = '接口地址不能超过 2048 个字符。'
  }
  catch { errors.baseUrl = '请输入完整接口地址。' }
  for (const [type, url] of Object.entries(input.endpointUrls ?? {})) {
    if (!isValidModelBaseUrl(url)) errors[type] = '请输入有效的接口地址。'
  }
  return errors
}

// Adapted from Cherry Studio f19aa72 ProviderEditorDrawer and customProviderCreation (AGPL-3.0).
const endpointNames: Record<ModelProtocol, string> = {
  'openai-completions': 'OpenAI', 'anthropic-messages': 'Anthropic',
  'openai-responses': 'OpenAI Responses', 'google-generative-ai': 'Google Gemini',
}
function CustomEndpoints({ draft, onChange, errors }: { draft: ProviderInput; onChange: (value: ProviderInput) => void; errors: Record<string, string> }) {
  const prefix = useId()
  const current = draft.protocol ?? defaultModelProtocol
  const urls: ProviderEndpoints = draft.endpointUrls ?? (draft.baseUrl ? { [current]: draft.baseUrl } : {})
  const configured = modelProtocols.filter(type => urls[type]?.trim())
  const [expanded, setExpanded] = useState(false)
  useEffect(() => { if (errors['openai-responses'] || errors['google-generative-ai']) setExpanded(true) }, [errors])
  function updateEndpoint(type: ModelProtocol, value: string) {
    const next = { ...urls }
    if (value.trim()) next[type] = value
    else delete next[type]
    const protocol = next[current] ? current : modelProtocols.find(item => next[item]) ?? defaultModelProtocol
    onChange({ ...draft, protocol, baseUrl: next[protocol] ?? '', endpointUrls: next })
  }
  function field(type: ModelProtocol) {
    const name = endpointNames[type], id = prefix + type, value = urls[type] ?? ''
    const preview = modelRequestPreview(value, type)
    const error = errors[type] ?? (errors.baseUrl && !configured.length && type === defaultModelProtocol ? '请填写至少一个文本端点。' : '')
    return <div className="ms-field custom-endpoint" key={type}>
      <div className="custom-endpoint-label"><label htmlFor={id}>{name}</label>
        {configured.length > 1 && value && (current === type ? <span>默认</span> : <button type="button" className="ms-text-button" aria-label={`将 ${name} 设为默认`} onClick={() => onChange({ ...draft, protocol: type, baseUrl: value, endpointUrls: urls })}>设为默认</button>)}</div>
      <input type="url" id={id} value={value} placeholder="Base URL：https://example.com" onChange={event => updateEndpoint(type, event.target.value)}
        aria-invalid={!!error} aria-describedby={id + '-help'} />
      <p id={id + '-help'} className={error ? 'ms-error' : 'ms-hint'} role={error ? 'alert' : undefined}>{error || preview || '填写接口根地址后会显示实际请求路径'}</p>
    </div>
  }
  return <section aria-label="端点设置" className="custom-endpoints">
    <h3>端点设置</h3>{field('openai-completions')}{field('anthropic-messages')}
    <button type="button" className="custom-endpoint-more" aria-expanded={expanded} aria-controls={prefix + '-more'} onClick={() => setExpanded(open => !open)}>更多设置<ChevronDown size={15} /></button>
    <div id={prefix + '-more'} hidden={!expanded}>{field('openai-responses')}{field('google-generative-ai')}</div>
  </section>
}

export function ProviderForm({ draft, provider, preset, errors, onChange, busy }: { draft: ProviderInput; provider?: Provider; preset?: CherryProviderPreset; errors: Record<string, string>; onChange: (input: ProviderInput) => void; busy: boolean }) {
  const prefix = useId()
  const fileGeneration = useRef(0)
  const latestDraft = useRef(draft)
  latestDraft.current = draft
  useEffect(() => () => { fileGeneration.current++ }, [])
  const [showKey, setShowKey] = useState(false)
  const [imageError, setImageError] = useState('')
  const [picking, setPicking] = useState(false)
  const upload = useRef<HTMLInputElement>(null)
  const avatarSection = useRef<HTMLDivElement>(null)
  const pickButton = useRef<HTMLButtonElement>(null)
  const avatar = draft.image || cherryProviderIcon(draft.avatarId ?? preset?.id ?? '')
  useEffect(() => {
    if (!picking) return
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !avatarSection.current?.contains(event.target)) setPicking(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [picking])
  const edit = (key: keyof ProviderInput, value: unknown) => onChange({ ...draft, [key]: value })
  function imageSelected(file?: File) {
    const generation = ++fileGeneration.current
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setImageError('请选择 PNG、JPEG 或 WebP 图片。'); return }
    if (file.size > 1024 * 1024) { setImageError('请选择不超过 1 MB 的图片。'); return }
    const reader = new FileReader()
    reader.onload = () => { if (generation === fileGeneration.current) { onChange({ ...latestDraft.current, avatarId: undefined, image: String(reader.result) }); setImageError('') } }
    reader.onerror = () => { if (generation === fileGeneration.current) setImageError('图片读取失败，请重新选择。') }
    reader.readAsDataURL(file)
  }
  return <fieldset className="ms-form ms-connection settings-fieldset" disabled={busy}>
    <div ref={avatarSection} className="custom-avatar" onKeyDown={event => {
      if (picking && event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); setPicking(false); pickButton.current?.focus() }
    }}>
      <div className="custom-avatar-preview">{avatar ? <img src={avatar} alt="已选服务商图片" /> : <span aria-label="默认头像">{Array.from(draft.name.trim())[0]?.toUpperCase() || 'P'}</span>}</div>
      <div className="custom-avatar-tools">
        <button type="button" className="ms-button" onClick={() => { setPicking(false); upload.current?.click() }}><ImagePlus size={15} />图片上传</button>
        <button type="button" ref={pickButton} className="ms-button" aria-expanded={picking} aria-controls={prefix + '-avatars'} onClick={() => setPicking(show => !show)}>内置头像</button>
        <button type="button" className="ms-button" disabled={!draft.image && !draft.avatarId} onClick={() => {
          fileGeneration.current++; setImageError(''); setPicking(false); onChange({ ...draft, image: undefined, avatarId: undefined })
        }}><RotateCcw size={14} />重置头像</button>
      </div>
      {picking && <div className="custom-avatar-library" id={prefix + '-avatars'} role="group" aria-label="选择内置头像">{cherryProviderPresets.map(item => <button type="button" key={item.id} title={item.name} aria-label={`使用 ${item.name} 头像`} onClick={() => {
        fileGeneration.current++; setImageError(''); setPicking(false); onChange({ ...draft, image: undefined, avatarId: item.id }); pickButton.current?.focus()
      }}><img src={cherryProviderIcon(item.id)} alt="" /></button>)}</div>}
      <input ref={upload} hidden type="file" aria-label="服务商图片" accept="image/png,image/jpeg,image/webp" onChange={event => { imageSelected(event.target.files?.[0]); event.target.value = '' }} />
      {imageError && <p className="ms-error" role="alert">{imageError}</p>}
    </div>
    <div className="ms-field"><label htmlFor={`${prefix}-name`}>服务商名称<span aria-hidden="true" className="custom-required"> *</span></label><input id={`${prefix}-name`} aria-label="服务商名称" name="name" required placeholder="例如 OpenAI" value={draft.name} maxLength={100} onChange={event => edit('name', event.target.value)} aria-invalid={!!errors.name} aria-describedby={errors.name ? `${prefix}-name-error` : undefined} />{errors.name && <p id={`${prefix}-name-error`} className="ms-error" role="alert">{errors.name}</p>}</div>
    {preset && <><div className="ms-field"><label htmlFor={`${prefix}-protocol`}>连接协议</label><ProtocolSelect id={`${prefix}-protocol`} value={draft.protocol} disabled={busy} onChange={value => onChange(changePresetProtocol(draft, value, preset))} />{errors.protocol && <p className="ms-error" role="alert">{errors.protocol}</p>}</div>
    <div className="ms-field"><label htmlFor={`${prefix}-address`}>接口地址</label><input id={`${prefix}-address`} name="baseUrl" type="url" value={draft.baseUrl} placeholder={draft.protocol === 'google-generative-ai' ? 'https://api.example.com/v1beta' : draft.protocol === 'anthropic-messages' ? 'https://api.example.com' : 'https://api.example.com/v1'} onChange={event => edit('baseUrl', event.target.value)} aria-invalid={!!errors.baseUrl} aria-describedby={errors.baseUrl ? `${prefix}-address-error` : undefined} />{errors.baseUrl && <p id={`${prefix}-address-error`} className="ms-error" role="alert">{errors.baseUrl}</p>}</div>
    </>}
    <div className="ms-field"><label htmlFor={`${prefix}-key`}>{provider?.hasCredential ? '替换密钥' : preset ? '密钥' : 'API 密钥'}</label>
      {provider?.hasCredential && <p className="ms-hint">{draft.apiKey === null ? '保存后清除密钥。' : '已保存密钥。'}</p>}
      <div className="settings-key"><input id={`${prefix}-key`} type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={draft.apiKey ?? ''} onChange={event => edit('apiKey', event.target.value || undefined)} placeholder={provider?.hasCredential ? '留空保留已存密钥' : '无需认证时可留空'} /><button type="button" className="ms-icon" aria-label={showKey ? '隐藏输入的密钥' : '显示输入的密钥'} onClick={() => setShowKey(value => !value)}>{showKey ? <EyeOff size={18} /> : <Eye size={18} />}</button></div>
      {provider?.hasCredential && <button type="button" className="ms-text-button settings-fit" onClick={() => edit('apiKey', draft.apiKey === null ? undefined : null)}>{draft.apiKey === null ? '保留已存密钥' : '清除密钥'}</button>}
    </div>
    {!preset && <CustomEndpoints draft={draft} onChange={onChange} errors={errors} />}
  </fieldset>
}
