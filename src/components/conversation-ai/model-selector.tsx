// Adapted from Cherry Studio ModelSelector / ModelSelectorRow, f19aa72 (AGPL-3.0).
// Whomi supplies local models and selection persistence in place of Cherry data hooks.
import * as Popover from '@radix-ui/react-popover'
import { Box, Check, ChevronDown, Search } from 'lucide-react'
import { createContext, useContext, useId, useMemo, useRef, useState } from 'react'

export const ConversationPopoverOwner = createContext<string | undefined>(undefined)

export type ModelOption = { id: string; label: string; model?: string; version?: number; providerId?: string; providerName?: string; providerImage?: string; group?: string }

export function ModelSelector({ models, value, onSelect, label, disabled, describedBy }: {
  models: readonly ModelOption[]; value: string; onSelect: (id: string) => void
  label: string; disabled?: boolean; describedBy?: string
}) {
  const [open, setOpen] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const search = useRef<HTMLInputElement>(null)
  const listId = useId()
  const owner = useContext(ConversationPopoverOwner)
  const selected = models.find(model => model.id === value)
  const filtered = useMemo(() => {
    const query = searchText.trim().toLocaleLowerCase()
    return models.filter(model => !query || [model.label, model.model, model.providerName, model.group]
      .some(part => part?.toLocaleLowerCase().includes(query)))
  }, [models, searchText])
  const groups = useMemo(() => {
    const result = new Map<string, ModelOption[]>()
    for (const model of filtered) {
      const key = model.providerId ?? model.providerName ?? ''
      result.set(key, [...(result.get(key) ?? []), model])
    }
    return [...result.entries()]
  }, [filtered])
  const ordered = groups.flatMap(([, items]) => items)
  const choose = (id: string) => { onSelect(id); setOpen(false) }
  const selectedTitle = selected ? [selected.label, selected.providerName].filter(Boolean).join(' | ') : '选择模型'
  return <Popover.Root open={open} onOpenChange={next => { setOpen(next); if (next) { setSearchText(''); setActiveIndex(0) } }}>
    <Popover.Trigger asChild><button type="button" role="combobox" aria-label={label} aria-expanded={open}
      aria-controls={open ? listId : undefined} aria-haspopup="listbox" aria-describedby={describedBy}
      className="cherry-model-trigger" disabled={disabled} title={selectedTitle}>
      <Box aria-hidden="true" /><span>{selected?.label ?? (models.length ? '选择模型' : '暂无可用模型')}</span><ChevronDown aria-hidden="true" />
    </button></Popover.Trigger>
    <Popover.Portal><Popover.Content data-conversation-popover-owner={owner} className="cherry-model-selector" side="top" align="start" sideOffset={8} collisionPadding={12}
      onOpenAutoFocus={event => { event.preventDefault(); search.current?.focus() }}
      onEscapeKeyDown={event => event.stopPropagation()}>
      <div className="cherry-model-search"><Search aria-hidden="true" /><input ref={search} aria-label="搜索模型" placeholder="搜索模型…"
        value={searchText} aria-controls={listId} aria-activedescendant={ordered[activeIndex] ? `${listId}-${activeIndex}` : undefined}
        onChange={event => { setSearchText(event.target.value); setActiveIndex(0) }}
        onKeyDown={event => {
          if (event.key === 'Enter' && ordered[activeIndex]) { event.preventDefault(); choose(ordered[activeIndex].id) }
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault()
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? ordered.length - 1
              : Math.max(0, Math.min(ordered.length - 1, activeIndex + (event.key === 'ArrowDown' ? 1 : -1)))
            setActiveIndex(next)
            document.getElementById(`${listId}-${next}`)?.scrollIntoView?.({ block: 'nearest' })
          }
        }} /></div>
      <div id={listId} className="cherry-model-list" role="listbox" aria-label="模型">
        {groups.map(([key, items]) => <div key={key} role="group" aria-label={items[0]?.providerName ?? '模型'}>
          {items[0]?.providerName && <div className="cherry-model-group">{items[0].providerName}</div>}
          {items.map(model => { const index = ordered.indexOf(model); return <button type="button" role="option" key={model.id}
            id={`${listId}-${index}`} aria-selected={model.id === value} tabIndex={-1}
            className={`cherry-model-row${index === activeIndex ? ' is-active' : ''}`} title={[model.label, model.model].filter(Boolean).join('\n')}
            onPointerMove={() => setActiveIndex(index)} onClick={() => choose(model.id)}>
            {model.providerImage ? <img src={model.providerImage} alt="" /> : <Box aria-hidden="true" />}
            <span>{model.label}</span>{model.id === value && <Check aria-hidden="true" />}
          </button> })}
        </div>)}
        {!ordered.length && <p className="cherry-model-empty">{models.length ? '未找到模型' : '请在设置中添加模型'}</p>}
      </div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>
}
