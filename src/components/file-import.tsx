import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import { FileText } from 'lucide-react'
import clsx from 'clsx'
import type { DesktopApi } from '../shared/desktop-api'
import { isImportActive, isPersistedResult, useImport } from '../data/use-import'
import { DiscoveryChoices, ImportCandidates } from './import/import-candidates'
import { ImportProgress } from './import/import-progress'
import './import/import.css'

export function FileImport({ api, onSaved, onOpenConversation }: {
  api?: DesktopApi; onSaved?: (conversationIds: string[]) => void; onOpenConversation?: (conversationId: string) => void
}) {
  const controller = useImport(api)
  const { snapshot, busy } = controller
  const notified = useRef(new Set<string>())
  const input = useRef<HTMLInputElement>(null)
  const choose = useRef<HTMLButtonElement>(null)
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [filename, setFilename] = useState('')
  const [error, setError] = useState('')

  useLayoutEffect(() => { choose.current?.focus() }, [])
  useEffect(() => {
    if (!snapshot || !onSaved) return
    const ids = [...new Set(snapshot.results.filter(isPersistedResult).map(result => result.conversationId!))]
      .filter(id => !notified.current.has(`${snapshot.jobId}:${id}`))
    if (!ids.length) return
    ids.forEach(id => notified.current.add(`${snapshot.jobId}:${id}`))
    onSaved(ids)
  }, [snapshot, onSaved])
  useEffect(() => {
    // 防止文件落在接收区外时替换整个应用页面。
    const preventFileNavigation = (event: globalThis.DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
    }
    window.addEventListener('dragover', preventFileNavigation)
    window.addEventListener('drop', preventFileNavigation)
    return () => {
      window.removeEventListener('dragover', preventFileNavigation)
      window.removeEventListener('drop', preventFileNavigation)
    }
  }, [])

  function selectFiles(files: FileList | File[]) {
    if (!files.length) return
    if (files.length !== 1) { setError('请一次选择一个文件。'); return }
    setFilename(files[0].name)
    setError('')
  }

  function dropFile(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    if (api) { if (!busy && event.dataTransfer.files.length) void controller.drop(Array.from(event.dataTransfer.files)); return }
    const isDirectory = Array.from(event.dataTransfer.items ?? []).some(item => item.webkitGetAsEntry?.()?.isDirectory)
    if (isDirectory) { setError('请选择文件，不要拖入文件夹。'); return }
    selectFiles(event.dataTransfer.files)
  }

  return <section className={clsx('file-import', api && 'import-workspace', snapshot && 'has-job', dragging && 'is-dragging')} aria-label="文件导入"
    onDragEnter={event => {
      if (!event.dataTransfer.types.includes('Files')) return
      event.preventDefault()
      dragDepth.current += 1
      setDragging(true)
    }}
    onDragOver={event => {
      if (!event.dataTransfer.types.includes('Files')) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }}
    onDragLeave={() => {
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (!dragDepth.current) setDragging(false)
    }} onDrop={dropFile}>
    {!api && <input ref={input} className="visually-hidden" type="file" tabIndex={-1} aria-label="选择聊天记录文件"
      onChange={event => { if (event.target.files) selectFiles(event.target.files); event.target.value = '' }} />}
    <button ref={choose} className="file-drop-target" type="button" aria-label={filename ? '重新选择文件' : '选择文件'}
      disabled={busy} onClick={() => { if (api) void controller.choose('files'); else input.current?.click() }}>
      <FileText className="import-file-icon" aria-hidden="true" />
      <span className="import-heading">{dragging ? '松开，选择聊天记录' : '选择聊天记录'}</span>
      <span className="file-choose-action">{filename ? '重新选择文件' : '选择文件'}</span>
      <span className="import-hint">{api ? '或将文件、文件夹拖到这里' : '或将文件拖到这里'}</span>
    </button>
    {api && <div className="import-toolbar">
      <button className="import-secondary" type="button" disabled={busy} onClick={() => { void controller.choose('directory') }}>选择文件夹</button>
      {busy && <span className="import-muted" role="status">正在处理…</span>}
    </div>}
    <div className="import-feedback">
      {!api && <p className="import-muted">请在桌面应用中导入；此处仅预览文件选择。</p>}
      {filename && <p role="status"><span className="selected-filename">{filename}</span><span className="file-selection-note">已选择 · 尚未导入</span></p>}
      {error && <p className="import-error" role="alert">{error}</p>}
      {controller.error && <p className="import-error" role="alert" data-error-code={controller.error.code}>{controller.error.action}</p>}
    </div>
    {api && snapshot && <>
      {snapshot.status === 'awaiting_confirmation' && snapshot.discovery && <DiscoveryChoices key={snapshot.jobId} discovery={snapshot.discovery} busy={busy} onStage={ids => { void controller.stage(ids) }} />}
      {snapshot.status === 'awaiting_commit' && <ImportCandidates key={snapshot.jobId} api={api} candidates={snapshot.candidates} busy={busy}
        onCommit={decisions => { void controller.commit(decisions) }} preview={controller.preview} />}
      <ImportProgress snapshot={snapshot} busy={busy} onCancel={() => { void controller.cancel() }} onOpen={onOpenConversation}
        onRetrySummary={id => { void controller.retrySummary(id) }} retriedSummaries={controller.retriedSummaries} />
      {!isImportActive(snapshot) && snapshot.results.some(result => result.status === 'failed' || result.status === 'blocked') &&
        <button className="import-secondary" type="button" disabled={busy} onClick={() => { void controller.choose('files') }}>重新选择失败的来源</button>}
    </>}
  </section>
}
