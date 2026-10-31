import { stat, statfs } from 'node:fs/promises'
import type { Store } from '../db/open'
import type { Candidate, ImportPlan } from '../../../src/shared/import-contract'
import { resolveTarget, type ResolvedTarget } from './identity'
import { commitConversation, createCommitter, reliableTargetKey, type CommitResult } from './merge'
import type { StagedImport } from './staging'
import { checkSignal, ImportFailure, importLimits } from './limits'
import { finishJob, saveResult, setJobState, storageFailure } from './state'
import { rebuildSummary } from './summary'
import { resolveAutoTarget } from './auto-target'
export type WriterQueue = <T>(operation:()=>Promise<T>|T)=>Promise<T>
export type RunnerDependencies = {
  write: WriterQueue
  commit?: typeof commitConversation
  summary?: typeof rebuildSummary
  freeBytes?: (path:string)=>Promise<bigint>
  changed?: ()=>void
  progress?: (processed:number,total:number|null)=>void
}
export async function runImport(store:Store, staged:StagedImport, plan:ImportPlan, signal:AbortSignal, dependencies:RunnerDependencies):Promise<void> {
  const {write}=dependencies, notify=()=>dependencies.changed?.()
  if(plan.jobId!==staged.jobId || new Set(plan.decisions.map(d=>d.candidateId)).size!==plan.decisions.length || plan.decisions.some(d=>!staged.candidates.some(c=>c.candidateId===d.candidateId))) throw new ImportFailure('INVALID_PLAN')
  const decisions=new Map(plan.decisions.map(d=>[d.candidateId,d])), groups=new Map<string,{candidates:Candidate[];target:ResolvedTarget;blocked:boolean}>()
  let fatal=false
  await write(async()=> {
    setJobState(store,plan.jobId,'committing')
    for(const c of staged.candidates) {
      // Blocked files may retain reliable attribution, but never become readable views.
      const probe=c.status==='blocked' ? {...c,status:'staged' as const,issues:[]} : c
      const resolved=decisions.has(c.candidateId) || c.status==='blocked' ? resolveTarget(store,probe,decisions.get(c.candidateId)) : await resolveAutoTarget(store,probe,()=>staged.conversation([c.candidateId]).messages(),signal)
      const attribution=resolved.status==='matched' ? resolved : resolveTarget(store,probe)
      if(attribution.status !== 'matched' || (resolved.status!=='matched' && reliableTargetKey(attribution.target)===null)) { saveResult(store,plan.jobId,c,'blocked',c.status==='blocked' ? undefined:resolved.status==='blocked' ? resolved.code:'TARGET_REQUIRED'); continue }
      const t=attribution.target,key=t.conversationId ? `existing:${t.conversationId}` : `new:${reliableTargetKey(t) ?? c.candidateId}`
      const group=groups.get(key) ?? {candidates:[],target:t,blocked:false}
      group.candidates.push(c);group.blocked ||= c.status==='blocked' || resolved.status!=='matched';groups.set(key,group)
    }
  });notify()
  let processed=0
  const total=[...groups.values()].filter(g=>!g.blocked).reduce((n,g)=>n+g.candidates.reduce((count,c)=>count+c.counts.validRecords,0),0)
  dependencies.progress?.(processed,total)
  const freeBytes=dependencies.freeBytes ?? (async path=> {const s=await statfs(path,{bigint:true});return s.bavail*s.bsize})
  try {
    checkSignal(signal)
    if(await freeBytes(staged.path) < 3n*(await stat(staged.path,{bigint:true})).size+BigInt(importLimits.diskReserveBytes)) throw new ImportFailure('DISK_SPACE')
    for(const group of groups.values()) {
      checkSignal(signal)
      if(group.blocked) { await write(()=> {for(const c of group.candidates) saveResult(store,plan.jobId,c,'blocked',c.status==='blocked' ? undefined:'TARGET_GROUP_BLOCKED')});notify();continue }
      let groupProcessed=0
      try {
        const result:CommitResult=await write(async ()=> {
          checkSignal(signal)
          const view=staged.conversation(group.candidates.map(c=>c.candidateId))
          view.decisions=group.candidates.map(c=>decisions.get(c.candidateId)).filter(d=>d!==undefined)
          const commit=dependencies.commit ?? createCommitter({progress:count=>{groupProcessed=count;dependencies.progress?.(processed+count,total)}})
          return commit(store,view,group.target,signal)
        })
        processed+=result.inserted+result.duplicates;groupProcessed=0;dependencies.progress?.(processed,total)
        if(result.summaryChanged) await write(async()=> {
          try { await (dependencies.summary ?? rebuildSummary)(store,result.conversationId) }
          catch(error) {
            store.writer.prepare("UPDATE conversation_summaries SET status='failed' WHERE conversation_id=?").run(BigInt(result.conversationId))
            if(storageFailure(error)) throw error
          }
        })
      } catch(error) {
        processed+=groupProcessed;dependencies.progress?.(processed,total)
        if(signal.aborted) throw new ImportFailure('CANCELLED')
        const code=error instanceof ImportFailure ? error.code : storageFailure(error) ? 'STORAGE_UNWRITABLE':'COMMIT_FAILED'
        await write(()=> {for(const c of group.candidates) saveResult(store,plan.jobId,c,'failed',code)})
        if(storageFailure(error)) throw error
      }
      notify()
      // Allow queued self confirmation to run between complete target transactions.
      await new Promise<void>(resolve=>setImmediate(resolve))
    }
  } catch(error) {
    fatal=!signal.aborted
    await write(()=> {for(const c of staged.candidates) saveResult(store,plan.jobId,c,signal.aborted ? 'cancelled':'failed',signal.aborted ? 'CANCELLED':storageFailure(error) ? 'DISK_SPACE':'IMPORT_FAILED')})
  }
  await write(()=>finishJob(store,plan.jobId,signal.aborted,fatal));notify()
}
