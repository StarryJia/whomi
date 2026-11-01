import type { ModelOption, ThinkingLevel } from '../conversation-ai/model-selector'
import type { SourceReference } from '../overview/types'

export interface ClarificationOption {
  id: string
  title: string
  description?: string
}

export interface ClarificationQuestion {
  id: string
  title: string
  context: string
  options: readonly ClarificationOption[]
  source?: SourceReference
}

export interface ClarificationModel extends ModelOption {
  available: boolean
}

export type ClarificationAnswer =
  | { kind: 'option'; optionId: string; text: string }
  | { kind: 'text'; text: string; modelId: string; thinkingLevel?: ThinkingLevel }

export interface ClarificationReceipt {
  answerId: string
  persistence: 'saved' | 'preview'
}

export interface ClarificationWithdrawal {
  persistence: 'saved' | 'preview'
}

export interface ClarificationAdapter {
  submit: (questionId: string, answer: ClarificationAnswer) => Promise<ClarificationReceipt>
  withdraw: (questionId: string, answerId: string) => Promise<ClarificationWithdrawal>
}

export interface ClarificationEntry {
  mode: 'cards' | 'own'
  draft: string
  modelId: string
  thinkingLevel?: ThinkingLevel
  pending?: 'submit' | 'withdraw'
  answer?: ClarificationAnswer
  receipt?: ClarificationReceipt
  error?: 'submit' | 'withdraw'
  failedAnswer?: ClarificationAnswer
  withdrawn?: ClarificationWithdrawal
}

export interface ClarificationController {
  canSubmit: boolean
  get: (questionId: string) => ClarificationEntry
  startOwn: (questionId: string) => void
  useCards: (questionId: string) => void
  setDraft: (questionId: string, draft: string) => void
  setModel: (questionId: string, modelId: string) => void
  setThinkingLevel: (questionId: string, level?: ThinkingLevel) => void
  choose: (question: ClarificationQuestion, optionId: string) => Promise<void>
  sendOwn: (question: ClarificationQuestion, models: readonly ClarificationModel[]) => Promise<void>
  retry: (question: ClarificationQuestion, models: readonly ClarificationModel[]) => Promise<void>
  withdraw: (questionId: string) => Promise<void>
}
