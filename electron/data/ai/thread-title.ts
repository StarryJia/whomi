export function threadTitle(prompt: string): string {
  const characters = [...prompt.trim().replace(/\s+/g, ' ')]
  return characters.slice(0, 40).join('') + (characters.length > 40 ? '…' : '')
}
