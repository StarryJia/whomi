import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import { FileText } from 'lucide-react'
import clsx from 'clsx'
import type { DesktopApi } from '../shared/desktop-api'
import { isPersistedResult, useImport } from '../data/use-import'
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

  const isCancelledBeforeSave = snapshot?.status === 'cancelled' && !snapshot.results.some(isPersistedResult)
  const showInitial = !snapshot || isCancelledBeforeSave

  return <section className={clsx('file-import', api && 'import-workspace', dragging && 'is-dragging')} aria-label="文件导入"
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

    {showInitial ? (
      <div className="import-dropzone">
        <FileText className="import-file-icon" aria-hidden="true" />
        <h2 className="import-heading">{dragging ? '松开，选择聊天记录' : '选择聊天记录'}</h2>
        <div className="import-dropzone-actions">
          <button ref={choose} className="import-primary" type="button" aria-label={filename ? '重新选择文件' : '选择文件'}
            disabled={busy} onClick={() => { if (api) void controller.choose('files'); else input.current?.click() }}>
            {filename ? '重新选择文件' : '选择文件'}
          </button>
          {api && (
            <button className="import-secondary" type="button" disabled={busy} onClick={() => { void controller.choose('directory') }}>
              选择文件夹
            </button>
          )}
        </div>
        <span className="import-hint">{api ? '或将文件、文件夹拖到这里' : '或将文件拖到这里'}</span>
        <div className="import-feedback">
          {busy && <p className="import-muted" role="status">正在处理…</p>}
          {!api && <p className="import-muted">请在桌面应用中导入；此处仅预览文件选择。</p>}
          {filename && <p role="status"><span className="selected-filename">{filename}</span><span className="file-selection-note">已选择 · 尚未导入</span></p>}
          {error && <p className="import-error" role="alert">{error}</p>}
          {controller.error && <p className="import-error" role="alert" data-error-code={controller.error.code}>{controller.error.action}</p>}
        </div>
      </div>
    ) : (
      <>
        {(snapshot.status === 'preparing' || snapshot.status === 'scanning') && (
          <div className="import-step" role="region" aria-label="导入准备">
            <h2>{snapshot.status === 'scanning' ? '正在查找文件入口…' : '正在准备…'}</h2>
            <p className="import-muted">正在准备聊天记录来源…</p>
            <div className="import-step-actions">
              <button className="import-secondary" type="button" disabled={busy} onClick={() => { void controller.cancel() }}>取消导入</button>
            </div>
            {controller.error && <p className="import-error" role="alert">{controller.error.action}</p>}
          </div>
        )}
        {snapshot.status === 'awaiting_confirmation' && snapshot.discovery && (
          <DiscoveryChoices key={snapshot.jobId} discovery={snapshot.discovery} busy={busy}
            onStage={ids => { void controller.stage(ids) }} onCancel={() => { void controller.cancel() }}
            onRechoose={() => { if (api) void controller.choose('files'); else input.current?.click() }}
            error={controller.error} />
        )}
        {(snapshot.status === 'staging' || snapshot.status === 'validating') && (
          <div className="import-step" role="region" aria-label="解析进度">
            <h2>{snapshot.status === 'staging' ? '正在解析…' : '正在校验…'}</h2>
            <p className="import-muted">已检查 {snapshot.counts.seen} 条记录 · 有效 {snapshot.counts.validRecords} 条 · 异常 {snapshot.counts.invalidRecords} 条</p>
            <div className="import-step-actions">
              <button className="import-secondary" type="button" disabled={busy} onClick={() => { void controller.cancel() }}>取消导入</button>
            </div>
            {controller.error && <p className="import-error" role="alert">{controller.error.action}</p>}
          </div>
        )}
        {snapshot.status === 'awaiting_commit' && (
          <ImportCandidates key={snapshot.jobId} api={api!} candidates={snapshot.candidates} busy={busy}
            onCommit={decisions => { void controller.commit(decisions) }} preview={controller.preview}
            onCancel={() => { void controller.cancel() }} error={controller.error} />
        )}
        {(snapshot.status === 'committing' || snapshot.status === 'completed' || snapshot.status === 'partially_completed' || snapshot.status === 'failed' || (snapshot.status === 'cancelled' && snapshot.results.some(isPersistedResult))) && (
          <ImportProgress snapshot={snapshot} busy={busy} onCancel={() => { void controller.cancel() }} onOpen={onOpenConversation}
            onRetrySummary={id => { void controller.retrySummary(id) }} retriedSummaries={controller.retriedSummaries}
            onReset={controller.reset} onRechoose={() => { void controller.choose('files') }}
            onChooseFiles={() => { if (api) void controller.choose('files'); else input.current?.click() }}
            onChooseDirectory={api ? () => { void controller.choose('directory') } : undefined} />
        )}
      </>
    )}
  </section>
}
