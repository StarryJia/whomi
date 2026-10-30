import type { ProcessingSettings } from '../../src/shared/settings-contract'

export type ProcessingMessage = { id: string; senderName: string; text: string; kind: string; memberId?: string | null; sentAtMs?: number | null; sourceIds?: string[] }
export type ProcessingMember = { id: string; displayName: string }
function luhn(value: string) {
  let sum = 0
  for (let index = value.length - 1; index >= 0; index--) { let digit = Number(value[index]); if ((value.length - index) % 2 === 0) { digit *= 2; if (digit > 9) digit -= 9 } sum += digit }
  return sum % 10 === 0 && !/^0+$/.test(value)
}
function cleanCard(text: string) {
  if (!/^\s*<msg[\s>]/.test(text) || !/<appmsg[\s>]/.test(text)) return text
  const values = ['title', 'des', 'url'].flatMap(tag => {
    const value = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]
    return value ? [value.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')] : []
  })
  return values.length ? [...new Set(values)].join('\n') : text
}

export function createMessageProcessor(settings: ProcessingSettings, members: readonly ProcessingMember[]) {
  const names = [...members].sort((a, b) => b.displayName.length - a.displayName.length)
  const nicknames = new Map(members.map(member => [member.displayName, `U${member.id}`]))
  const rules = new Set(settings.rules)
  function text(input: string): string {
    let value = input
    if (settings.anonymize) for (const member of names) {
      // 单字昵称与正常用语易重合，正文只替换明确的多字昵称；消息头始终编号化。
      if (member.displayName.length > 1) value = value.split(member.displayName).join(`U${member.id}`)
    }
    if (!settings.redact) return value
    if (rules.has('token')) value = value.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, '[授权令牌]')
    if (rules.has('key')) value = value.replace(/\b(?:sk-|sk_|AIza|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g, '[接口密钥]')
    if (rules.has('email')) value = value.replace(/[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '[邮箱]')
    if (rules.has('identity')) value = value.replace(/(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g, '[身份证号]')
    if (rules.has('mobile')) value = value.replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, '[手机号]')
    if (rules.has('landline')) value = value.replace(/(?<!\d)0\d{2,3}[- ]\d{7,8}(?:[- ]\d{1,6})?(?!\d)/g, '[座机号]')
    if (rules.has('credit-card') || rules.has('bank-card')) value = value.replace(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g, match => {
      const digits = match.replace(/[ -]/g, '')
      return luhn(digits) ? rules.has('bank-card') ? '[银行卡号]' : '[信用卡号]' : match
    })
    if (rules.has('url')) value = value.replace(/https?:\/\/[^\s<>"）]+/gi, '[网址]')
    if (rules.has('ipv4')) value = value.replace(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g, match => match.split('.').every(part => Number(part) <= 255) ? '[网络地址]' : match)
    return value
  }
  function data<T>(input: T, key = ''): T {
    if (['id', 'sourceIds', 'evidenceMessageIds', 'referenceIds', 'memberId', 'modelId'].includes(key)) return input
    if (typeof input === 'string') return (key === 'senderName' && settings.anonymize ? nicknames.get(input) ?? '成员' : text(input)) as T
    if (Array.isArray(input)) return input.map(value => data(value, key)) as T
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([name, value]) => [name, data(value, name)])) as T
    return input
  }
  function messages<T extends ProcessingMessage>(input: readonly T[]): (T & { sourceIds: string[] })[] {
    const result: (T & { sourceIds: string[] })[] = []
    for (const original of input) {
      if (settings.denoise && (!original.text.trim() || (original.kind === 'system' && /^\[(系统消息|系统占位|空消息)\]$/.test(original.text.trim())))) continue
      const item = { ...original, sourceIds: original.sourceIds ?? [original.id], text: text(settings.clean ? cleanCard(original.text) : original.text),
        senderName: settings.anonymize ? original.memberId ? `U${original.memberId}` : nicknames.get(original.senderName) ?? '成员' : text(original.senderName) }
      const previous = result.at(-1)
      if (settings.merge && previous && original.kind === 'text' && previous.kind === 'text' &&
        (original.memberId ? previous.memberId === original.memberId : previous.senderName === item.senderName && !settings.anonymize) &&
        original.sentAtMs != null && previous.sentAtMs != null && original.sentAtMs >= previous.sentAtMs && original.sentAtMs - previous.sentAtMs <= settings.mergeSeconds * 1000) {
        previous.text += `\n${item.text}`; previous.sourceIds.push(...item.sourceIds); previous.sentAtMs = item.sentAtMs
      } else result.push(item)
    }
    return result
  }
  return { text, data, messages }
}
