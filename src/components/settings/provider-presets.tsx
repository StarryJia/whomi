import { ArrowLeft } from 'lucide-react'
import { modelProtocolLabels, type ModelProtocol } from '../../shared/model-protocol'
import type { ProviderInput } from '../../shared/settings-contract'
import { presetAccountId } from '../../shared/settings-contract'
import { cherryProviderPresets, type CherryProviderPreset } from '../../vendor/cherry-providers'
import { cherryProviderIcon } from '../../vendor/cherry-providers/icons'

export const presetAccounts = new Map(cherryProviderPresets.map(preset => [presetAccountId(preset.id), preset]))

export function ProviderAvatar({ name, image, avatarId, preset }: { name: string; image?: string; avatarId?: string; preset?: CherryProviderPreset }) {
  const src = image || cherryProviderIcon(avatarId ?? preset?.id ?? '')
  return src
    ? <img className="ms-provider-image" src={src} alt="" />
    : <span className="cherry-provider-avatar" aria-hidden="true">{name.slice(0, 1)}</span>
}

export function changePresetProtocol(input: ProviderInput, protocol: ModelProtocol, preset?: CherryProviderPreset): ProviderInput {
  const configured = input.endpointUrls?.[protocol]
  if (configured) return { ...input, protocol, baseUrl: configured }
  const previous = input.protocol && preset?.baseUrls[input.protocol]
  const next = preset?.baseUrls[protocol]
  const followsPreset = previous && previous.replace(/\/+$/, '') === input.baseUrl.replace(/\/+$/, '')
  return { ...input, protocol, baseUrl: followsPreset && next ? next : input.baseUrl }
}

export function PresetLinks({ preset }: { preset: CherryProviderPreset }) {
  const website = preset.website
  if (!website) return null
  const labels = { official: '官网', apiKey: '获取密钥', docs: '文档', models: '模型目录' } as const
  return <div className="ms-preset-links">{(Object.keys(labels) as (keyof typeof labels)[]).map(key => {
    const href = website[key]
    return href && /^https?:\/\//.test(href) && <a key={key} href={href} target="_blank" rel="noopener noreferrer">{labels[key]}</a>
  })}</div>
}

export function PresetDetail({ preset, onConfigure, onBack }: {
  preset: CherryProviderPreset
  onConfigure: () => void
  onBack: () => void
}) {
  return <section className="ms-detail" aria-label="预置服务商详情"><div className="ms-detail-body">
    <button type="button" className="ms-mobile-back ms-text-button" onClick={onBack}><ArrowLeft size={14} />返回服务商</button>
    <div className="ms-detail-header">
      <div className="ms-detail-title"><ProviderAvatar name={preset.name} preset={preset} /><h2>{preset.name}</h2></div>
      {preset.protocol && <button type="button" className="ms-button ms-primary" onClick={onConfigure}>配置服务商</button>}
    </div>
    <dl className="ms-preset-connection">
      {(preset.baseUrl || preset.protocol) && <><dt>接口地址</dt><dd>{preset.baseUrl || '配置时填写'}</dd></>}
      {preset.protocol && <><dt>连接协议</dt><dd>{modelProtocolLabels[preset.protocol]}</dd></>}
    </dl>
    {preset.setupNote && <p className="ms-hint">{preset.setupNote}</p>}
    <PresetLinks preset={preset} />
  </div></section>
}
