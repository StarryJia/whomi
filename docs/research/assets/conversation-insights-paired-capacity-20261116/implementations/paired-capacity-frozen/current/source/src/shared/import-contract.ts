import type { ImportIssue, LocalId, ParsedMember, SourceIdentity } from './conversation-model'

export const importJobStates = ['preparing', 'scanning', 'awaiting_confirmation', 'staging', 'validating', 'awaiting_commit', 'committing', 'completed', 'partially_completed', 'failed', 'cancelled'] as const
export type ImportJobState = typeof importJobStates[number]
export const importResultStates = ['pending', 'blocked', 'staged', 'committing', 'saved', 'duplicate', 'failed', 'cancelled'] as const
export type ImportResultState = typeof importResultStates[number]
export type DiscoveryEntry = { entryId: string; displayName: string; formatId: string }
export type Discovery = { entries: readonly DiscoveryEntry[]; unrecognized: readonly { displayName: string }[]; issues: readonly ImportIssue[] }
export type ImportCounts = { seen: number; validRecords: number; invalidRecords: number }
export type Candidate = {
  candidateId: string; entryId: string; title: string; formatId: string; parserVersion: string
  sourceKey: string; kind: 'direct' | 'group' | 'unknown'; identity: SourceIdentity
  members: ParsedMember[]; fingerprint: string | null; counts: ImportCounts
  status: ImportResultState; issues: ImportIssue[]
}
export type AccountAlias = { platform: string; aliasKey: string; accountKey: string }
export type TargetDecision = { candidateId: string; target: { kind: 'new' } | { kind: 'existing'; conversationId: LocalId }; confirmedAliases: AccountAlias[]; selfMemberKey?: string | null }
export type SourceRecordKey = { fingerprint: string; sourceConversationKey: string; ordinal: number }

export type JobId = string
export type ImportPlan = { jobId: JobId; decisions: TargetDecision[] }
export type StartImportRequest = { kind: 'stage'; jobId: JobId; entryIds: string[] } | { kind: 'commit'; plan: ImportPlan }
export type ImportCandidateResult = { candidateId: string; conversationId: LocalId | null; status: ImportResultState; inserted: number; duplicates: number; committedAt: number | null; issues: ImportIssue[]; summaryFailed: boolean }
export type ImportSnapshot = { jobId: JobId; status: ImportJobState; discovery: Discovery | null; candidates: Candidate[]; results: ImportCandidateResult[]; issues: ImportIssue[]; counts: ImportCounts; inserted: number; duplicates: number; progress?: {processed:number;total:number|null} }
