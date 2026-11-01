import iconKeys from './icon-keys.json'

const assets = import.meta.glob<string>('./art/*.svg', { eager: true, query: '?url', import: 'default' })
const iconKeyById = new Map(Object.entries(iconKeys))

export function cherryProviderIcon(id: string): string | undefined {
  const key = iconKeyById.get(id)
  return key ? assets[`./art/${key}.svg`] : undefined
}
