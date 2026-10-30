import { useEffect, useId, useRef, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import type { Provider, ProviderInput } from '../../shared/settings-contract'

export function providerErrors(input: ProviderInput) {
  const errors: Record<string, string> = {}
  if (!input.name.trim()) errors.name = '请输入服务商名称。'
  try {
    const url = new URL(input.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) errors.baseUrl = '请输入不含账号密码的 http:// 或 https:// 地址。'
    else if (url.search || url.hash) errors.baseUrl = '请移除地址中的查询参数和片段。'
    else if (input.baseUrl.length > 2048) errors.baseUrl = '接口地址不能超过 2048 个字符。'
  }
  catch { errors.baseUrl = '请输入完整接口地址。' }
  return errors
}

export function ProviderForm({ draft, provider, errors, onChange, busy }: { draft: ProviderInput; provider?: Provider; errors: Record<string, string>; onChange: (input: ProviderInput) => void; busy: boolean }) {
  const prefix = useId()
  const fileGeneration = useRef(0)
  const latestDraft = useRef(draft)
  latestDraft.current = draft
  useEffect(() => () => { fileGeneration.current++ }, [])
  const [showKey, setShowKey] = useState(false)
  const [imageError, setImageError] = useState('')
  const edit = (key: keyof ProviderInput, value: unknown) => onChange({ ...draft, [key]: value })
  function imageSelected(file?: File) {
    const generation = ++fileGeneration.current
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setImageError('请选择 PNG、JPEG 或 WebP 图片。'); return }
    if (file.size > 1024 * 1024) { setImageError('请选择不超过 1 MB 的图片。'); return }
    const reader = new FileReader()
    reader.onload = () => { if (generation === fileGeneration.current) { onChange({ ...latestDraft.current, image: String(reader.result) }); setImageError('') } }
    reader.onerror = () => setImageError('图片读取失败，请重新选择。')
    reader.readAsDataURL(file)
  }
  return <fieldset className="ms-form ms-connection settings-fieldset" disabled={busy}>
    <legend className="settings-section-title">连接配置</legend>
    <div className="ms-form-pair"><div className="ms-field"><label htmlFor={`${prefix}-name`}>服务商名称</label><input id={`${prefix}-name`} name="name" value={draft.name} maxLength={100} onChange={event => edit('name', event.target.value)} aria-invalid={!!errors.name} aria-describedby={errors.name ? `${prefix}-name-error` : undefined} />{errors.name && <p id={`${prefix}-name-error`} className="ms-error" role="alert">{errors.name}</p>}</div>
      <div className="ms-field"><span className="ms-field-label" id={`${prefix}-protocol`}>连接协议</span><p className="ms-static-value" aria-labelledby={`${prefix}-protocol`}>OpenAI Chat Completions 兼容</p></div></div>
    <div className="ms-field"><label htmlFor={`${prefix}-address`}>接口地址</label><input id={`${prefix}-address`} name="baseUrl" type="url" value={draft.baseUrl} placeholder="https://api.example.com/v1" onChange={event => edit('baseUrl', event.target.value)} aria-invalid={!!errors.baseUrl} aria-describedby={errors.baseUrl ? `${prefix}-address-error` : undefined} />{errors.baseUrl && <p id={`${prefix}-address-error`} className="ms-error" role="alert">{errors.baseUrl}</p>}</div>
    <div className="ms-field"><label htmlFor={`${prefix}-key`}>{provider?.hasCredential ? '替换密钥' : '密钥'}</label>
      {provider?.hasCredential && <p className="ms-hint">{draft.apiKey === null ? '保存后清除密钥。' : '已保存密钥。'}</p>}
      <div className="settings-key"><input id={`${prefix}-key`} type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={draft.apiKey ?? ''} onChange={event => edit('apiKey', event.target.value || undefined)} placeholder={provider?.hasCredential ? '留空保留已存密钥' : '无需认证时可留空'} /><button type="button" className="ms-icon" aria-label={showKey ? '隐藏输入的密钥' : '显示输入的密钥'} onClick={() => setShowKey(value => !value)}>{showKey ? <EyeOff size={18} /> : <Eye size={18} />}</button></div>
      {provider?.hasCredential && <button type="button" className="ms-text-button settings-fit" onClick={() => edit('apiKey', draft.apiKey === null ? undefined : null)}>{draft.apiKey === null ? '保留已存密钥' : '清除密钥'}</button>}
    </div>
    <div className="ms-field"><label htmlFor={`${prefix}-image`}>服务商图片<span className="ms-optional">可选</span></label><div className="ms-image-picker">{draft.image && <img className="ms-provider-image" src={draft.image} alt="已选服务商图片" />}<input id={`${prefix}-image`} type="file" accept="image/png,image/jpeg,image/webp" onChange={event => imageSelected(event.target.files?.[0])} />{draft.image && <button type="button" className="ms-text-button" onClick={() => { fileGeneration.current++; edit('image', undefined) }}>移除图片</button>}</div><p className="ms-hint">选择不超过 1 MB 的 PNG、JPEG 或 WebP 图片。</p>{imageError && <p className="ms-error" role="alert">{imageError}</p>}</div>
  </fieldset>
}
