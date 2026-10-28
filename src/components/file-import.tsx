import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import { FileText } from 'lucide-react'
import clsx from 'clsx'

export function FileImport() {
  const input = useRef<HTMLInputElement>(null)
  const choose = useRef<HTMLButtonElement>(null)
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [filename, setFilename] = useState('')
  const [error, setError] = useState('')

  useLayoutEffect(() => { choose.current?.focus() }, [])
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
    const isDirectory = Array.from(event.dataTransfer.items ?? []).some(item => item.webkitGetAsEntry?.()?.isDirectory)
    if (isDirectory) { setError('请选择文件，不要拖入文件夹。'); return }
    selectFiles(event.dataTransfer.files)
  }

  return <section className={clsx('file-import', dragging && 'is-dragging')} aria-label="文件导入"
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
    <input ref={input} className="visually-hidden" type="file" tabIndex={-1} aria-label="选择聊天记录文件"
      onChange={event => { if (event.target.files) selectFiles(event.target.files); event.target.value = '' }} />
    <button ref={choose} className="file-drop-target" type="button" aria-label={filename ? '重新选择文件' : '选择文件'}
      onClick={() => input.current?.click()}>
      <FileText className="import-file-icon" aria-hidden="true" />
      <span className="import-heading">{dragging ? '松开，选择这份文件' : '选择一份聊天记录'}</span>
      <span className="file-choose-action">{filename ? '重新选择文件' : '选择文件'}</span>
      <span className="import-hint">或将文件拖到这里</span>
    </button>
    <div className="import-feedback">
      {filename && <p role="status"><span className="selected-filename">{filename}</span><span className="file-selection-note">已选择 · 尚未导入</span></p>}
      {error && <p className="import-error" role="alert">{error}</p>}
    </div>
  </section>
}
