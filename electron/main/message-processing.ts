import type { ProcessingSettings, RedactionRule } from '../../src/shared/settings-contract'

export type ProcessingMessage = { id: string; senderName: string; text: string; kind: string; memberId?: string | null; sentAtMs?: number | null; sourceIds?: string[]; isSelf?: boolean }
export type ProcessingMember = { id: string; displayName: string }
function luhn(value: string) {
  let sum = 0
  for (let index = value.length - 1; index >= 0; index--) { let digit = Number(value[index]); if ((value.length - index) % 2 === 0) { digit *= 2; if (digit > 9) digit -= 9 } sum += digit }
  return sum % 10 === 0 && !/^0+$/.test(value)
}
type TextMatch = { 0: string; index: number }
type TextRange = { start: number; end: number }

function* emailAddresses(input: string): Generator<TextMatch> {
  if (!input.includes('@')) return
  // 整段消费邮箱本地部分，缺少合法域名时也不必从每个字符重新匹配。
  const address = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+(@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)?/g
  for (const match of input.matchAll(address)) if (match[1]) yield match
}

function* scanCards(input: string, offset: number): Generator<TextRange> {
  for (const run of input.matchAll(/\d+(?:[ -]\d+)*/g)) {
    const groups = [...run[0].matchAll(/\d+/g)]
    for (let start = 0; start < groups.length; start++) {
      let digits = ''
      let match: TextRange | undefined
      let last = start
      for (let end = start; end < groups.length; end++) {
        digits += groups[end][0]
        if (digits.length > 19) break
        if (digits.length < 13 || !luhn(digits)) continue
        // 只在数字组边界截取，避免吞入相邻号码或截短连续长编号。
        match = { start: offset + run.index + groups[start].index, end: offset + run.index + groups[end].index + groups[end][0].length }
        last = end
      }
      if (match) { yield match; start = last }
    }
  }
}

function* financialNumbers(input: string, boundaries: TextRange[]): Generator<TextRange> {
  if (!boundaries.length) {
    yield* scanCards(input, 0)
    return
  }
  function* between(ranges: TextRange[]) {
    let start = 0
    for (const range of ranges) {
      if (start < range.start) yield* scanCards(input.slice(start, range.start), start)
      start = Math.max(start, range.end)
    }
    if (start < input.length) yield* scanCards(input.slice(start), start)
  }
  // 优先保留其他标识旁边能独立校验的整张卡；其余区间仍可包含与标识重叠的卡号。
  const separate = [...between(boundaries.sort((left, right) => left.start - right.start))]
  yield* separate
  yield* between(separate)
}
function cleanCard(text: string) {
  if (!/^\s*(?:<\?xml\s+[^?]*\?>\s*)?<msg[\s>]/.test(text) || !/<appmsg[\s>]/.test(text)) return text
  const values = ['title', 'des', 'url'].flatMap(tag => {
    const value = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]
    return value ? [value.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')] : []
  })
  return values.length ? [...new Set(values)].join('\n') : text
}

