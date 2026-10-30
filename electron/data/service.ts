import type { Store } from './db/open'
import type { Discovery, ImportSnapshot, StartImportRequest } from '../../src/shared/import-contract'
import { createStagingService, type StagedImport, type StagingOptions } from './import/staging'
import type { GrantedSource } from './import/discovery'
import { confirmSelf as mutateSelf } from './import/identity'
import { runImport, type RunnerDependencies, type WriterQueue } from './import/runner'
import { recoverImports } from './import/recovery'
import { finishJob, getSnapshot, saveResult, setJobState, terminalStates } from './import/state'
import { ImportFailure, issue } from './import/limits'
import { rebuildSummary } from './import/summary'
import type { ImportPreview, PreviewOptions } from '../../src/shared/desktop-api'
export type DataServiceOptions = {store:Store;appDataDirectory:string;staging?:Omit<StagingOptions,'appDataDirectory'|'registerArea'>;runner?:Omit<RunnerDependencies,'write'|'changed'>;changed?:(snapshot:ImportSnapshot)=>void}
type ActiveImport={id:string;signal:AbortController;discovery?:Discovery;staged?:StagedImport}
export function createDataService(options:DataServiceOptions) {
  const {store}=options
  let queue:Promise<unknown>=Promise.resolve(),task:Promise<unknown>=Promise.resolve(),active:ActiveImport|undefined,lastEvent=0
  let notificationTimer:NodeJS.Timeout|undefined
  const write:WriterQueue=operation=> {const next=queue.then(operation);queue=next.catch(()=>{});return next}
  const ready=write(()=>recoverImports(store))
  const staging=createStagingService({appDataDirectory:options.appDataDirectory,...options.staging,registerArea(jobId,r) {
    store.writer.prepare('INSERT INTO import_staging_areas(job_id,path,app_directory,root,identity) VALUES (?,?,?,?,?)').run(BigInt(jobId),r.path,r.appDirectory,r.root,r.identity)
  }})
  function notify(id:string) {
    if(!options.changed) return
    const snapshot=getSnapshot(store,id),now=Date.now()
    if(terminalStates.has(snapshot.status) || now-lastEvent>=200) {
      if(notificationTimer)clearTimeout(notificationTimer);notificationTimer=undefined
      lastEvent=now;try {options.changed(snapshot)} catch { /* Subscribers cannot affect committed data. */ }
    }else if(!notificationTimer) {
      notificationTimer=setTimeout(()=>{notificationTimer=undefined;notify(id)},200-(now-lastEvent));notificationTimer.unref()
    }
  }
  function metadata(id:string, value:Record<string,unknown>) {store.writer.prepare('UPDATE import_jobs SET metadata=? WHERE id=?').run(JSON.stringify(value),BigInt(id))}
  async function cleanup(current:ActiveImport) {
    try {await current.staged?.cleanup();store.writer.prepare('DELETE FROM import_staging_areas WHERE job_id=?').run(BigInt(current.id))} catch { /* Recovery retries registered areas. */ }
  }
  async function prepareImport(grants:readonly GrantedSource[]):Promise<string> {
    await ready
    if(active) throw new ImportFailure('IMPORT_BUSY')
    const current:ActiveImport={id:'',signal:new AbortController()};active=current
    const id=await write(()=>store.writer.prepare("INSERT INTO import_jobs(status,phase,created_at_ms) VALUES ('pending','preparing',?)").run(Date.now()).lastInsertRowid.toString());current.id=id
    try {
      setJobState(store,id,'scanning');notify(id)
      current.discovery=await staging.discover(grants,current.signal.signal)
      metadata(id,{discovery:current.discovery,issues:current.discovery.issues});setJobState(store,id,'awaiting_confirmation');notify(id)
      return id
    } catch(error) {setJobState(store,id,current.signal.signal.aborted ? 'cancelled':'failed');active=undefined;notify(id);throw error}
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
          setJobState(store,id,'awaiting_commit')
        } catch(error) {metadata(id,{discovery:current.discovery,issues:[issue(error instanceof ImportFailure ? error.code:'STAGING_FAILED')]});setJobState(store,id,current.signal.signal.aborted ? 'cancelled':'failed');active=undefined}
        notify(id)
      })()
    } else {
      if(snapshot.status!=='awaiting_commit' || !current.staged) throw new ImportFailure('INVALID_STATE')
      const plan=structuredClone(request.plan)
      // Reserve synchronously before returning so a second submit cannot start another runner.
      setJobState(store,id,'committing')
      task=(async()=> {
        try {await runImport(store,current.staged!,plan,current.signal.signal,{...options.runner,write,changed:()=>notify(id)})}
        catch {await write(()=>finishJob(store,id,current.signal.signal.aborted,true))}
        finally {await cleanup(current);if(active===current) active=undefined;notify(id)}
      })()
    }
    return id
  }
  async function cancelImport(id:string):Promise<void> {
    await ready
    const current=active
    if(!current || current.id!==id) return
    current.signal.abort()
    const status=getSnapshot(store,id).status
    if(status==='awaiting_confirmation' || status==='awaiting_commit') {for(const c of current.staged?.candidates ?? []) saveResult(store,id,c,'cancelled','CANCELLED');setJobState(store,id,'cancelled');await cleanup(current);active=undefined;notify(id)}
    else await task
  }
  return {
    ready,write,prepareImport,startImport,cancelImport,
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
    async getImport(jobId:string) {await ready;return getSnapshot(store,jobId)},
    async confirmSelf(conversationId:string,memberId:string|null) {await ready;return write(()=>mutateSelf(store,conversationId,memberId))},
    async retrySummary(conversationId:string) {await ready;return write(()=>rebuildSummary(store,conversationId))},
    async idle() {await ready;await task;await queue},
  }
}
