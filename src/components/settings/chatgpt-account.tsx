import { useEffect, useRef, useState } from 'react'
import { CircleCheck, Info, LogIn } from 'lucide-react'
import type { Provider, SettingsApi } from '../../shared/settings-contract'
import { subscriptionProviders, type ChatgptStatus, type SubscriptionProviderId } from '../../shared/chatgpt-plan'
import { Modal, Switch, errorText } from './common'
import { ProviderAvatar, presetAccounts } from './provider-presets'
import { CodexUsage } from './codex-usage'
import './chatgpt-account.css'

const accountNames: Record<SubscriptionProviderId, string> = { 'openai-codex': 'ChatGPT', 'grok-cli': 'Grok', copilot: 'GitHub' }
const welcomeKey = 'whomi:chatgpt-plan-welcome'
const disconnected: ChatgptStatus = { state: 'disconnected' }

export function unconfiguredAccount(id: SubscriptionProviderId): Provider {
  const { name, protocol, baseUrl } = subscriptionProviders[id]
  return { id: 'cherry:' + id, name, baseUrl, protocol, enabled: false, hasCredential: false }
}

function hasSeen(key: string) {
  try { return localStorage.getItem(key) === '1' } catch { return false }
}
function markSeen(key: string) {
  try { localStorage.setItem(key, '1') } catch { /* 当前操作不依赖本地偏好存储。 */ }
}
function accountError(cause: unknown) {
  if (cause && typeof cause === 'object' && 'action' in cause && typeof cause.action === 'string' && cause.action.trim()) return cause.action
  return errorText(cause)
}

