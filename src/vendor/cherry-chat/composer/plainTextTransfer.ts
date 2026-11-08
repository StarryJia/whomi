// Cherry's private fragments, HTML, and files must never reach the editor parser.
export function readPlainTextTransfer(data: DataTransfer | null) {
  return (data?.getData('text/plain') || data?.getData('text') || '').replace(/\r\n?/g, '\n')
}

export function isComposerEnter(event: Pick<KeyboardEvent, 'key' | 'isComposing' | 'keyCode'>) {
  return (event.key === 'Enter' || event.key === 'NumpadEnter') && !event.isComposing && event.keyCode !== 229
}

export function matchesComposerEnter(
  event: Pick<KeyboardEvent, 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>,
  shift: boolean,
) {
  return event.shiftKey === shift && !event.ctrlKey && !event.metaKey && !event.altKey
}
