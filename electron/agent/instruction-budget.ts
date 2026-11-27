// The frozen English method and Chinese host contract are prose with a measured token cost.
export function estimateFrozenInstructionTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3)
}
