import type { ParserInput } from './types'
import { boundedText, checkFile, dependency, parseJson, ParseFailure, recordLimit } from './input'

export type Raw = Record<string, any>
export type SourceConversation = { root: Raw; records: Raw[]; chatIndex: number }

function records(value: unknown, input: ParserInput): Raw[] {
  if (!Array.isArray(value)) throw new ParseFailure('missing-messages')
  return value.map((item, ordinal) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ParseFailure('invalid-record', ordinal)
    if (Buffer.byteLength(JSON.stringify(item)) > recordLimit(input)) throw new ParseFailure('record-limit', ordinal)
    return item
  })
}
export async function sourceConversations(id: string, input: ParserInput): Promise<SourceConversation[]> {
  const text = await boundedText(input)
  let total = Buffer.byteLength(text)
  async function readDependency(name: unknown) {
    const file = await dependency(input, name)
    total += await checkFile(input, file)
    if (total > Math.min(input.limits?.maxFileBytes ?? Infinity, 32 * 1024 ** 2)) throw new ParseFailure('file-limit')
    return boundedText(input, file)
  }
  if (id.endsWith('-native') && ['qq-native', 'line-native', 'whatsapp-native'].includes(id)) {
    const rows = textRecords(id, text)
    if (!rows.length) throw new ParseFailure('missing-messages')
    return [{ root: {}, records: records(rows, input), chatIndex: 0 }]
  }
  const root = parseJson(text)
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new ParseFailure('invalid-format')
  if (id === 'telegram-native') {
    if (!Array.isArray(root.chats?.list)) throw new ParseFailure('missing-conversations')
    return root.chats.list.map((chat: Raw, chatIndex: number) => ({ root: { ...chat, personal_information: root.personal_information }, records: records(chat.messages, input), chatIndex }))
  }
  let rows = root.messages
  if (id === 'google-chat-native') {
    if (root.format !== 'chatlab-google-chat-takeout' || root.version !== 1) throw new ParseFailure('invalid-format')
    for (const key of ['userInfoFile', 'groupInfoFile', 'messagesFile']) {
      const data = parseJson(await readDependency(root[key]))
      if (key === 'messagesFile') rows = data.messages
      else root[key === 'userInfoFile' ? '_user' : '_group'] = data
    }
  }
  if (id === 'qq-shuakami-chunked') {
    if (!Array.isArray(root.chunked?.chunks)) throw new ParseFailure('invalid-format')
    rows = []
    for (const chunk of root.chunked.chunks) {
      const name = chunk.relativePath ?? chunk.file ?? (chunk.fileName ? `chunks/${chunk.fileName}` : null)
      const data = await readDependency(name)
      for (const line of data.split(/\r?\n/)) if (line.trim()) rows.push(parseJson(line))
    }
    if (root.avatars?.file) parseJson(await readDependency(root.avatars.file))
  }
  const required: Record<string, string[]> = {
    chatlab: ['chatlab', 'meta'], weflow: ['weflow', 'session'], echotrace: ['exportInfo', 'session'],
    'qq-shuakami': ['metadata', 'chatInfo'], 'qq-shuakami-chunked': ['metadata', 'chatInfo'],
    'discord-tyrrrz': ['guild', 'channel'], 'telegram-native-single': ['name', 'type', 'id'],
    'instagram-native': ['participants'],
  }
  if ((required[id] ?? []).some(key => root[key] === undefined)) throw new ParseFailure('missing-fields')
  if (id === 'chatlab' && !['0.0.1', '0.0.2'].includes(root.chatlab.version)) throw new ParseFailure('unsupported-version')
  return [{ root, records: records(rows, input), chatIndex: 0 }]
}

/** Retain the source wall-clock spelling; unzoned exports cannot become UTC instants. */
function textRecords(id: string, text: string): Raw[] {
  const rows: Raw[] = []
  let current: Raw | undefined, date = ''
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    let match: RegExpMatchArray | null = null
    if (id === 'qq-native') {
      match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (.+?)(?:\(([^)]+)\)|<([^>]+)>)?$/)
      if (match) current = { time: match[1], sender: match[3] ?? match[4], name: match[2], content: '' }
    } else if (id === 'whatsapp-native') {
      match = line.match(/^(?:\[([^\]]+)\] |(.+?\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:AM|PM))?) - )(.+)$/i)
      if (match) {
        const sender = match[3].match(/^(.+?): (.*)$/)
        current = { time: match[1] ?? match[2], name: sender?.[1], content: sender ? sender[2] : match[3], system: !sender }
      }
    } else {
      if (/^\d{4}[/.]\d{1,2}[/.]\d{1,2}/.test(line)) { date = line; continue }
      match = line.match(/^((?:上午|下午|午前|午後)?\d{1,2}:\d{2}(?:[AaPp][Mm])?)\t([^\t]*)\t(.*)$/)
      if (match) current = { time: `${date} ${match[1]}`, name: match[2], content: match[3], system: !match[2] }
    }
    if (match && current) { rows.push(current); continue }
    if (current && !/^(?:=====|消息记录|消息分组|消息对象:)/.test(line)) {
      if (id === 'qq-native' && !current._bodyStarted) { current.content = line; current._bodyStarted = true }
      else current.content += '\n' + line
    }
  }
  return rows
}
