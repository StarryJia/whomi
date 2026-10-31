// From Cherry Studio src/renderer/utils/naming.ts, f19aa72 (AGPL-3.0).
export const getDefaultGroupName = (id: string, provider?: string): string => {
  const str = id.toLowerCase()
  let firstDelimiters = ['/', ' ', ':']
  let secondDelimiters = ['-', '_']
  if (provider && ['aihubmix', 'silicon', 'ocoolai', 'o3', 'dmxapi'].includes(provider.toLowerCase())) {
    firstDelimiters = ['/', ' ', '-', '_', ':']
    secondDelimiters = []
  }
  for (const delimiter of firstDelimiters) if (str.includes(delimiter)) return str.split(delimiter)[0]
  for (const delimiter of secondDelimiters) {
    if (str.includes(delimiter)) { const parts = str.split(delimiter); return parts.length > 1 ? parts[0] + '-' + parts[1] : parts[0] }
  }
  return str
}
