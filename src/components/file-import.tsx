import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import { BookOpen, Download, FolderOpen } from 'lucide-react'
import clsx from 'clsx'
import type { DesktopApi } from '../shared/desktop-api'
import type { ImportFailurePhase } from '../shared/import-contract'
import { hasConfirmedImport, importFailureNotice, isPersistedResult, useImport } from '../data/use-import'
import { ConversationChoices } from './import/import-candidates'
import { ImportProgress } from './import/import-progress'
import { ImportStateMark } from './import/import-artwork'
import { ImportGuide } from './import/import-guide'
import type { GuidePlatform } from './import/platform-guides'
import { useExceptionNotice } from './ui/exception-notices'
import './import/import.css'

const failureTitles: Record<ImportFailurePhase, string> = {
  source: '无法读取来源',
  scan: '未能找到聊天记录',
  parse: '解析失败',
  save: '保存失败',
  confirm: '无法确认保存结果',
  statistics: '会话统计更新失败',
  cancel: '取消导入失败',
}

function failureTitle(phase: ImportFailurePhase, code: string) {
  if (code === 'PICKER_FAILED') return '无法打开选择窗口'
  if (code === 'NO_IMPORTABLE_CONVERSATIONS') return '没有可导入的会话'
  return failureTitles[phase]
}