export function ProviderAccount({ id, api, provider, refresh, onConnection }: {
  id: SubscriptionProviderId; api: SettingsApi; provider: Provider; refresh: (isCurrent: () => boolean) => Promise<void>; onConnection: (value: ChatgptStatus['state'] | 'unknown', accountId?: string) => void
}) {
  const accountName = accountNames[id], isCodex = id === 'openai-codex', seenKey = 'whomi:account-used:' + id
  const [status, setStatus] = useState<ChatgptStatus>(disconnected)
  const [unverified, setUnverified] = useState(false)
  const [hadAccount, setHadAccount] = useState(() => hasSeen(seenKey) || !!provider.planAccount)
  const [error, setError] = useState(''), [readError, setReadError] = useState(''), [working, setWorking] = useState(false)
  const [confirmExit, setConfirmExit] = useState(false), [welcome, setWelcome] = useState(false)
  const version = useRef(0), signing = useRef(false)
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  function receive(value: ChatgptStatus) {
    setReadError('')
    setUnverified(false)
    setStatus(value)
    onConnection(value.state, value.accountId)
    if (value.state === 'connected') { setHadAccount(true); markSeen(seenKey) }
  }
  function unreadable(cause: unknown) {
    setUnverified(true); onConnection('unknown'); setReadError(accountError(cause))
  }
  async function settle(value: ChatgptStatus, live: () => boolean) {
    if (!live()) return
    if (value.state !== 'connected') receive(value)
    await refreshRef.current(live)
    if (live() && value.state === 'connected') receive(value)
  }
  useEffect(() => {
    const current = ++version.current
    const live = () => current === version.current
    void api.getAccountStatus(id).then(async value => {
      if (!live()) return
      if (value.state === 'connected' || provider.planAccount) await settle(value, live)
      else receive(value)
    }).catch(cause => { if (live()) unreadable(cause) })
    return () => {
      version.current++
      if (signing.current) void api.cancelAccountSignIn(id).catch(() => {})
    }
  }, [api, id])

  useEffect(() => {
    if (status.state !== 'pending') return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      const sequence = version.current
      const live = () => active && sequence === version.current
      try {
        const value = await api.getAccountStatus(id)
        if (live()) setReadError('')
        if (live() && value.state === 'pending') receive(value)
        else if (live() && !signing.current) await settle(value, live)
      } catch (cause) { if (live()) setReadError(accountError(cause)) }
      if (active) timer = setTimeout(poll, 800)
    }
    timer = setTimeout(poll, 400)
    return () => { active = false; clearTimeout(timer) }
  }, [api, id, status.state])

  async function reconcile(live: () => boolean) {
    const value = await api.getAccountStatus(id)
    if (live()) await settle(value, live)
  }
  async function connect(newAccount: boolean) {
    if (working || signing.current) return
    const current = ++version.current, live = () => current === version.current
    signing.current = true
    receive({ state: 'pending' }); setError('')
    try {
      const value = await api.signInAccount(id, newAccount)
      if (!live()) return
      try { await settle(value, live) } catch (cause) { if (live()) unreadable(cause); return }
      if (live() && isCodex && value.state === 'connected') setWelcome(!hasSeen(welcomeKey))
    } catch (cause) {
      if (live()) {
        receive(disconnected)
        setError(accountError(cause))
        try { await reconcile(live) } catch (cause) { if (live()) unreadable(cause) }
      }
    } finally { if (live()) signing.current = false }
  }
  async function change(action: 'cancel' | 'logout' | 'toggle' | 'read') {
    if (working) return
    const current = ++version.current, live = () => current === version.current
    setWorking(true); setError(''); setReadError('')
    if (action !== 'toggle') onConnection('unknown')
    let failure = ''
    try {
      if (action === 'toggle') await api.setAccountEnabled(id, !provider.enabled)
      else if (action === 'cancel') await api.cancelAccountSignIn(id)
      else if (action === 'logout') await api.signOutAccount(id)
    } catch (cause) { failure = accountError(cause) }
    if (!live()) return
    signing.current = false; setConfirmExit(false)
    try { await reconcile(live) } catch (cause) { if (live()) unreadable(cause) }
    if (live()) { if (failure) setError(failure); setWorking(false) }
  }
  function dismissWelcome() { markSeen(welcomeKey); setWelcome(false) }
  const connected = !unverified && status.state === 'connected', pending = !unverified && status.state === 'pending'
  const needsPlanPermission = isCodex && status.state === 'disconnected' && status.planPermissionNeeded
  const deviceCode = id === 'copilot' && pending && status.userCode
  const deviceUrl = status.verificationUrl
  const trustedDeviceLink = id === 'copilot' && (deviceUrl === 'https://github.com/login/device' || deviceUrl === 'https://github.com/login/device/')
  return <>
    <div className="ms-detail-header"><div className="ms-detail-title"><ProviderAvatar name={provider.name} preset={presetAccounts.get(provider.id)} /><h2>{provider.name}</h2></div>
      <Switch label="启用服务商" checked={connected && provider.enabled} disabled={!connected || working} onChange={() => void change('toggle')} /></div>
    <section className={'account-login-card' + (connected ? ' is-connected' : '')} aria-label={accountName + ' 账户'}>
      {connected ? <CircleCheck aria-hidden="true" /> : <Info aria-hidden="true" />}
      <div><strong>{unverified ? '账户状态待确认' : connected ? '已连接 ' + accountName : needsPlanPermission ? 'ChatGPT 套餐权限' : isCodex ? '使用你的 ChatGPT 订阅登录' : '使用你的 ' + accountName + ' 账户登录'}</strong>
        {!unverified && <p role="status">{connected ? status.email || (isCodex ? '已授权使用 ChatGPT 套餐。' : '账户已授权。')
          : pending ? deviceCode ? '请在 GitHub 验证页面输入设备码。' : '请在浏览器中完成授权。'
          : needsPlanPermission ? '已登录 ' + (status.email || 'ChatGPT') + '，尚未授权使用套餐。'
          : '将在浏览器中完成授权。登录后，可使用' + (isCodex ? '你的 ChatGPT 套餐' : '账户中的模型') + '回答问题和整理记忆。'}</p>}
        {deviceCode && <div className="account-device-code"><code>{deviceCode}</code>{trustedDeviceLink && <a href={deviceUrl} target="_blank" rel="noreferrer">打开 GitHub 验证页面</a>}</div>}
        {unverified ? <button type="button" disabled={working} onClick={() => void change('read')}>重试读取状态</button>
          : connected ? <div className="account-actions"><button type="button" disabled={working} onClick={() => setConfirmExit(true)}>退出登录</button>
          </div>
          : pending ? <button type="button" disabled={working} onClick={() => void change('cancel')}>取消登录</button>
            : <div className="account-actions"><button type="button" disabled={working} onClick={() => void connect(false)}><LogIn size={14} aria-hidden="true" />{needsPlanPermission ? '授权使用 ChatGPT 套餐' : '使用 ' + accountName + ' 登录'}</button>
              {hadAccount && !needsPlanPermission && <button className="account-alternative" type="button" disabled={working} onClick={() => void connect(true)}>使用其他账号登录</button>}</div>}
        {(error || readError) && <p role="alert" className="ms-error">{error || readError}</p>}
      </div>
    </section>
    {isCodex && connected && <CodexUsage key={status.accountId ?? status.email} api={api} accountId={status.accountId ?? ''} />}
    {confirmExit && <Modal title={'退出 ' + accountName + ' 登录？'} busy={working} onClose={() => setConfirmExit(false)}>
      <div className="ms-modal-body">退出后，再次使用此账户的模型时需要登录。</div><footer className="ms-modal-footer"><button className="ms-button" onClick={() => setConfirmExit(false)} disabled={working}>取消</button><button className="ms-button ms-primary" disabled={working} onClick={() => void change('logout')}>确认退出</button></footer>
    </Modal>}
    {welcome && <Modal title="已启用 ChatGPT 套餐" onClose={dismissWelcome}>
      <div className="ms-modal-body">所选套餐模型的请求计入你的 ChatGPT 用量。你可以在 ChatGPT 设置中查看和管理。</div><footer className="ms-modal-footer"><button className="ms-button ms-primary" onClick={dismissWelcome}>知道了</button></footer>
    </Modal>}
  </>
}
