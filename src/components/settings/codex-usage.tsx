import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUpRight, ChevronRight, RefreshCw } from 'lucide-react'
import type { AccountUsage, SettingsApi } from '../../shared/settings-contract'
import type { CodexQuotaAction, CodexQuotaState } from '../../shared/codex-quota'
import { chatgptUsageUrl } from '../../shared/chatgpt-plan'
import { errorText } from './common'
import './codex-usage.css'

type UsageApi = Pick<SettingsApi, 'getAccountUsage' | 'getCodexQuota'>
const date = (time: number) => new Date(time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
const percent = (value: number) => value > 0 && value < 0.1 ? '<0.1%' : value > 99.9 && value < 100 ? '>99.9%' : `${value.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`
const windowName = (seconds: number) => seconds === 604800 ? '每周额度' : seconds % 86400 === 0 ? `${seconds / 86400} 天额度` : seconds % 3600 === 0 ? `${seconds / 3600} 小时额度` : seconds % 60 === 0 ? `${seconds / 60} 分钟额度` : `${seconds} 秒额度`
const unavailableText = {
  'source-changed': '本机 Codex 的账号或工作区已变化，请重新连接。',
  'login-required': '请在 Codex 中使用 ChatGPT 重新登录，然后重试连接。',
  unsupported: '此 Codex 账户暂不可读取额度，请在 ChatGPT 管理用量。',
}

function LocalUsage({ api }: { api: UsageApi }) {
  const [open, setOpen] = useState(false), [attempt, setAttempt] = useState(0)
  const [usage, setUsage] = useState<AccountUsage>(), [loading, setLoading] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    if (!open) return
    let current = true
    setLoading(true); setError('')
    void api.getAccountUsage('openai-codex').then(value => { if (current) setUsage(value) })
      .catch(cause => { if (current) setError(errorText(cause)) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [api, open, attempt])
  const format = (value: number | null) => value === null ? '未记录' : value.toLocaleString('zh-CN')
  return <details className="codex-local-usage" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>本机使用记录<ChevronRight size={16} aria-hidden="true" /></summary>
    {open && <div className="codex-local-content">
      <div className="codex-local-heading"><p>Whomi 当前账号的对话与记忆生成用量</p><button type="button" className="ms-text-button" disabled={loading} onClick={() => setAttempt(value => value + 1)}>{error ? '重读本机用量' : '刷新本机用量'}</button></div>
      {usage && (usage.requests > 0 ? <><dl><div><dt>输入词元</dt><dd>{format(usage.inputTokens)}</dd></div><div><dt>输出词元</dt><dd>{format(usage.outputTokens)}</dd></div></dl><p>已记录 {usage.requests.toLocaleString('zh-CN')} 次请求{usage.partial ? '，部分请求未返回完整用量。' : '。'}</p></> : <p>暂无本机请求记录。</p>)}
      {loading && !usage && <p role="status">正在读取本机用量…</p>}
      {error && <p className="ms-error" role="alert">{error}</p>}
    </div>}
  </details>
}

export function CodexUsage({ api, accountId }: { api: UsageApi; accountId: string }) {
  const [quota, setQuota] = useState<CodexQuotaState>({ state: 'disconnected' })
  const [busy, setBusy] = useState<CodexQuotaAction | null>('read'), [error, setError] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const region = useRef<HTMLElement>(null), focusOrigin = useRef<HTMLElement | null>(null)
  const version = useRef(0), connecting = useRef(false)
  useLayoutEffect(() => {
    if (focusOrigin.current && !focusOrigin.current.isConnected && document.activeElement === document.body) {
      const next = region.current?.querySelector<HTMLElement>('[data-quota-primary]')
      next?.focus(); focusOrigin.current = next ?? focusOrigin.current
    }
  }, [busy, quota])
  async function run(action: CodexQuotaAction) {
    if (document.activeElement instanceof HTMLElement && region.current?.contains(document.activeElement)) focusOrigin.current = document.activeElement
    const sequence = ++version.current
    connecting.current = action === 'connect'
    setBusy(action); setError('')
    try {
      const result = await api.getCodexQuota(accountId, action)
      if (sequence === version.current) {
        setQuota(result)
        setAnnouncement(result.state === 'ready' ? '已更新本机 Codex 额度。' : result.state === 'unavailable' ? unavailableText[result.reason] : action === 'disconnect' ? '已断开本机 Codex 用量。' : '')
      }
    } catch (cause) {
      if (sequence !== version.current) return
      const recoverable = !!cause && typeof cause === 'object' && 'code' in cause && cause.code === 'CODEX_QUOTA_NETWORK'
      if (!recoverable) setQuota({ state: 'disconnected' })
      setError(errorText(cause))
    } finally {
      if (sequence === version.current) { setBusy(null); connecting.current = false }
    }
  }
  useEffect(() => {
    void run('read')
    return () => { version.current++; if (connecting.current) void api.getCodexQuota(accountId, 'disconnect').catch(() => {}) }
  }, [api, accountId])
  const ready = quota.state === 'ready'
  return <div className="codex-usage">
    <section ref={region} className="codex-quota" aria-label="剩余额度">
      <span className="codex-announcement" role="status">{announcement}</span>
      <header className="codex-quota-header"><h3>剩余额度</h3><div className="codex-quota-actions">
        {ready && <button data-quota-primary className="ms-text-button codex-refresh" type="button" aria-label={busy ? '正在刷新' : error ? '重试读取额度' : '刷新额度'} disabled={busy !== null} onClick={() => void run('read')}><RefreshCw size={15} aria-hidden="true" />{busy ? '刷新中' : error ? '重试' : '刷新'}</button>}
        {ready && <time dateTime={new Date(quota.updatedAt).toISOString()}>更新于 {date(quota.updatedAt)}</time>}
      </div></header>
      {ready ? <>
        <div className="codex-quota-source"><div><span title={quota.source.authFile}>来源：本机 Codex 登录文件</span><span>{quota.source.email}</span><span>工作区：{quota.source.workspaceId}</span></div><button className="ms-text-button" type="button" disabled={busy === 'disconnect'} onClick={() => void run('disconnect')}>断开</button></div>
        <div className="codex-quota-windows">
          {quota.windows.map((window, index) => <div className="codex-quota-row" key={`${window.seconds}-${index}`}>
            <span className="codex-quota-label">{windowName(window.seconds)}</span>
            <div className="codex-quota-track" role="meter" aria-label={windowName(window.seconds)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.remainingPercent} aria-valuetext={`剩余 ${window.remainingPercent}%`}><span style={{ transform: `scaleX(${window.remainingPercent / 100})` }} /></div>
            <span className="codex-quota-value"><strong>{percent(window.remainingPercent)}</strong><span>剩余</span></span>
            <span className="codex-quota-reset">{window.resetsAt === null ? '重置时间未提供' : `${date(window.resetsAt)} 重置`}</span>
          </div>)}
          {!quota.windows.length && <p className="codex-quota-empty">暂未返回额度周期，请稍后刷新。</p>}
        </div>
      </> : <div className="codex-quota-empty">
        {busy ? <p role="status">{busy === 'connect' ? '正在连接本机 Codex…' : busy === 'disconnect' ? '正在断开…' : '正在读取额度…'}</p>
          : <><p>{quota.state === 'unavailable' ? unavailableText[quota.reason] : '连接本机 Codex 登录文件，查看该账号的剩余额度。'}</p><div className="codex-empty-actions"><button data-quota-primary className="ms-button" type="button" onClick={() => void run('connect')}>{quota.state === 'unavailable' ? '重新连接本机 Codex' : '连接本机 Codex 用量'}</button>{(quota.state === 'unavailable' || error) && <button className="ms-text-button" type="button" onClick={() => void run('disconnect')}>断开</button>}</div></>}
        {busy === 'connect' && <button data-quota-primary className="ms-text-button" type="button" onClick={() => void run('disconnect')}>取消连接</button>}
      </div>}
      {error && <p className="ms-error codex-quota-error" role="alert">{error}{ready ? ' 当前显示上次结果。' : ''}</p>}
      <footer className="codex-quota-footer"><a href={chatgptUsageUrl} target="_blank" rel="noreferrer">在 ChatGPT 管理用量<ArrowUpRight size={14} aria-hidden="true" /></a></footer>
    </section>
    <LocalUsage api={api} />
  </div>
}