export function FileImport({ api, onSaved, onCancelled, onOpenConversation }: {
  api?: DesktopApi
  onSaved?: (conversationIds: string[]) => void
  onCancelled?: () => void
  onOpenConversation?: (conversationId: string) => void
}) {
  const controller = useImport(api)
  const { snapshot, busy, failure, failedJobId, pickerOpen, cancelling, openingLog, logError } = controller
  const notified = useRef(new Set<string>())
  const cancelled = useRef(new Set<string>())
  const started = useRef(new Set<string>())
  const input = useRef<HTMLInputElement>(null)
  const choose = useRef<HTMLButtonElement>(null)
  const failureHeading = useRef<HTMLHeadingElement>(null)
  const guideButton = useRef<HTMLButtonElement>(null)
  const restoreGuideFocus = useRef(false)
  const [readingGuide, setReadingGuide] = useState(false)
  const [platform, setPlatform] = useState<GuidePlatform>('telegram')
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [filename, setFilename] = useState('')
  const [previewError, setPreviewError] = useState('')

  const cancelledCompletely = snapshot?.status === 'cancelled' && !snapshot.results.some(isPersistedResult)
  const showInitial = !failure && (!snapshot || snapshot.status === 'cancelled')
  const canDrop = showInitial && !busy
  const candidates = snapshot?.candidates.filter(candidate => candidate.status === 'staged') ?? []
  const isSelection = snapshot?.status === 'awaiting_commit' && candidates.length > 1
  const notice = importFailureNotice(failure, failedJobId, logError)
  const noticeKey = notice?.key
  useExceptionNotice(notice ?? (previewError ? { key: 'import:preview', title: previewError } : null))

  useEffect(() => {
    if (!api || !snapshot || busy || failure) return
    const key = `${snapshot.jobId}:${snapshot.status}`
    if (started.current.has(key)) return
    if (snapshot.status === 'awaiting_confirmation' && snapshot.discovery?.entries.length) {
      started.current.add(key)
      void controller.stage(snapshot.discovery.entries.map(entry => entry.entryId))
    } else if (snapshot.status === 'awaiting_commit' && candidates.length === 1) {
      started.current.add(key)
      void controller.commit([])
    }
  }, [api, snapshot, busy, failure, controller, candidates.length])

  useLayoutEffect(() => {
    if (!showInitial || busy || readingGuide) return
    if (restoreGuideFocus.current) {
      restoreGuideFocus.current = false
      guideButton.current?.focus()
    } else choose.current?.focus()
  }, [showInitial, busy, readingGuide])
  useLayoutEffect(() => {
    if (noticeKey && !cancelling) failureHeading.current?.focus({ preventScroll: true })
  }, [noticeKey, cancelling])

  useEffect(() => {
    if (!snapshot || !onSaved || failure || cancelling || !hasConfirmedImport(snapshot) || notified.current.has(snapshot.jobId)) return
    notified.current.add(snapshot.jobId)
    const ids = [...new Set(snapshot.results.map(result => result.conversationId!))]
    onSaved(ids)
  }, [snapshot, failure, cancelling, onSaved])
  useEffect(() => {
    if (!snapshot || !cancelledCompletely || cancelling || cancelled.current.has(snapshot.jobId)) return
    cancelled.current.add(snapshot.jobId)
    onCancelled?.()
  }, [snapshot, cancelledCompletely, cancelling, onCancelled])
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
    if (files.length !== 1) { setPreviewError('请一次选择一个文件。'); return }
    setFilename(files[0].name)
    setPreviewError('')
  }

  function dropFile(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    if (!canDrop) return
    if (api) {
      if (event.dataTransfer.files.length) void controller.drop(Array.from(event.dataTransfer.files))
      return
    }
    const isDirectory = Array.from(event.dataTransfer.items ?? []).some(item => item.webkitGetAsEntry?.()?.isDirectory)
    if (isDirectory) { setPreviewError('请选择文件。'); return }
    selectFiles(event.dataTransfer.files)
  }

  const cancel = () => { void controller.cancel() }
  const scan = snapshot?.status === 'scanning'
  const prepare = snapshot?.status === 'preparing'
  const parse = snapshot?.status === 'awaiting_confirmation' || snapshot?.status === 'staging' || snapshot?.status === 'validating'
  const phaseTitle = scan ? '正在查找聊天记录' : prepare ? '正在准备'
    : snapshot?.status === 'validating' ? '正在校验' : '正在解析'

  if (showInitial && readingGuide) return <ImportGuide platform={platform} onSelect={setPlatform} onBack={() => {
    restoreGuideFocus.current = true
    setReadingGuide(false)
  }} />

  return <section className={clsx('file-import import-workspace', dragging && 'is-dragging')} aria-label="文件导入"
    onDragEnter={event => {
      if (!canDrop || !event.dataTransfer.types.includes('Files')) return
      event.preventDefault()
      dragDepth.current += 1
      setDragging(true)
    }}
    onDragOver={event => {
      if (!event.dataTransfer.types.includes('Files')) return
      event.preventDefault()
      event.dataTransfer.dropEffect = canDrop ? 'copy' : 'none'
    }}
    onDragLeave={() => {
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (!dragDepth.current) setDragging(false)
    }} onDrop={dropFile}>
    {!api && <input ref={input} className="visually-hidden" type="file" tabIndex={-1} aria-label="选择聊天记录文件"
      onChange={event => { if (event.target.files) selectFiles(event.target.files); event.target.value = '' }} />}

    {cancelling ? (
      <div className="import-step import-step-centered" role="region" aria-label="取消导入">
        <ImportStateMark />
        <h2 aria-live="polite">正在取消导入</h2>
        <progress className="import-meter" aria-label="取消导入进度" />
      </div>
    ) : failure ? (
      <div className="import-step import-step-centered" role="region" aria-label="导入失败">
        <ImportStateMark state="failed" />
        <h2 ref={failureHeading} tabIndex={-1}>{failureTitle(failure.phase, failure.code)}</h2>
        <div className="import-step-actions">
          <button className="import-secondary" type="button" disabled={openingLog}
            onClick={() => { void controller.openErrorLog() }}>查看错误日志</button>
          <button className="import-primary" type="button" onClick={cancel}>取消导入</button>
        </div>
      </div>
    ) : showInitial ? (
      <>
        <button ref={choose} className="import-dropzone" type="button" aria-labelledby="import-picker-title" aria-describedby="import-picker-hint"
          disabled={busy} aria-disabled={pickerOpen || undefined} onClick={() => { if (api) void controller.choose('files'); else input.current?.click() }}>
          <Download className="import-art" size={44} strokeWidth={1.6} aria-hidden="true" />
          <span className="import-picker-title" id="import-picker-title">
            {dragging ? (api ? '松开以导入聊天记录' : '松开以选择文件') : filename ? '重新选择文件' : '选择文件'}
          </span>
          <span className="import-picker-hint" id="import-picker-hint">
            {api ? '可多选，也可将聊天文件或文件夹拖到这里' : '或将一份聊天文件拖到这里'}
          </span>
        </button>
        {api && <button className="import-folder" type="button" disabled={busy || pickerOpen}
          onClick={() => { void controller.choose('directory') }}>
          <FolderOpen size={17} aria-hidden="true" />选择文件夹
        </button>}
        <button ref={guideButton} className="import-guide" type="button" disabled={busy || pickerOpen} onClick={() => setReadingGuide(true)}>
          <BookOpen size={19} strokeWidth={1.7} aria-hidden="true" />操作指引
        </button>
        {(busy || !api) && <div className="import-picker-feedback">
          {busy && <p className="import-muted" role="status">正在处理…</p>}
          {!api && <p className="import-muted">请在桌面应用中导入；此处仅预览文件选择。</p>}
          {filename && <p role="status"><span className="selected-filename">{filename}</span><span className="file-selection-note">已选择 · 尚未导入</span></p>}
        </div>}
      </>
    ) : isSelection && snapshot ? (
      <ConversationChoices key={snapshot.jobId} candidates={candidates} entries={snapshot.discovery?.entries} busy={busy}
        onImport={ids => { void controller.commit([], ids) }} onCancel={cancel} />
    ) : (scan || prepare || parse) && snapshot ? (
      <div className="import-step import-step-centered" role="region" aria-label={parse ? '解析进度' : '导入准备'}>
        <ImportStateMark />
        <h2 aria-live="polite">{phaseTitle}</h2>
        <progress className="import-meter" aria-label={parse ? '解析进度' : '查找聊天记录进度'} />
        {parse && snapshot.status !== 'awaiting_confirmation' && <p className="import-muted">
          已检查 {snapshot.counts.seen} 条记录 · 有效 {snapshot.counts.validRecords} 条 · 异常 {snapshot.counts.invalidRecords} 条
        </p>}
        <div className="import-step-actions">
          <button className="import-secondary" type="button" onClick={cancel}>取消导入</button>
        </div>
      </div>
    ) : snapshot && (
      <ImportProgress snapshot={snapshot} onCancel={cancel} onOpen={onOpenConversation} onReset={controller.reset} />
    )}
  </section>
}
