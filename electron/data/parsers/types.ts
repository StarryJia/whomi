import type { ImportIssue, ParsedConversation, ParsedMember, ParsedMessage } from '../../../src/shared/conversation-model'

export type SourceProbe = { extension: string; prefix: Uint8Array; size: number }
/** 后台创建并保持不可变的快照文件；不接受来自界面的任意路径。 */
export type ParserInput = {
  candidateId: string
  entry: string
  allowedFiles: readonly string[]
  signal: AbortSignal
  limits?: { maxFileBytes?: number; maxRecordBytes?: number }
}
export type ParseEvent =
  | { type: 'conversation'; value: ParsedConversation }
  | { type: 'member'; conversationKey: string; value: ParsedMember }
  | { type: 'message'; value: ParsedMessage }
  | { type: 'issue'; value: ImportIssue }
  | { type: 'end'; conversationKey: string; seen: number; declaredMessages?: number }
export type ParserAdapter = {
  id: string
  version: string
  extensions: readonly string[]
  mode: 'stream' | 'bounded'
  capabilities: { multiConversation: boolean; stableMessageIds: 'platform' | 'none' | 'conditional'; media: 'descriptors-only' }
  detect(probe: SourceProbe): Promise<number>
  parse(input: ParserInput): AsyncIterable<ParseEvent>
}
