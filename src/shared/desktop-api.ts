import type { LocalId, MessageKind, ParsedMessage } from './conversation-model'
import type { ImportSnapshot, JobId, StartImportRequest } from './import-contract'
import type { AiApi } from './ai-contract'

export type Page<T> = { items: T[]; nextCursor: string | null }
export type ConversationSummary = {
  id: LocalId
  title: string
  kind: 'direct' | 'group' | 'unknown'
  messageCount: number
  memberCount: number
  firstSentAtMs: number | null
  lastSentAtMs: number | null
  summaryStatus: 'pending' | 'ready' | 'failed'
}
export type AttachmentView = { kind: MessageKind; name: string | null; state: 'unresolved' | 'missing' }
export type ReplyView = {
  targetMessageId: LocalId | null
  originalId: string | null
  idNamespace: string | null
  text: string | null
  senderName: string | null
  sentAtMs: number | null
  state: 'unresolved' | 'resolved'
}
export type MessageView = {
  id: LocalId
  conversationId: LocalId
  memberId: LocalId | null
  senderKind: ParsedMessage['senderKind']
  senderName: string
  isSelf: boolean
  sentAtMs: number | null
  timeRaw: string | null
  timePrecision: ParsedMessage['timePrecision']
  timezone: string | null
  timeBucket: 0 | 1
  sortTime: number
  ordinal: number
  kind: MessageKind
  sourceType: string | null
  text: string
  reply: ReplyView | null
  attachments: AttachmentView[]
}
export type MessagePage = {
  items: MessageView[]
  beforeCursor: string | null
  afterCursor: string | null
  snapshotMaxId: LocalId
}
export type MessagePosition = { id: LocalId; timeBucket: 0 | 1; sortTime: number }
export type SourceWindow = { status: 'unavailable' } | {
  status: 'available'
  conversationId: LocalId
  startMessageId: LocalId
  endMessageId: LocalId
  start: MessagePosition
  end: MessagePosition
  page: MessagePage
  /** Endpoint marker in the same snapshot; page cursors continue reading surrounding context. */
  rangeEndCursor: string
}
export type ListConversationsInput = { cursor?: string; limit?: number }
export type ReadMessagesInput = { conversationId: LocalId; cursor?: string; direction: 'before' | 'after'; limit?: number }
export type LocateSourceInput = { conversationId: LocalId; messageId: LocalId; endMessageId?: LocalId }
export type ConversationQueries = {
  listConversations(input: ListConversationsInput): Promise<Page<ConversationSummary>>
  readMessages(input: ReadMessagesInput): Promise<MessagePage>
  locateSource(input: LocateSourceInput): Promise<SourceWindow>
}

export type SourceHandle = { token: string; displayName: string; kind: 'file' | 'directory' }
export type MemberView = { id: LocalId; displayName: string; selfHint: boolean | null; confirmedSelf: boolean }
export type PreviewMessage = Pick<ParsedMessage, 'ordinal' | 'senderKey' | 'senderKind' | 'senderName' | 'sentAtMs' | 'timeRaw' | 'timePrecision' | 'timezone' | 'kind' | 'text' | 'sourceType' | 'reply'> & { attachments: AttachmentView[] }
export type PreviewOptions = { afterOrdinal?: number; limit?: number }
export type ImportPreview = { messages: PreviewMessage[]; nextOrdinal: number | null }
export type DesktopMethods = ConversationQueries & {
  chooseSources(kind: 'files' | 'directory'): Promise<SourceHandle[]>
  prepareImport(handles: SourceHandle[]): Promise<JobId>
  startImport(request: StartImportRequest): Promise<JobId>
  getImport(jobId: JobId): Promise<ImportSnapshot>
  cancelImport(jobId: JobId): Promise<void>
  previewImport(jobId: JobId, candidateId: string, options: PreviewOptions): Promise<ImportPreview>
  listMembers(conversationId: LocalId): Promise<MemberView[]>
  confirmSelf(conversationId: LocalId, memberId: LocalId | null): Promise<void>
  deleteConversation(conversationId: LocalId): Promise<void>
  retrySummary(conversationId: LocalId): Promise<void>
}
export type DesktopApi = DesktopMethods & {
  ai?: AiApi
  settings?: import('./settings-contract').SettingsApi
  acceptDroppedFiles(files: File[]): Promise<SourceHandle[]>
  onImport(listener: (snapshot: ImportSnapshot) => void): () => void
}
export type DesktopMethod = keyof DesktopMethods
export type DesktopError = { code: string; action: string }
export type DesktopResponse = { ok: true; value: unknown } | { ok: false; error: DesktopError }
declare global { interface Window { whomi?: DesktopApi } }
