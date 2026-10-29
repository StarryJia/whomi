import type { ImportIssue, ParsedMember, SourceIdentity } from './conversation-model'

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
