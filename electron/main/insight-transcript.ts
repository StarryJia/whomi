import type { InsightReadMessage, InsightReadPage } from '../../src/shared/insight-reader'

export function estimateTranscriptTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 2.5)
}

export function formatInsightReadPage(page: InsightReadPage): string {
  return page.status === 'ok'
    ? `nextCursor: ${page.nextCursor}\n${page.transcript}`
    : `status: ${page.status}\n${page.message}`
}

const simpleName = /^[\p{L}\p{M}\p{N}_-]+$/u

function legendName(name: string) {
  return simpleName.test(name) ? name : JSON.stringify(name).replace(/[\u2028\u2029]/g, ch => '\\u' + ch.charCodeAt(0).toString(16))
}

function speakers(messages: readonly InsightReadMessage[]) {
  const self = new Set<string>()
  const peers = new Set<string>()
  for (const message of messages) (message.isSelf ? self : peers).add(message.senderName)
  const entries = self.size ? [`我=本人(${[...self].map(legendName).join('、')})`] : []
  const labels = new Map<string, string>()
  let number = 0
  for (const name of peers) {
    let label = name
    if (peers.size === 1) label = 'ta'
    else if (name === '我' || !simpleName.test(name)) {
      do { label = '人' + ++number } while (peers.has(label))
    }
    labels.set(name, label)
    entries.push(peers.size > 1 && label === name ? label : label + '=' + legendName(name))
  }
  return { legend: '发言人：' + entries.join('，'), labels }
}

function dateFormatters(timezone: string) {
  const dateOptions = { year: 'numeric', month: '2-digit', day: '2-digit' } as const
  let date: Intl.DateTimeFormat
  try {
    date = new Intl.DateTimeFormat('en-CA', { ...dateOptions, timeZone: timezone })
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    date = new Intl.DateTimeFormat('en-CA', { ...dateOptions, timeZone: 'UTC' })
  }
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: date.resolvedOptions().timeZone, hour: '2-digit', minute: '2-digit', hour12: false })
  return { date, time }
}

function formatLine(header: string, text: string) {
  if (!/[\n\r]/.test(text)) return header + ': ' + text
  let width = 3
  for (const run of text.matchAll(/^(<{3,}|>{3,})/gm)) width = Math.max(width, run[0].length + 1)
  return header + ':\n' + '<'.repeat(width) + '\n' + text + '\n' + '>'.repeat(width)
}

export function formatInsightTranscript(messages: readonly InsightReadMessage[], timezone: string): string {
  if (!messages.length) return ''
  const { legend, labels } = speakers(messages)
  const formats = dateFormatters(timezone)
  const lines = [legend]
  let lastDate: string | undefined
  let lastTime: string | undefined
  for (const message of messages) {
    const { sentAtMs, replyToMessageId, fragment } = message
    const dated = sentAtMs !== null && Number.isFinite(new Date(sentAtMs).getTime())
    const date = dated ? formats.date.format(sentAtMs).padStart(10, '0') : '未知日期'
    const time = dated ? formats.time.format(sentAtMs) : ''
    if (date !== lastDate) {
      lines.push('## ' + date)
      lastTime = undefined
    }
    const speaker = message.isSelf ? '我' : labels.get(message.senderName)!
    const reply = replyToMessageId === null ? '' : ' >' + replyToMessageId
    const part = fragment && (fragment.start > 0 || fragment.end < fragment.length)
      ? ` [片段 ${fragment.start}-${fragment.end}/${fragment.length}]` : ''
    lines.push(formatLine(`${message.id} ${time && time !== lastTime ? time + ' ' : ''}${speaker}${reply}${part}`, message.text))
    lastDate = date
    lastTime = time
  }
  return lines.join('\n')
}
