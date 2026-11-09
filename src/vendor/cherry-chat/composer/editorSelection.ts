import type { Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

function getComposerInputLeafText(node: ProseMirrorNode) {
  if (node.type.name === 'hardBreak') return '\n'
  return ''
}

function getComposerTextOffset(editor: Editor, position: number) {
  return editor.state.doc.textBetween(0, position, '\n', getComposerInputLeafText).length
}

export function getComposerPositionAtTextOffset(editor: Editor, textOffset: number) {
  const targetOffset = Math.max(0, textOffset)
  let low = 0
  let high = editor.state.doc.content.size

  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (getComposerTextOffset(editor, mid) < targetOffset) {
      low = mid + 1
    } else {
      high = mid
    }
  }

  return Math.max(1, Math.min(low, editor.state.doc.content.size))
}
