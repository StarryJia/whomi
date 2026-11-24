import type { Store } from './db/open'
import type { Discovery, ImportFailurePhase, ImportSnapshot, StartImportRequest } from '../../src/shared/import-contract'
import { terminalImportStates } from '../../src/shared/import-contract'
import { createStagingService, type StagedImport, type StagingOptions } from './import/staging'
import type { GrantedSource } from './import/discovery'
import { confirmSelf as mutateSelf } from './import/identity'
import { purgeConversation } from './db/purge'
import { runImport, type RunnerDependencies, type WriterQueue } from './import/runner'
import { cleanupImportStaging, recoverImports } from './import/recovery'
import { getSnapshot, recordImportFailure, saveResult, setJobState } from './import/state'
import { ImportFailure, issue } from './import/limits'
import { rebuildSummary } from './import/summary'
import type { ImportPreview, PreviewOptions } from '../../src/shared/desktop-api'
export type DataServiceOptions = {store:Store;appDataDirectory:string;staging?:Omit<StagingOptions,'appDataDirectory'|'registerArea'>;runner?:Omit<RunnerDependencies,'write'|'changed'>;changed?:(snapshot:ImportSnapshot)=>void}
type ActiveImport={id:string;operationId?:string;signal:AbortController;discovery?:Discovery;staged?:StagedImport;progress?:ImportSnapshot['progress'];finishedCandidates?:Set<string>;selectedCandidates?:Set<string>}
export function createDataService(options:DataServiceOptions) {
  const {store}=options
  let queue:Promise<unknown>=Promise.resolve(),task:Promise<unknown>=Promise.resolve(),active:ActiveImport|undefined,lastEvent=0
  let notificationTimer:NodeJS.Timeout|undefined
  const cancelling = new Map<string, Promise<void>>()
  let undurableFailure: { id: string; phase: ImportFailurePhase; code: string } | undefined
  const write:WriterQueue = operation => {
    const next = queue.then(() => {
      if (!store.writer.open || store.writer.inTransaction) throw new ImportFailure('ROLLBACK_STORAGE_ERROR', 'cancel')
      return operation()
    })
    queue = next.catch(() => {})
    return next
  }
  const ready=write(()=>recoverImports(store))
  const staging=createStagingService({appDataDirectory:options.appDataDirectory,...options.staging,onProgress(jobId,counts) {
    metadata(jobId,{discovery:active?.discovery,issues:active?.discovery?.issues ?? [],counts});notify(jobId)
    options.staging?.onProgress?.(jobId,counts)
  },registerArea(jobId,r) {
    store.writer.prepare('INSERT INTO import_staging_areas(job_id,path,app_directory,root,identity) VALUES (?,?,?,?,?)').run(BigInt(jobId),r.path,r.appDirectory,r.root,r.identity)
  }})
  function notify(id:string) {
    if(!options.changed) return
    let snapshot: ImportSnapshot
    try { snapshot = currentSnapshot(id) } catch { return }
    if (awaitingPublication(snapshot)) return
    const now=Date.now()
    if(terminalImportStates.has(snapshot.status) || now-lastEvent>=200) {
      if(notificationTimer)clearTimeout(notificationTimer);notificationTimer=undefined
      lastEvent=now;try {options.changed(snapshot)} catch { /* Subscribers cannot affect committed data. */ }
    }else if(!notificationTimer) {
      notificationTimer=setTimeout(()=>{notificationTimer=undefined;notify(id)},200-(now-lastEvent));notificationTimer.unref()
    }
  }
  function awaitingPublication(snapshot: ImportSnapshot) {
    return active?.id === snapshot.jobId && (snapshot.status === 'completed' || snapshot.status === 'removed')
  }
  function currentSnapshot(id:string):ImportSnapshot {
    const current = active?.id === id ? active : undefined
    const snapshot = getSnapshot(store,id, store.writer.open && store.writer.inTransaction ? current?.finishedCandidates : undefined)
    if (undurableFailure?.id === id) {
      return {...snapshot, status:'failed', failurePhase:undurableFailure.phase, issues:[issue(undurableFailure.code)]}
    }
    if (snapshot.status !== 'committing' || !current?.progress) return snapshot
    const selected = current.selectedCandidates
    return { ...snapshot, progress: current.progress,
      results: selected ? snapshot.results.filter(result => selected.has(result.candidateId)) : snapshot.results }
  }
  function metadata(id:string, value:Record<string,unknown>) {store.writer.prepare('UPDATE import_jobs SET metadata=? WHERE id=?').run(JSON.stringify({...value,operationId:active?.id === id ? active.operationId : undefined}),BigInt(id))}
  async function cleanup(current:ActiveImport) {
    const staged = current.staged
    current.staged = undefined
    try {
      if (staged) {
        await staged.cleanup()
        await write(() => store.writer.prepare('DELETE FROM import_staging_areas WHERE job_id=?').run(BigInt(current.id)))
      } else await write(() => cleanupImportStaging(store, current.id))
    } catch { /* Registered directories remain available for cancellation and recovery. */ }
  }
  async function prepareImport(grants:readonly GrantedSource[],operationId?:string):Promise<string> {
    await ready
    if(active || cancelling.size) throw new ImportFailure('IMPORT_BUSY')
    const current:ActiveImport={id:'',operationId,signal:new AbortController()};active=current
    try {
      const id=await write(()=>store.writer.prepare("INSERT INTO import_jobs(status,phase,created_at_ms,metadata) VALUES ('pending','preparing',?,?)").run(Date.now(),JSON.stringify({operationId})).lastInsertRowid.toString());current.id=id
      setJobState(store,id,'scanning');notify(id)
      current.discovery=await staging.discover(grants,current.signal.signal)
      metadata(id,{discovery:current.discovery,issues:current.discovery.issues})
      const blocking = current.discovery.issues.filter(value => value.severity === 'blocking')
      if (blocking.length || !current.discovery.entries.length) {
        recordImportFailure(store, id, 'scan', ...(blocking.length ? blocking : [issue('NO_IMPORTABLE_CONVERSATIONS')]))
        if (active === current) active = undefined
      } else setJobState(store,id,'awaiting_confirmation')
      notify(id)
      return id
    } catch(error) {
      if (active === current) active = undefined
      if (!current.id) throw error
      if (current.signal.signal.aborted) setJobState(store,current.id,'cancelled')
      else {
        const code = error instanceof ImportFailure ? error.code : 'DISCOVERY_FAILED'
        try { recordImportFailure(store,current.id,'scan',issue(code)) }
        catch { undurableFailure = {id:current.id, phase:'scan', code} }
      }
      notify(current.id)
      return current.id
    }
  }
  async function startImport(request:StartImportRequest):Promise<string> {
    await ready
    const id=request.kind==='stage' ? request.jobId:request.plan.jobId,current=active
    if(!current || current.id!==id) throw new ImportFailure('INVALID_JOB')
    const snapshot=getSnapshot(store,id)
    if(request.kind==='stage') {
      if(snapshot.status!=='awaiting_confirmation' || !current.discovery) throw new ImportFailure('INVALID_STATE')
      const selected=staging.selectDiscovery(current.discovery,request.entryIds)
      setJobState(store,id,'staging');notify(id)
      task=(async()=> {
        try {
          const staged=await staging.stageInputs(id,selected,current.signal.signal);current.staged=staged
          setJobState(store,id,'validating')
          metadata(id,{discovery:current.discovery,candidates:staged.candidates,issues:staged.issues,counts:staged.counts})
          for(const c of staged.candidates) saveResult(store,id,c,c.status)
          const blocking = staged.issues.filter(value => value.severity === 'blocking')
          if (blocking.length || !staged.candidates.length) {
            recordImportFailure(store, id, 'parse', ...(blocking.length ? blocking : [issue('NO_IMPORTABLE_CONVERSATIONS')]))
            await cleanup(current)
            if (active === current) active = undefined
          } else setJobState(store,id,'awaiting_commit')
        } catch(error) {
          const code = error instanceof ImportFailure ? error.code : 'STAGING_FAILED'
          try {
            if (!current.signal.signal.aborted) recordImportFailure(store,id,'parse',issue(code))
          } catch { undurableFailure = {id, phase:'parse', code} }
          await cleanup(current)
          if (active === current) active = undefined
        }
        notify(id)
      })()
    } else {
      if(snapshot.status!=='awaiting_commit' || !current.staged) throw new ImportFailure('INVALID_STATE')
      const plan=structuredClone(request.plan)
      // Reserve synchronously before returning so a second submit cannot start another runner.
      setJobState(store,id,'committing')
      const finished = new Set<string>()
      current.finishedCandidates = finished
      const selected = plan.candidateIds ? new Set(plan.candidateIds) : undefined
      current.selectedCandidates = selected
      current.progress = { processed: 0, total: current.staged.candidates.reduce((total, candidate) =>
        total + (!selected || selected.has(candidate.candidateId) ? candidate.counts.validRecords : 0), 0) }
      task=(async()=> {
        try {
          await runImport(store,current.staged!,plan,current.signal.signal,{
            ...options.runner,write,
            changed(candidates) {
              for (const candidate of candidates ?? []) finished.add(candidate)
              notify(id)
            },
            progress(processed,total) {current.progress={processed,total};notify(id);options.runner?.progress?.(processed,total)},
          })
        } catch (error) {
          // A storage fault can prevent writing even the failure record.
          const phase = error instanceof ImportFailure ? error.phase : undefined
          undurableFailure = {id, phase:phase ?? (current.signal.signal.aborted ? 'cancel' : 'save'), code: error instanceof ImportFailure ? error.code : 'STORAGE_UNWRITABLE'}
        }
        finally {
          current.finishedCandidates = undefined
          await cleanup(current);if(active===current) active=undefined;notify(id)
        }
      })()
    }
    return id
  }
  async function cancelImport(id:string):Promise<void> {
    await ready
    const pending = cancelling.get(id)
    if (pending) return pending
    const current = active?.id === id ? active : undefined
    const status = currentSnapshot(id).status
    if (status === 'completed' || status === 'partially_completed' || status === 'removed' || (!current && !terminalImportStates.has(status) && undurableFailure?.id !== id)) return
    const cancellation = (async () => {
      current?.signal.abort()
      if (current && (current.finishedCandidates || status === 'staging' || status === 'validating' || status === 'failed')) await task
      if (current && active === current) { await cleanup(current); active = undefined }
      await write(async () => {
        try {
          await cleanupImportStaging(store,id)
          if (getSnapshot(store,id).status !== 'cancelled') setJobState(store,id,'cancelled')
          if (undurableFailure?.id === id) undurableFailure = undefined
        } catch {
          const failure = issue('CANCEL_FAILED')
          try { recordImportFailure(store,id,'cancel',failure) }
          catch { undurableFailure = {id, phase:'cancel', code:failure.code} }
          throw new ImportFailure(failure.code)
        } finally { notify(id) }
      })
    })()
    cancelling.set(id, cancellation)
    try { await cancellation } finally { cancelling.delete(id) }
  }
  return {
    ready,write,prepareImport,startImport,cancelImport,importActive:()=>!!active || cancelling.size > 0,
    async previewImport(jobId:string,candidateId:string,options:PreviewOptions):Promise<ImportPreview> {
      await ready
      if(!active || active.id!==jobId || !active.staged) throw new ImportFailure('PREVIEW_UNAVAILABLE')
      const page=active.staged.preview(candidateId,options)
      return {nextOrdinal:page.nextOrdinal,messages:page.messages.map(message=>({
        ordinal:message.ordinal,senderKey:message.senderKey,senderKind:message.senderKind,senderName:message.senderName,
        sentAtMs:message.sentAtMs,timeRaw:message.timeRaw,timePrecision:message.timePrecision,timezone:message.timezone,
        kind:message.kind,text:message.text,sourceType:message.sourceType,reply:message.reply,
        attachments:message.attachments.map(({kind,name,state})=>({kind,name,state})),
      }))}
    },
    async getImport(jobId:string) {
      await ready
      let snapshot = currentSnapshot(jobId)
      if (awaitingPublication(snapshot)) {
        await task
        snapshot = currentSnapshot(jobId)
      }
      if (snapshot.status === 'removed') throw new ImportFailure('IMPORT_RESULT_REMOVED')
      return snapshot
    },
    async confirmSelf(conversationId:string,memberId:string|null) {await ready;return write(()=>mutateSelf(store,conversationId,memberId))},
    async deleteConversation(conversationId:string) {await ready;return write(()=>purgeConversation(store,conversationId))},
    async retrySummary(conversationId:string) {await ready;return write(()=>rebuildSummary(store,conversationId))},
    async idle() {await ready;await task;await Promise.all(cancelling.values());await queue},
  }
}
