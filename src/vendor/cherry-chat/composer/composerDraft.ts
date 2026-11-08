import type { Editor, JSONContent } from '@tiptap/core'

export interface ComposerSerializedDraft {
  text: string
  tokens: readonly never[]
}

type ComposerSerializableSource = Pick<Editor, 'getJSON'> | JSONContent

function isEditorSource(source: ComposerSerializableSource): source is Pick<Editor, 'getJSON'> {
  return typeof (source as Pick<Editor, 'getJSON'>).getJSON === 'function'
}

function appendTextContent(nodes: JSONContent[], text: string) {
  text.split(/\r\n?|\n/).forEach((line, index) => {
    if (index > 0) nodes.push({ type: 'hardBreak' })
    if (line) nodes.push({ type: 'text', text: line })
  })
}

export function createComposerDraftContent(draft: Pick<ComposerSerializedDraft, 'text'>): JSONContent {
  const nodes: JSONContent[] = []
  appendTextContent(nodes, draft.text)
  return {
    type: 'doc',
    content: [{ type: 'paragraph', ...(nodes.length > 0 && { content: nodes }) }]
  }
}

export function serializeComposerDocument(source: ComposerSerializableSource): ComposerSerializedDraft {
  const json = isEditorSource(source) ? source.getJSON() : source
  let text = ''

  const visitNode = (node: JSONContent) => {
    if (node.type === 'text') {
      text += node.text ?? ''
      return
    }
    if (node.type === 'hardBreak') {
      text += '\n'
      return
    }
    if (!node.content?.length) return

    if (node.type === 'doc') {
      node.content.forEach((child, index) => {
        if (index > 0) text += '\n'
        visitNode(child)
      })
      return
    }
    node.content.forEach(visitNode)
  }

  visitNode(json)
  return { text, tokens: [] }
}
