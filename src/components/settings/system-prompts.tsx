import { useCallback, useEffect, useRef, useState } from 'react'
import { SettingHelp } from './setting-help'
import type { SettingsApi } from '../../shared/settings-contract'
import { defaultPrompts, maxPromptLength, promptCatalog, validatePrompt, type PromptId, type PromptValues } from '../../shared/system-prompts'
import { errorText, LeaveDialog, Modal, type LeaveGuard } from './common'
import { ExceptionNotice } from '../ui/exception-notices'
import './system-prompts.css'

type Props = { api: Pick<SettingsApi, 'getPrompts' | 'savePrompt'>; registerGuard: (guard: LeaveGuard | null) => void; onBusy: (busy: boolean) => void }
export function SystemPrompts({ api, registerGuard, onBusy }: Props) {
  const [values, setValues] = useState<PromptValues | null>(null)
  const [loadError, setLoadError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [active, setActive] = useState<PromptId | null>(null)
  useEffect(() => {
    let alive = true
    setLoadError('')
    api.getPrompts().then(result => { if (alive) setValues(result) }, cause => { if (alive) setLoadError(errorText(cause, '提示词读取失败，请重试。')) })
    return () => { alive = false }
  }, [api, attempt])
  return <div className="prompt-settings">
    <div className="prompt-content">
      <h2 tabIndex={-1}>系统提示词</h2>
      {!values ? <div className="prompt-load">{loadError ? <><ExceptionNotice title="无法读取提示词" detail={loadError} /><button className="ms-button" onClick={() => setAttempt(value => value + 1)}>重新读取</button></> : <p role="status">正在读取提示词…</p>}</div> :
        <ul className="prompt-list">{promptCatalog.map(item => <li key={item.id} className={active === item.id ? 'is-editing' : undefined}>
          <div className="prompt-name"><span>{item.name}</span>
            <SettingHelp name={item.name}>
              <dl><dt>作用</dt><dd>{item.purpose}</dd><dt>对应功能</dt><dd>{item.feature}</dd></dl>
            </SettingHelp>
          </div>
          <button className="prompt-edit" aria-label={`编辑${item.name}`} onClick={() => setActive(item.id)}>编辑</button>
        </li>)}</ul>}
    </div>
    {active && values && <PromptEditor key={active} id={active} value={values[active]} api={api} registerGuard={registerGuard} onBusy={onBusy}
      onSaved={setValues} onClose={() => setActive(null)} />}
  </div>
}

function PromptEditor({ id, value, api, onSaved, onClose, registerGuard, onBusy }: Omit<Props, 'api'> & {
  id: PromptId; value: string; api: Props['api']; onSaved: (values: PromptValues) => void; onClose: () => void
}) {
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState('')
  const [invalid, setInvalid] = useState(false)
  const [busy, setBusy] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const pending = useRef<(() => void) | null>(null)
  const saving = useRef(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const dirty = draft !== value
  const name = promptCatalog.find(item => item.id === id)!.name
  const requestLeave = useCallback((action: () => void) => {
    if (saving.current) return
    if (dirty) { pending.current = action; setLeaving(true) } else action()
  }, [dirty])
  useEffect(() => { registerGuard(requestLeave); return () => registerGuard(null) }, [registerGuard, requestLeave])
  async function save(after: () => void = onClose) {
    if (saving.current) return
    try { validatePrompt(id, draft) } catch (cause) { setInvalid(true); setError(errorText(cause, '请检查提示词后重试。')); field.current?.focus(); return }
    saving.current = true; setBusy(true); onBusy(true); setInvalid(false); setError('')
    try { const saved = await api.savePrompt(id, draft); onSaved(saved); after() }
    catch (cause) { setError(errorText(cause, '提示词保存失败，请重试。')) }
    finally { saving.current = false; setBusy(false); onBusy(false) }
  }
  return <>
    <Modal title={`编辑提示词 · ${name}`} className="prompt-drawer" busy={busy} onClose={() => requestLeave(onClose)}>
      <div className="prompt-editor-body">
        <textarea ref={field} aria-label="提示词内容" aria-invalid={!!error && invalid} aria-describedby={error && !leaving && invalid ? 'prompt-save-error' : undefined}
          data-initial-focus value={draft} maxLength={maxPromptLength} disabled={busy} spellCheck={false}
          onChange={event => { setDraft(event.target.value); setError('') }} />
        {error && !leaving && (invalid ? <p id="prompt-save-error" className="ms-error" role="alert">{error}</p>
          : <ExceptionNotice title="无法保存提示词" detail={error} className="ms-error" />)}
      </div>
      <footer className="ms-modal-footer prompt-editor-footer">
        <button className="prompt-restore" disabled={busy || draft === defaultPrompts[id]} onClick={() => { setDraft(defaultPrompts[id]); setError(''); field.current?.focus() }}>恢复默认</button>
        <button className="ms-button" disabled={busy} onClick={() => requestLeave(onClose)}>取消</button>
        <button className="ms-button ms-primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button>
      </footer>
    </Modal>
    {leaving && <LeaveDialog busy={busy} error={error} onContinue={() => { setLeaving(false); pending.current = null }}
      onDiscard={() => { const action = pending.current; setLeaving(false); pending.current = null; action?.() }}
      onSave={() => void save(() => { const action = pending.current; setLeaving(false); pending.current = null; onClose(); action?.() })} />}
  </>
}
