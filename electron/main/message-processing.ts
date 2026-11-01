import type { ProcessingSettings } from '../../src/shared/settings-contract'

export type ProcessingMessage = { id: string; senderName: string; text: string; kind: string; memberId?: string | null; sentAtMs?: number | null; sourceIds?: string[]; isSelf?: boolean }
export type ProcessingMember = { id: string; displayName: string }
function luhn(value: string) {
  let sum = 0
  for (let index = value.length - 1; index >= 0; index--) { let digit = Number(value[index]); if ((value.length - index) % 2 === 0) { digit *= 2; if (digit > 9) digit -= 9 } sum += digit }
  return sum % 10 === 0 && !/^0+$/.test(value)
}
type TextMatch = { 0: string; index: number }
function* financialNumbers(input: string): Generator<TextMatch> {
  for (const run of input.matchAll(/\d+(?:[ -]\d+)*/g)) {
    const groups = [...run[0].matchAll(/\d+/g)]
    for (let start = 0; start < groups.length; start++) {
      let digits = ''
      let match: TextMatch | undefined
      let last = start
      for (let end = start; end < groups.length; end++) {
        digits += groups[end][0]
        if (digits.length > 19) break
        if (digits.length < 13 || !luhn(digits)) continue
        // 只在数字组边界截取，避免吞入相邻号码或截短连续长编号。
        const offset = groups[start].index
        match = { 0: run[0].slice(offset, groups[end].index + groups[end][0].length), index: run.index + offset }
        last = end
      }
      if (match) { yield match; start = last }
    }
  }
}
function cleanCard(text: string) {
  if (!/^\s*(?:<\?xml\s+[^?]*\?>\s*)?<msg[\s>]/.test(text) || !/<appmsg[\s>]/.test(text)) return text
  const values = ['title', 'des', 'url'].flatMap(tag => {
    const value = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]
    return value ? [value.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')] : []
  })
  return values.length ? [...new Set(values)].join('\n') : text
}

