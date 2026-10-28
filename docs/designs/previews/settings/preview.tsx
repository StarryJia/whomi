import { useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowLeft, Info, MessageSquare, Settings, SlidersHorizontal } from 'lucide-react'
import symbol from '../../../../assets/branding/whomi-symbol.png'
import wordmark from '../../../../assets/branding/whomi-wordmark.png'
import { ModelServices } from './model-services'
import { MessageProcessing } from './message-processing'
import { AboutWhomi } from './about-whomi'
import '../../../../src/styles.css'
import './preview.css'

type Category = 'models' | 'messages' | 'about'
const categories = [
  { id: 'models', label: '模型服务', icon: SlidersHorizontal },
  { id: 'messages', label: '消息处理', icon: MessageSquare },
  { id: 'about', label: '关于whomi', icon: Info },
] as const

function Brand() {
  return <div className="sp-brand" aria-label="Whomi">
    <span className="brand-symbol"><img src={symbol} alt="" /></span>
    <span className="brand-wordmark"><img src={wordmark} alt="Whomi" /></span>
  </div>
}

function SettingsPreview() {
  const [inside, setInside] = useState(true)
  const [category, setCategory] = useState<Category>('models')
  const [scenario, setScenario] = useState('normal')
  const [resetKey, setResetKey] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)
  const content = useRef<HTMLElement>(null)
  const entry = useRef<HTMLButtonElement>(null)
  const navigationButton = useRef<HTMLButtonElement>(null)
  const shouldFocus = useRef(false)

  useLayoutEffect(() => {
    if (!shouldFocus.current) return
    shouldFocus.current = false
    if (inside) Array.from(content.current?.querySelectorAll<HTMLElement>('h1,h2') ?? []).find(title => title.getClientRects().length > 0)?.focus()
    else entry.current?.focus()
  }, [category, inside])

  function changeCategory(next: Category) {
    shouldFocus.current = true
    setCategory(next)
    setMenuOpen(false)
  }

  return <div className="sp-preview">
    <div className="sp-demo-bar" role="note" aria-label="预览说明">
      <span><strong>独立交互预览</strong> · 示例数据 · 刷新后重置</span>
      <span>不连接服务，不保存配置，不处理聊天数据。</span>
      <details className="sp-demo-options">
        <summary>演示选项</summary>
        <div className="sp-demo-options-content">
          <label htmlFor="sp-scenario">模型服务场景</label>
          <select id="sp-scenario" value={scenario} onChange={event => { setScenario(event.target.value); setResetKey(key => key + 1) }}>
            <option value="normal">常规演示</option>
            <option value="empty-providers">无服务商</option>
            <option value="empty-models">无模型</option>
            <option value="long">长名称与长地址</option>
            <option value="failure">模拟检测失败</option>
          </select>
          <button type="button" onClick={() => setResetKey(key => key + 1)}>重置本页演示</button>
          <p>开关初始状态、数值范围、规则默认选择和正式保存方式均待确认。预置服务商清单等待提供。</p>
        </div>
      </details>
    </div>
    <div className="sp-workspace" hidden={!inside}>
      <aside className="sp-sidebar">
        <Brand />
        <button className="sp-return" type="button" onClick={() => { shouldFocus.current = true; setInside(false) }}><ArrowLeft aria-hidden="true" />返回</button>
        <div className="sp-sidebar-heading">
          <h1>设置</h1>
          <button ref={navigationButton} className="sp-category-toggle" type="button" aria-expanded={menuOpen} aria-controls="sp-navigation"
            onClick={() => setMenuOpen(value => !value)}>分类</button>
        </div>
        <nav id="sp-navigation" className={menuOpen ? 'sp-navigation is-open' : 'sp-navigation'} aria-label="设置分类"
          onKeyDown={event => { if (event.key === 'Escape' && menuOpen) { setMenuOpen(false); navigationButton.current?.focus() } }}>
          {categories.map(({ id, label, icon: Icon }) => <button key={id} type="button" aria-current={category === id ? 'page' : undefined}
            onClick={() => changeCategory(id)}><Icon aria-hidden="true" />{label}</button>)}
        </nav>
      </aside>
      <main ref={content} className="sp-main" aria-label={categories.find(item => item.id === category)?.label}>
        <div hidden={category !== 'models'}><ModelServices key={scenario + resetKey} scenario={scenario} /></div>
        <div hidden={category !== 'messages'}><MessageProcessing key={resetKey} /></div>
        <div hidden={category !== 'about'}><AboutWhomi /></div>
      </main>
    </div>
    <div className="sp-origin" hidden={inside}>
      <aside className="sp-sidebar"><Brand /><button ref={entry} className="sp-origin-entry" type="button"
        onClick={() => { shouldFocus.current = true; setInside(true) }}><Settings aria-hidden="true" />设置</button></aside>
      <main><h1>演示入口</h1><p>点击底部设置，查看设置工作区。</p><p>此入口只用于验证进入和返回操作，未修改正式客户端。</p></main>
    </div>
  </div>
}

createRoot(document.getElementById('root')!).render(<SettingsPreview />)
