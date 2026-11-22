import { useState } from 'react'
import { ArrowUpRight } from 'lucide-react'
import packageMetadata from '../../../../package.json'
import symbol from '../../../../assets/branding/whomi-symbol.png'
import wordmark from '../../../../assets/branding/whomi-wordmark.png'
import './about-whomi.css'

export function AboutWhomi() {
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
  </div>
}
