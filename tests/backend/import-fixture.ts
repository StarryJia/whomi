import type { Candidate } from '../../src/shared/import-contract'
import type { StagedConversation } from '../../electron/data/import/staging'
import { normalizeModel } from '../../src/shared/conversation-model'
import { message } from './helpers'
export function candidate(id = 'a', key = 'chat', fingerprint = id): Candidate {
  return { candidateId: id, entryId: id, title: '示例会话', formatId: 'test', parserVersion: '1', sourceKey: key,
    kind: 'direct', identity: { platform: 'p', ownerKey: 'owner', conversationKey: key, namespace: 'test' },
    members: [], fingerprint, counts: { seen: 0, validRecords: 0, invalidRecords: 0 }, status: 'staged', issues: [] }
}
export function view(jobId: string, candidates: Candidate[], ids: string[][]): StagedConversation {
  return { jobId, candidates, candidateIds: candidates.map(c => c.candidateId), sources: candidates.map(c => ({ candidateId: c.candidateId, identity: c.identity })),
    *messages() { for (const [index, c] of candidates.entries()) for (const [ordinal, id] of ids[index].entries()) yield {
      candidateId: c.candidateId, message: normalizeModel(message({ conversationKey: c.sourceKey, ordinal, originalId: id, idNamespace: 'test', text: id })),
      origin: { fingerprint: c.fingerprint!, sourceConversationKey: c.sourceKey, ordinal, parserId: 'test', parserVersion: '1' },
    } },
  }
}
