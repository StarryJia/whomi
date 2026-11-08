import type { EditorOptions } from '@tiptap/core'

import { ComposerDocument, ComposerHardBreak, ComposerParagraph, ComposerText, ComposerUndoRedo } from './composerSchema'
import { Placeholder, type PlaceholderOptions } from './placeholder'

export interface ComposerEditorPresetOptions {
  placeholder?: PlaceholderOptions['placeholder']
  enableUndoRedo?: boolean
}

export function createComposerEditorPreset({
  placeholder,
  enableUndoRedo = true
}: ComposerEditorPresetOptions = {}): EditorOptions['extensions'] {
  return [
    ComposerDocument,
    ComposerParagraph,
    ComposerText,
    ComposerHardBreak,
    Placeholder.configure({
      placeholder,
      showOnlyWhenEditable: true,
      showOnlyCurrent: true,
      includeChildren: false
    }),
    ...(enableUndoRedo ? [ComposerUndoRedo] : [])
  ]
}
