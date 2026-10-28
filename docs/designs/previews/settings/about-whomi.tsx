import { useRef, useState } from 'react'
import { ArrowUpRight, ChevronRight, X } from 'lucide-react'
import packageMetadata from '../../../../package.json'
import thirdPartyNotices from '../../../../THIRD_PARTY_NOTICES.md?raw'
import symbol from '../../../../assets/branding/whomi-symbol.png'
import wordmark from '../../../../assets/branding/whomi-wordmark.png'
import './about-whomi.css'
import { keepDialogFocus } from './dialog-focus'

function NoticeText({ text }: { text: string }) {
  return <>{text.split(/(\[[^\]]+\]\(https?:\/\/[^)]+\)|`[^`]+`)/g).map((part, index) => {
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/)
    if (link) return <a key={index} href={link[2]} target="_blank" rel="noopener noreferrer">{link[1]}</a>
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>
    return part
  })}</>
}

function Notices() {
  return <div className="aw-notices-text">{thirdPartyNotices.trim().split(/\n\s*\n/).map((block, index) => {
    if (block.startsWith('### ')) return <h4 key={index}>{block.slice(4)}</h4>
    if (block.startsWith('## ')) return <h3 key={index}>{block.slice(3)}</h3>
    if (block.startsWith('# ')) return <h2 key={index}>{block.slice(2)}</h2>
    return <p key={index}><NoticeText text={block} /></p>
  })}</div>
}

export function AboutWhomi() {
  const noticesDialog = useRef<HTMLDialogElement>(null)
  const noticesButton = useRef<HTMLButtonElement>(null)
  const [debugMode, setDebugMode] = useState(false)

  return <div className="aw-page">
    <header className="aw-page-heading">
      <h1 tabIndex={-1}>关于whomi</h1>
    </header>
    <section className="aw-identity" aria-label="Whomi 项目信息">
      <img className="aw-symbol" src={symbol} alt="Whomi 图形标识" />
      <span className="aw-wordmark"><img src={wordmark} alt="Whomi" /></span>
      <p className="aw-version">版本 {packageMetadata.version}</p>
      <p className="aw-introduction">一个了解你的程序</p>
    </section>

    <section className="aw-information" aria-label="项目与许可">
      <a className="aw-information-row" href="https://github.com/StarryJia/whomi" target="_blank" rel="noopener noreferrer">
        <span>项目仓库</span><span className="aw-link-value">StarryJia/whomi <ArrowUpRight size={16} aria-hidden="true" /></span>
      </a>
      <button ref={noticesButton} className="aw-information-row" type="button"
        onClick={() => { noticesDialog.current?.showModal(); noticesDialog.current?.querySelector<HTMLElement>('h2')?.focus() }}>
        <span>第三方声明</span><ChevronRight size={17} aria-hidden="true" />
      </button>
      <div className="aw-information-row aw-information-static">
        <span>项目许可</span><span className="aw-muted">待确认</span>
      </div>
    </section>

    <section className="aw-debug" aria-labelledby="aw-debug-title">
      <h2 id="aw-debug-title">调试面板</h2>
      <div className="aw-debug-control">
        <span id="aw-debug-label">调试模式</span>
        <button type="button" className="aw-debug-switch" role="switch" aria-checked={debugMode}
          aria-labelledby="aw-debug-label" aria-controls="aw-debug-content" onClick={() => setDebugMode(value => !value)}>
          <span />
        </button>
      </div>
      <div id="aw-debug-content" hidden={!debugMode} className="aw-debug-content">
        <p>演示信息</p>
        <dl>
          <div><dt>运行环境</dt><dd>独立前端预览</dd></div>
          <div><dt>版本</dt><dd>{packageMetadata.version}</dd></div>
        </dl>
      </div>
    </section>

    <dialog ref={noticesDialog} className="aw-dialog" aria-labelledby="aw-notices-title" onKeyDown={keepDialogFocus}
      onClose={() => noticesButton.current?.focus()}
      onClick={event => { if (event.target === event.currentTarget) noticesDialog.current?.close() }}>
      <div className="aw-dialog-content">
        <header className="aw-dialog-heading">
          <h2 id="aw-notices-title" tabIndex={-1} autoFocus>第三方声明</h2>
          <button type="button" className="aw-close" aria-label="关闭第三方声明"
            onClick={() => noticesDialog.current?.close()}><X size={20} aria-hidden="true" /></button>
        </header>
        <p className="aw-notices-source">来自项目已有的 THIRD_PARTY_NOTICES.md。</p>
        <Notices />
      </div>
    </dialog>
  </div>
}