function* passwordValues(input: string): Generator<TextMatch> {
  // 仅带引号的结构化键和值允许分行，普通聊天字段只接受横向空白。
  const field = /(["'])(?:密码|password)\1[ \t\r\n]*:[ \t\r\n]*(?=["'])|(?:密码|\bpassword)["']?[\t\p{Zs}]*(?:[=:：]|[是为](?![\t\p{Zs}]*(?:否|什么|啥|多少|不是|哪|几[位个]|怎么))[\t\p{Zs}]*[:：]?)[\t\p{Zs}]*/giu
  const valueAtField = /"(?:\\[^\r\n]|[^"\\\r\n])+"|'(?:\\[^\r\n]|[^'\\\r\n])+'|“[^”\r\n]+”|‘[^’\r\n]+’|(`+)(?!`)[^\r\n]+?\1(?!`)|[^\s"'“”‘’,;，。；！？、][^\s,;，。；！？、]*/y
  while (field.exec(input)) {
    valueAtField.lastIndex = field.lastIndex
    const match = valueAtField.exec(input)
    if (!match) continue
    field.lastIndex = valueAtField.lastIndex
    const value = match[0]
    const quoteWidth = match[1]?.length ?? (/^["'“‘]/.test(value) ? 1 : 0)
    const secret = quoteWidth ? value.slice(quoteWidth, -quoteWidth) : value
    // 摘要和引文可能再次经过发送处理，保留已经完整遮盖的值以便原文校验。
    if (/^\[(?:密码|授权令牌|接口密钥|邮箱|身份证号|手机号|座机号|银行卡号|信用卡号|网址|网络地址)\]$/.test(secret)) continue
    yield { index: match.index + quoteWidth, 0: secret }
  }
}

export function createMessageProcessor(settings: ProcessingSettings, members: readonly ProcessingMember[]) {
  const nicknames = new Map(members.map(member => [member.displayName, `U${member.id}`]))
  const aliases = new Set(members.map(member => `U${member.id}`))
  const rules = new Set(settings.rules)
  const selectedCardLabel = rules.has('bank-card') ? '[银行卡号]' : rules.has('credit-card') ? '[信用卡号]' : undefined
  function text(input: string): string {
    if (!settings.redact || !rules.size) return input
    const cardLabel = selectedCardLabel && /\d(?:[ -]?\d){12}/.test(input) ? selectedCardLabel : undefined
    const spans: { start: number; end: number; label: string }[] = []
    const boundaries: TextRange[] = []
    const internationalMobileEnds = new Map<number, number>()
    function redact(rule: RedactionRule, pattern: RegExp | ((value: string) => Iterable<TextMatch>), replacement: string | ((value: string) => string | undefined), selected = spans) {
      const enabled = rules.has(rule)
      if (!enabled && !cardLabel) return
      const matches = typeof pattern === 'function' ? pattern(input) : input.matchAll(pattern)
      for (const match of matches) {
        const label = typeof replacement === 'string' ? replacement : replacement(match[0])
        if (label === undefined) continue
        const span = { start: match.index, end: match.index + match[0].length, label }
        if (cardLabel) {
          boundaries.push(span)
          if (rule === 'mobile' && match[0].startsWith('+')) internationalMobileEnds.set(span.start + 1, span.end)
        }
        if (enabled) selected.push(span)
      }
    }
    redact('url', /https?:\/\/[^\s<>"）]+/gi, '[网址]')
    redact('token', /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, '[授权令牌]')
    redact('key', /\b(?:sk-|sk_|AIza|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g, '[接口密钥]')
    redact('email', emailAddresses, '[邮箱]')
    redact('identity', /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g, '[身份证号]')
    redact('mobile', /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, '[手机号]')
    redact('landline', /(?<!\d)0\d{2,3}[- ]\d{7,8}(?:[- ]\d{1,6})?(?!\d)/g, '[座机号]')
    const afterCards: typeof spans = []
    redact('ipv4', /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g, match => match.split('.').every(part => Number(part) <= 255) ? '[网络地址]' : undefined, afterCards)
    redact('password', passwordValues, '[密码]', afterCards)
    if (cardLabel) {
      for (const range of financialNumbers(input, boundaries)) {
        // 带国家码的完整手机号也可能通过卡号校验。
        if (internationalMobileEnds.get(range.start) !== range.end) spans.push({ ...range, label: cardLabel })
      }
    }
    for (const span of afterCards) spans.push(span)
    if (!spans.length) return input
    // 先在原文上匹配，再合并交叠区间，防止短匹配遮掉较长凭据的识别前缀。
    spans.sort((a, b) => a.start - b.start || b.end - a.end)
    const parts: string[] = []
    let end = 0
    for (const span of spans) {
      if (span.start >= end) parts.push(input.slice(end, span.start), span.label)
      end = Math.max(end, span.end)
    }
    parts.push(input.slice(end))
    return parts.join('')
  }
  function data<T>(input: T, key = ''): T {
    if (key === 'id' || key === 'revision' || key.endsWith('Id') || key.endsWith('Ids')) return input
    if (typeof input === 'string') {
      if (key === 'senderName' && settings.anonymize) return (aliases.has(input) ? input : nicknames.get(input) ?? '成员') as T
      return text(input) as T
    }
    if (Array.isArray(input)) return input.map(value => data(value, key)) as T
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([name, value]) => [name, data(value, name)])) as T
    return input
  }
  function processMessages<T extends ProcessingMessage>(input: readonly T[], merge: boolean, breaks?: ReadonlySet<string>) {
    const result: (T & { sourceIds: string[] })[] = []
    let lastTime: number | null | undefined
    for (const original of input) {
      if (settings.denoise && (!original.text.trim() || (original.kind === 'system' && /^\[(系统消息|系统占位|空消息)\]$/.test(original.text.trim())))) {
        lastTime = null
        continue
      }
      const item = { ...original, sourceIds: [...(original.sourceIds ?? [original.id])], text: text(settings.clean ? cleanCard(original.text) : original.text),
        senderName: settings.anonymize ? original.memberId ? `U${original.memberId}` : nicknames.get(original.senderName) ?? '成员' : text(original.senderName) }
      const previous = result.at(-1)
      if (merge && !breaks?.has(item.id) && previous && item.memberId && previous.memberId === item.memberId && previous.isSelf === item.isSelf &&
        item.kind === 'text' && previous.kind === 'text' && item.sentAtMs != null && previous.sentAtMs != null &&
        lastTime != null && item.sentAtMs >= lastTime && item.sentAtMs - previous.sentAtMs <= settings.mergeSeconds * 1000) {
        previous.text += '\n' + item.text
        previous.sourceIds.push(...item.sourceIds)
      } else {
        result.push(item)
      }
      lastTime = item.sentAtMs
    }
    return result
  }
  function prepare<T extends ProcessingMessage>(input: readonly T[]) { return processMessages(input, false) }
  function messages<T extends ProcessingMessage>(input: readonly T[], referenceBreaks?: readonly string[]) {
    return processMessages(input, settings.merge, referenceBreaks?.length ? new Set(referenceBreaks) : undefined)
  }
  return { text, data, messages, prepare }
}
