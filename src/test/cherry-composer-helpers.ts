import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import type { TiptapEditorHTMLElement } from '@tiptap/core'
import { expect } from 'vitest'
import { clearComposerDraft } from '../components/conversation-ai/cherry/composer'
import type { ConversationRequest, RestoredConversationTurn } from '../components/conversation-ai/types'

export function clearFixtureDrafts(conversationId: string, threadIds: readonly string[] = []) {
  for (const threadId of ['initial', ...threadIds]) clearComposerDraft(`${conversationId}:${threadId}`)
}

export async function composerTextbox() {
  const current = () => screen.getByRole('textbox', { name: '向 AI 提问' }) as TiptapEditorHTMLElement
  if (!current().editor) act(() => current().focus())
  return waitFor(() => {
    const textbox = current()
    expect(textbox).toHaveClass('ProseMirror')
    return textbox
  })
}

export async function pasteComposerText(text: string, { replace = false } = {}) {
  const textbox = await composerTextbox()
  if (replace) act(() => textbox.editor?.commands.selectAll())
  fireEvent.paste(textbox, {
    clipboardData: {
      types: ['text/plain'],
      getData: (type: string) => type === 'text/plain' ? text : '',
    },
  })
}

export async function expectComposerText(text: string) {
  expect((await composerTextbox()).textContent).toBe(text)
}

export function persistedTurn(request: ConversationRequest, overrides: Partial<RestoredConversationTurn> = {}): RestoredConversationTurn {
  if (!request.requestId) throw new Error('A persisted turn requires a request ID')
  return {
    id: request.turnId ?? `turn-${request.requestId}`,
    requestId: request.requestId,
    prompt: request.prompt,
    referenceIds: [...new Set([...(request.referenceIds ?? []), ...request.references.flatMap(range => range.messages.map(message => message.id))])],
    modelId: request.modelId,
    thinkingLevel: request.thinkingLevel,
    skillId: request.skillId,
    text: '',
    state: 'running',
    ...overrides,
  }
}