export function createMessageProcessor(settings: ProcessingSettings, members: readonly ProcessingMember[]) {
  const names = members.map(member => member.displayName).filter(name => name.length > 1)
  const nicknames = new Map(members.map(member => [member.displayName, `U${member.id}`]))
  // 单字昵称易与正常用语重合；正文只替换多字昵称，消息头仍编号化。
  function matcher(values: string[]) {
    const pattern = values.sort((a, b) => b.length - a.length).map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    return settings.anonymize && pattern ? new RegExp(pattern, 'g') : null
  }
  const generatedTokens = new Set([...members.map(member => `U${member.id}`), '[授权令牌]', '[接口密钥]', '[邮箱]', '[身份证号]', '[手机号]', '[座机号]', '[银行卡号]', '[信用卡号]', '[网址]', '[网络地址]'])
  const nicknameMatcher = matcher([...names])
  const modelMatcher = matcher([...names, ...generatedTokens])
  const rules = new Set(settings.rules)
  function anonymize(input: string, preserveGenerated: boolean): string {
    const pattern = preserveGenerated ? modelMatcher : nicknameMatcher
    return pattern ? input.replace(pattern, name => preserveGenerated && generatedTokens.has(name) ? name : nicknames.get(name)!) : input
  }
  function text(input: string, preserveGenerated = false): string {
    if (!settings.redact) return anonymize(input, preserveGenerated)
    type Part = { value: string; redacted?: boolean }
    let parts: Part[] = [{ value: input }]
    function redact(pattern: RegExp | ((value: string) => Iterable<TextMatch>), replacement: string | ((value: string) => string | undefined)) {
      parts = parts.flatMap(part => {
        // 脱敏标记不再参与后续规则或昵称匹配。
        if (part.redacted) return [part]
        const result: Part[] = []
        let start = 0
        const matches = typeof pattern === 'function' ? pattern(part.value) : part.value.matchAll(pattern)
        for (const match of matches) {
          const value = typeof replacement === 'string' ? replacement : replacement(match[0])
          if (value === undefined) continue
          result.push({ value: part.value.slice(start, match.index) }, { value, redacted: true })
          start = match.index + match[0].length
        }
        result.push({ value: part.value.slice(start) })
        return result
      })
    }
    if (rules.has('url')) redact(/https?:\/\/[^\s<>"）]+/gi, '[网址]')
    if (rules.has('token')) redact(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, '[授权令牌]')
    if (rules.has('key')) redact(/\b(?:sk-|sk_|AIza|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g, '[接口密钥]')
    if (rules.has('email')) redact(/[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '[邮箱]')
    if (rules.has('identity')) redact(/(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g, '[身份证号]')
    if (rules.has('mobile')) redact(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, '[手机号]')
    if (rules.has('landline')) redact(/(?<!\d)0\d{2,3}[- ]\d{7,8}(?:[- ]\d{1,6})?(?!\d)/g, '[座机号]')
    if (rules.has('credit-card') || rules.has('bank-card')) redact(financialNumbers, rules.has('bank-card') ? '[银行卡号]' : '[信用卡号]')
    if (rules.has('ipv4')) redact(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g, match => match.split('.').every(part => Number(part) <= 255) ? '[网络地址]' : undefined)
    return parts.map(part => part.redacted ? part.value : anonymize(part.value, preserveGenerated)).join('')
  }
  // 模型材料中的已有编号与替换标记必须在续聊及多轮归并中保持一致。
  function modelText(input: string) { return text(input, true) }
  function data<T>(input: T, key = ''): T {
    if (['id', 'sourceIds', 'evidenceMessageIds', 'referenceIds', 'messageId', 'memberId', 'modelId'].includes(key)) return input
    if (typeof input === 'string') return (key === 'senderName' && settings.anonymize ? generatedTokens.has(input) ? input : nicknames.get(input) ?? '成员' : modelText(input)) as T
    if (Array.isArray(input)) return input.map(value => data(value, key)) as T
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([name, value]) => [name, data(value, name)])) as T
    return input
  }
  function prepare<T extends ProcessingMessage>(input: readonly T[]) {
    const result: (T & { sourceIds: string[] })[] = []
    for (const original of input) {
      if (settings.denoise && (!original.text.trim() || (original.kind === 'system' && /^\[(系统消息|系统占位|空消息)\]$/.test(original.text.trim())))) continue
      const item = { ...original, sourceIds: original.sourceIds ?? [original.id], text: text(settings.clean ? cleanCard(original.text) : original.text),
        senderName: settings.anonymize ? original.memberId ? `U${original.memberId}` : nicknames.get(original.senderName) ?? '成员' : text(original.senderName) }
      result.push(item)
    }
    return result
  }
  function merge<T extends ProcessingMessage & { sourceIds: string[] }>(input: readonly T[], maxBytes = Infinity, legacy = false): T[] {
    if (!settings.merge) return [...input]
    const result: T[] = []
    let bytes = 0
    for (const item of input) {
      const previous = result.at(-1)
      const cost = Number.isFinite(maxBytes) ? Buffer.byteLength(JSON.stringify(item)) : 0
      const sameSender = legacy ? (item.memberId ? previous?.memberId === item.memberId : previous?.senderName === item.senderName && !settings.anonymize)
        : !!item.memberId && previous?.memberId === item.memberId && previous?.isSelf === item.isSelf
      if (previous && sameSender && item.kind === 'text' && previous.kind === 'text' && bytes + cost <= maxBytes &&
        item.sentAtMs != null && previous.sentAtMs != null && item.sentAtMs >= previous.sentAtMs && item.sentAtMs - previous.sentAtMs <= settings.mergeSeconds * 1000) {
        previous.text += `\n${item.text}`; previous.sourceIds.push(...item.sourceIds); previous.sentAtMs = item.sentAtMs
        bytes += cost
      } else { result.push({ ...item, sourceIds: [...item.sourceIds] }); bytes = cost }
    }
    return result
  }
  function messages<T extends ProcessingMessage>(input: readonly T[]) { return merge(prepare(input)) }
  return { text, modelText, data, messages, prepare, merge }
}
