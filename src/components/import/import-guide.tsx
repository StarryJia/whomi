import { useLayoutEffect, useRef } from 'react'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import { platformGuides, type GuidePlatform } from './platform-guides'
import './import-guide.css'

export function ImportGuide({ platform, onSelect, onBack }: {
  platform: GuidePlatform
  onSelect: (platform: GuidePlatform) => void
  onBack: () => void
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  const current = platformGuides.find(item => item.id === platform)!
  useLayoutEffect(() => { heading.current?.focus({ preventScroll: true }) }, [])

  return <section className="import-instructions" aria-labelledby="guide-title" onKeyDown={event => {
    if (event.key === 'Escape' && !(event.target instanceof HTMLSelectElement)) {
      event.stopPropagation()
      onBack()
    }
  }}>
    <button className="guide-back" type="button" onClick={onBack}><ArrowLeft size={16} aria-hidden="true" />返回导入</button>
    <h1 id="guide-title" ref={heading} tabIndex={-1}>操作指引</h1>
    <p className="guide-intro">选择平台，查看导出和导入步骤。</p>
    <div className="guide-layout">
      <nav className="guide-platforms" aria-label="聊天平台">
        <span className="guide-index-label">聊天平台</span>
        {platformGuides.map(item => <button type="button" key={item.id} className="guide-platform"
          aria-current={platform === item.id ? 'true' : undefined} aria-controls="guide-steps" onClick={() => onSelect(item.id)}>
          <img src={new URL(`./platform-marks/${item.id}.svg`, import.meta.url).href} alt="" width="22" height="22" />
          {item.name}{platform === item.id && <ChevronRight size={14} aria-hidden="true" />}
        </button>)}
      </nav>
      <label className="guide-platform-select">聊天平台
        <select value={platform} aria-controls="guide-steps" onChange={event => onSelect(event.target.value as GuidePlatform)}>
          {platformGuides.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      <section id="guide-steps" className="guide-steps" aria-labelledby="guide-platform-name">
        <h2 id="guide-platform-name">{current.name}</h2>
        <p className="guide-format">导入内容：{current.format}</p>
        <ol>{current.steps.map(([title, text]) => <li key={title}><h3>{title}</h3><p>{text}</p></li>)}</ol>
      </section>
    </div>
  </section>
}
