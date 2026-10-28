export type PreferenceId = 'energy' | 'information' | 'decisions' | 'approach'

export type PreferenceEstimate =
  | { status: 'unknown'; reason?: string }
  | { status: 'known'; leaning: 'left' | 'right' | 'balanced'; strength?: 'slight' | 'clear'; context?: string }

export interface SourceReference {
  id: string
  conversationId: string
  messageId: string
  endMessageId?: string
  title: string
  context: string
  unavailable?: boolean
}

export interface SparkScene {
  title: string
  context: string
  interaction: string
  behavior: string
  sourceIds: readonly string[]
}

export interface SparkFeedback {
  vote: 'agree' | 'disagree' | null
  comment: string
}

export interface SparkDiscovery {
  id: string
  title: string
  observation: string
  selfDescription?: string
  scenes: readonly SparkScene[]
  qualification?: string
  sources: readonly SourceReference[]
  feedback?: SparkFeedback
}

export interface OverviewData {
  materialStatus: 'none' | 'unanalysed' | 'partial' | 'ready'
  preferences?: Partial<Record<PreferenceId, PreferenceEstimate>>
  discoveries: readonly SparkDiscovery[]
}

export interface FeedbackReceipt {
  persistence: 'saved' | 'preview'
  analysis: 'pending' | 'not-requested'
}

export type FeedbackSaver = (discoveryId: string, feedback: SparkFeedback) => Promise<FeedbackReceipt>
