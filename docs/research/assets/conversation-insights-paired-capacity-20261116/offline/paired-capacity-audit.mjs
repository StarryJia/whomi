import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual as equal } from 'node:util'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { execFileSync } from 'node:child_process'
import { insightLongComparisonCases as materials } from './paired-capacity-frozen/current/source/tests/quality/insight-long-comparison-material.mjs'

const base='release/conversation-insights-20261115', frozen=base+'/paired-capacity-frozen',v2Frozen=base+'/paired-capacity-v2-frozen'
const final=process.argv.includes('--final'), full=process.argv.includes('--json')
if(process.argv.slice(2).some(arg=>!['--final','--json'].includes(arg)))throw new Error('Use --final or --json')
const issues=[],pending=[],runs=[],dispatchIntervals=[]
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),digest=value=>hash(JSON.stringify(value)),unique=values=>[...new Set(values)]
const check=(ok,where,message)=>{if(!ok)issues.push({where,message})}
const json=(file,required=false)=>{if(!fs.existsSync(file)){if(required)pending.push(file);return}try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{(final?issues:pending).push(final?{where:file,message:'Incomplete JSON'}:file)}}
function lines(file){if(!fs.existsSync(file))return[];const raw=fs.readFileSync(file,'utf8').split('\n').filter(Boolean);return raw.flatMap((line,index)=>{try{return[JSON.parse(line)]}catch{if(!final&&index===raw.length-1)pending.push(file);else issues.push({where:file,message:'Invalid JSON line'});return[]}})}
const response=file=>{if(!fs.existsSync(file))return;try{return JSON.parse(fs.readFileSync(file,'utf8').trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i,'$1'))}catch{return{invalidJson:true}}}
const byteNotes=facts=>Buffer.byteLength(JSON.stringify({observations:facts.filter(f=>f.kind==='fact').map(({text,sourceIds})=>({text,sourceIds})),openThreads:facts.filter(f=>f.kind==='unknown').map(({text,sourceIds})=>({text,sourceIds}))}),'utf8')
function readingReExposure(steps){const seen=new Set(),presentations=[];for(const step of steps.filter(step=>step.sent&&step.stage==='reading')){for(const sourceId of step.relatedOriginalIds??[])presentations.push({request:step.file,sourceId,seenInEarlierRequest:seen.has(sourceId)});for(const id of [...step.messageIds??[],...step.relatedOriginalIds??[]])seen.add(id)}return{requestsWithRelatedOriginals:new Set(presentations.map(item=>item.request)).size,relatedOriginalPresentations:presentations.length,distinctRelatedOriginalIds:unique(presentations.map(item=>item.sourceId)),previouslySeenPresentations:presentations.filter(item=>item.seenInEarlierRequest).length,presentations}}
const expectedHashes={'shared-workload':'6f63b461c034eacaebc473ea5637bef13119aae59e286fa1d449347d9c6af756','conditional-reschedule':'907c6b680d1acc0e4c021e7ae6c26393d1fd144c9c6f45d6ee4a47b316640b2d'}
const expectedLimits={maxChecks:8,maxRoundsPerCheck:4,maxCalls:50,maxInputTokens:400000,maxOutputTokens:40000,maxElapsedMs:1200000}
const implementation=json(frozen+'/implementation.json',true)
for(const arm of ['baseline','current'])for(const item of implementation[arm+'Files'])check(hash(fs.readFileSync(frozen+'/'+arm+'/source/'+item.file))===item.sha256,arm+'/'+item.file,'Frozen source hash differs')
check(hash(fs.readFileSync(frozen+'/current/implementation.patch'))===implementation.patchSha256,'snapshot','Frozen patch differs')
for(const item of implementation.baselineFiles)check(hash(execFileSync('git',['show',implementation.baseCommit+':'+item.file]))===item.sha256,'baseline/'+item.file,'Frozen baseline differs from the named Git commit')
const baselineManifest=json(frozen+'/baseline/manifest.json',true)
check(baselineManifest.baseCommit==='fee2af45380cb379ab40009449f467d1c50c4a8b'&&baselineManifest.bundleSha256===implementation.baselineBundleSha256,'baseline','Baseline identity differs')
for(const file of [frozen+'/baseline/baseline.mjs',baselineManifest.bundlePath])check(hash(fs.readFileSync(file))===implementation.baselineBundleSha256,file,'Baseline bundle differs')
const baselineEngine=await import(pathToFileURL(path.resolve(frozen+'/baseline/baseline.mjs')).href)
async function bundled(entry){const output=await build({configFile:false,logLevel:'silent',build:{ssr:entry,write:false,minify:false,rollupOptions:{output:{format:'es'}}}});return import('data:text/javascript;base64,'+Buffer.from(output.output[0].code).toString('base64'))}
const v2Implementation=json(v2Frozen+'/implementation.json',true)
let currentEngine,currentGeneration
if(v2Implementation){
 check(v2Implementation.runIds?.baseline==='memory-capacity-baseline-20261116'&&v2Implementation.runIds?.current==='memory-capacity-current-v2-20261116'&&v2Implementation.baselineBundleSha256===implementation.baselineBundleSha256&&v2Implementation.packingEstimateLimit===13000&&v2Implementation.effectiveInputCeiling===12744&&v2Implementation.perTaskCalls===50&&v2Implementation.perRunRequestLimit===104,'v2-snapshot','V2 frozen identity or budgets differ')
 for(const arm of ['baseline','current'])for(const item of v2Implementation[arm+'Files'])check(hash(fs.readFileSync(v2Frozen+'/'+arm+'/source/'+item.file))===item.sha256,'v2/'+arm+'/'+item.file,'V2 frozen source hash differs')
 check(equal(v2Implementation.baselineFiles,implementation.baselineFiles)&&hash(fs.readFileSync(v2Frozen+'/baseline/baseline.mjs'))===implementation.baselineBundleSha256,'v2-baseline','Original baseline was changed')
 check(hash(fs.readFileSync(v2Frozen+'/current/implementation.patch'))===v2Implementation.patchSha256,'v2-snapshot','V2 patch differs')
 currentEngine=await bundled(v2Frozen+'/current/source/electron/data/ai/insight-prompts.ts')
 currentGeneration=await bundled(v2Frozen+'/current/source/electron/main/insight-generation.ts')
}
const retiredCurrent=json(base+'/memory-retest/paired-capacity-current-failed-summary.json',true)
if(retiredCurrent){check(retiredCurrent.closed&&retiredCurrent.result.httpRequests===11&&retiredCurrent.result.inputCharged===36211&&retiredCurrent.result.outputCharged===15693,'retired-current','Retired failed costs differ');for(const[file,digest]of Object.entries(retiredCurrent.originalHashes))check(hash(fs.readFileSync(file))===digest,'retired-current/'+file,'Retired failure evidence changed')}
const retiredDirectory=base+'/long-comparison-runs/memory-capacity-current-20261116/shared-workload-reading'
const retiredRelatedOriginals=readingReExposure(fs.readdirSync(retiredDirectory).filter(file=>/^request-\d+\.json$/.test(file)).sort().map(file=>{const request=json(retiredDirectory+'/'+file),payload=JSON.parse(request.prompt);return{file,stage:request.stage,sent:true,messageIds:payload.messages?.map(message=>message.id),relatedOriginalIds:payload.relatedMessages?.map(message=>message.id)}}))
const baselineFailureEvidence=json(base+'/memory-retest/paired-capacity-baseline-conditional-failure.json')
if(baselineFailureEvidence)for(const[file,digest]of Object.entries(baselineFailureEvidence.originalHashes))check(hash(fs.readFileSync(file))===digest,'baseline-failure/'+file,'Closed baseline failure evidence changed')
const {longComparisonWritingPrompt}=await bundled(frozen+'/current/source/tests/quality/insight-comparison.ts')
if(v2Implementation)check((await bundled(v2Frozen+'/current/source/tests/quality/insight-comparison.ts')).longComparisonWritingPrompt===longComparisonWritingPrompt,'v2-writer','Controlled writing prompt changed')
for(const [caseName,material]of Object.entries(materials))check(digest(material.messages)===expectedHashes[caseName],caseName,'Frozen material differs')

for(const arm of ['baseline','current-v2']){
 const runId=`memory-capacity-${arm}-20261116`,root=base+'/long-comparison-runs/'+runId,engine=arm==='baseline'?baselineEngine:currentEngine
 if(!fs.existsSync(root)){pending.push(runId+':not-started');runs.push({arm,runId,state:'not-started',totals:{requests:0,inputTokens:0,outputTokens:0},phases:[],comparisons:[]});continue}
 if(!engine){issues.push({where:runId,message:'Current-v2 has no frozen engine'});continue}
 const runHalt=json(root+'/halt.json')
 const profile=json(root+'/run-profile.json',true),expectedEngine=arm==='baseline'?{baseCommit:baselineManifest.baseCommit,bundlePath:baselineManifest.bundlePath,bundleSha256:baselineManifest.bundleSha256}:undefined
 check(profile?.runId===runId&&profile.totalRequestLimit===104&&profile.syntheticPackingInputEstimateLimit===13000&&profile.perRequestOutputLimit===3000&&equal(profile.perTaskLimits,expectedLimits)&&equal(profile.engine,expectedEngine),runId,'Frozen profile differs')
 const totals={requests:0,settled:0,inputTokens:0,outputTokens:0,reading:0,compression:0,checking:0,writing:0},phases=[],comparisons=[]
 for(const [caseName,material]of Object.entries(materials)){
  check(profile.materialHashes[caseName]===digest({scope:material.scope,messages:material.messages,excluded:material.excluded}),runId+'/'+caseName,'Profile material hash differs')
  const sources=new Map(material.messages.map(message=>[message.id,message])),casePhases=[]
  for(const variant of ['reading','adaptive','direct','direct-rich']){
   const name=caseName+'-'+variant,dir=root+'/'+name
   if(!fs.existsSync(dir))continue
   const input=json(dir+'/input.json',true),result=json(dir+'/result.json'),checkpoint=json(dir+'/checkpoint.json'),snapshot=json(dir+'/snapshot.json',true),report=json(dir+'/report.json'),events=lines(dir+'/events.jsonl'),ledger=lines(dir+'/attempts.jsonl')
   if(!input)continue
   if(!result)pending.push(runId+'/'+name+':running')
   const single=variant==='direct'||variant==='direct-rich'
   check(input.runId===runId&&input.caseName===caseName&&input.variant===variant&&input.model==='gpt-6.1-sol'&&input.protocol==='openai-completions'&&equal(input.engine,expectedEngine),name,'Input engine/model/identity differs')
   check(equal(input.limits,{...expectedLimits,...(single?{maxCalls:1,maxOutputTokens:3000}:{})})&&input.syntheticPackingInputEstimateLimit===13000&&input.perRequestEstimateCeiling===13000&&input.perRequestOutputLimit===3000&&input.totalRequestLimit===104,name,'Input budgets differ')
   check(equal(input.configuredCapacity,{known:false,contextWindow:16000,maxOutputTokens:8192,margin:256}),name,'Configured capacity changed')
   check(digest(input.messages)===expectedHashes[caseName]&&equal(input.scope,material.scope)&&equal(input.excluded,material.excluded),name,'Material/scope/exclusion differs')
   if(snapshot)check(equal(snapshot.sources,material.messages.map(({id,revision})=>({messageId:id,revision})))&&equal(snapshot.scope,material.scope)&&snapshot.timezone===material.scope.timezone,name,'Snapshot differs')
   const reserved=new Map(),dispatched=new Set(),settled=new Set();let inputTokens=0,outputTokens=0
   for(const entry of ledger){if(entry.kind==='reserved'){check(entry.call===reserved.size+1&&!reserved.has(entry.call)&&entry.inputEstimate<=12744&&entry.outputLimit>0&&entry.outputLimit<=3000,name,'Reservation sequence or capacity differs');reserved.set(entry.call,entry)}else if(entry.kind==='dispatched'){check(reserved.has(entry.call)&&!dispatched.has(entry.call)&&entry.wireOutputLimit===reserved.get(entry.call)?.outputLimit,name,'Dispatch output cap differs');dispatched.add(entry.call)}else if(entry.kind==='settled'){const reservation=reserved.get(entry.call);check(reservation&&!settled.has(entry.call),name,'Settlement has no unique reservation');const u=entry.usage;inputTokens+=u?.totalInputTokens??(u?.inputTokens===undefined?reservation?.inputEstimate??0:u.inputTokens+(u.cacheReadTokens??0)+(u.cacheWriteTokens??0));outputTokens+=u?.outputTokens??reservation?.outputLimit??0;check(equal(entry.charged,{input:inputTokens,output:outputTokens}),name,'Charged usage differs');settled.add(entry.call)}}
   if(result)check(result.calls===reserved.size&&result.httpRequests===dispatched.size&&settled.size===reserved.size&&result.inputCharged===inputTokens&&result.outputCharged===outputTokens,name,'Result totals differ')
   if(result?.state==='failed')check(!report,name,'Failed phase has a final report')
   if(result?.state==='completed'&&variant==='reading')check(checkpoint?.stage==='checking'&&checkpoint.coveredMessageIds.length===material.messages.length,name,'Completed reading did not cover all material')
   for(const entry of ledger.filter(entry=>entry.kind==='dispatched'))dispatchIntervals.push({arm,caseName,variant,call:entry.call,start:entry.at,end:ledger.find(item=>item.kind==='settled'&&item.call===entry.call)?.at})
   if(checkpoint){check(checkpoint.callsReserved===checkpoint.attempts.length&&equal(checkpoint.limits,expectedLimits)&&equal(checkpoint.prompts,engine.defaultInsightPrompts)&&checkpoint.modelId==='comparison-model',name,'Checkpoint engine or budget differs');check(checkpoint.callsReserved<=50&&checkpoint.elapsedMs<=1200000,name,'Cumulative calls/time exceed limits')}
   const reading=casePhases.find(phase=>phase.variant==='reading'),offset=variant==='adaptive'?(reading?.checkpoint?.callsReserved??0):0,timeline=[]
   if(result&&reading?.result){const shared=Object.fromEntries(['httpRequests','inputCharged','outputCharged','elapsedMs'].map(key=>[key,reading.result[key]]));check(equal(result.accounting?.sharedReading,shared),name,'Shared reading costs differ');check(equal(result.accounting?.hypotheticalArmTotal,Object.fromEntries(Object.entries(shared).map(([key,value])=>[key,value+result[key]]))),name,'Hypothetical arm costs differ')}
   for(const file of fs.readdirSync(dir).filter(name=>/^request-\d+\.json$/.test(name)).sort()){
    const call=Number(file.match(/\d+/)[0]),request=json(dir+'/'+file),where=runId+'/'+name+'/'+file
    if(!request)continue
    let payload;try{payload=JSON.parse(request.prompt)}catch{issues.push({where,message:'Invalid request payload'});continue}
    const body=response(dir+'/'+file.replace('request-','response-').replace('.json','.txt')),reservation=reserved.get(call),sent=dispatched.has(call)
    if(!reservation&&!result){pending.push(where+':ledger-lag');continue}
    check(request.model==='gpt-6.1-sol'&&request.inputEstimate===reservation?.inputEstimate&&request.outputLimit===reservation?.outputLimit&&request.inputEstimate<=12744,where,'Request and reservation differ')
    const operation=payload.operation==='compress-navigation'?'compress-navigation':undefined,stage=operation??payload.stage
    const expectedPrompt=payload.stage==='writing'?longComparisonWritingPrompt:engine.buildInsightPrompt(engine.defaultInsightPrompts,payload.stage,operation)
    check(request.systemPrompt===expectedPrompt&&request.stage===stage,where,'Engine or controlled writing prompt differs')
    check(!request.prompt.includes(material.excluded.text),where,'Excluded text sent')
    for(const field of ['messages','relatedMessages','evidence','earlierEvidence'])for(const part of payload[field]??[]){const source=sources.get(part.id);check(source&&['revision','senderName','isSelf','sentAtMs','replyToMessageId'].every(key=>source[key]===part[key])&&part.text===(part.fragment?source.text.slice(part.fragment.start,part.fragment.end):source.text),where,'Original text/metadata differs')}
    for(const note of [...payload.evidenceNotes??[],...payload.readEvidence??[],...(payload.knownCandidates??[]).flatMap(c=>c.evidenceNotes??[])]){const source=sources.get(note.sourceId);check(source?.text.includes(note.quote)&&['senderName','isSelf','sentAtMs','replyToMessageId'].every(key=>!Object.hasOwn(note,key)||source[key]===note[key]),where,'Original excerpt/metadata differs')}
    let compression
    if(operation){const childIds=payload.nodes.map(node=>node.navigationId);if(arm==='baseline'){
      if(checkpoint?.navigation)for(const node of payload.nodes){const original=checkpoint.navigation.nodes[node.navigationId];check(original&&original.text===node.text&&original.children.length===node.childCount&&equal(node.sourceIds,original.children.length?original.sourceIds.slice(0,12):original.sourceIds),where,'Baseline node input differs')}
      const allowed=unique(payload.nodes.flatMap(node=>node.sourceIds));if(body&&!body.invalidJson)check(Array.isArray(body.sourceIds)&&body.sourceIds.every(id=>allowed.includes(id)),where,'Baseline output has foreign source')
      const accepted=checkpoint?.navigation?.nodes.findIndex(node=>equal(node.children,childIds)&&node.text===body?.text&&equal(node.sourceIds,unique(body?.sourceIds??[])))
      compression={protocol:'legacy-summary',inputNodes:childIds.length,acceptedNode:accepted>=0?accepted:null,omittedSourceIds:body?.sourceIds?allowed.filter(id=>!body.sourceIds.includes(id)):null}
     }else{
      const entries=new Map(),mapped=new Map();for(const node of payload.nodes)for(const entry of node.entries){entries.set(entry.entryId,entry);check(!Object.hasOwn(entry,'sourceIds'),where,'Current compression exposed raw sources');if(checkpoint?.navigation){const original=checkpoint.navigation.nodes[node.navigationId],index=Number(entry.entryId.split(':')[1]),fact=original?.facts?.[index];check(original?.children.length===node.childCount&&entry.entryId===node.navigationId+':'+index&&fact?.kind===entry.kind&&fact?.text===entry.text,where,'Current entry mapping differs');if(fact)mapped.set(entry.entryId,fact)}}
      const facts=body?.facts??[],foreignIds=unique(facts.flatMap(f=>f.entryIds??[])).filter(id=>!entries.has(id)),omittedIds=[...entries.keys()].filter(id=>!facts.some(f=>f.entryIds?.includes(id))),omittedKnownIds=[...entries.values()].filter(e=>e.kind==='fact'&&!facts.some(f=>f.kind==='fact'&&f.entryIds?.includes(e.entryId))).map(e=>e.entryId)
      const inherited=mapped.size===entries.size&&!foreignIds.length?facts.map(f=>({kind:f.kind,text:f.text,sourceIds:unique((f.entryIds??[]).flatMap(id=>mapped.get(id).sourceIds))})):undefined
      const accepted=inherited&&checkpoint?.navigation.nodes.findIndex(node=>equal(node.children,childIds)&&node.text===body?.text&&equal(node.facts,inherited))
      let parserState='not-replayed'
      if(body&&!body.invalidJson&&mapped.size===entries.size){try{const parsed=currentGeneration.parseInsightCompressedFacts(body.facts,payload.nodes.map(node=>({...node,entries:node.entries.map(entry=>({...entry,sourceIds:mapped.get(entry.entryId).sourceIds}))})));parserState='accepted';check(equal(parsed,inherited),where,'V2 parser inheritance differs')}catch(error){parserState=error.code??'unknown-error'}}
      compression={protocol:'retained-facts-v2',inputEntries:entries.size,outputEntries:facts.length,foreignIds:body?foreignIds:null,omittedIds:body?omittedIds:null,knownInputsClassifiedOnlyUnknown:body?omittedKnownIds:null,parserState,acceptedNode:accepted>=0?accepted:null,...(inherited?{inputFactBytes:byteNotes([...mapped.values()]),outputFactBytes:byteNotes(inherited),netShrank:byteNotes(inherited)<byteNotes([...mapped.values()])}:{})}
      if(compression.acceptedNode!==null)check(!foreignIds.length&&!omittedIds.length&&parserState==='accepted',where,'Accepted current-v2 output violates coverage or provenance')
      if(compression.acceptedNode!==null&&compression.netShrank===false)compression.fitExceptionNeedsIndependentReview=true
     }}
    const acceptedReading=payload.stage==='reading'&&!operation?events.findLast(e=>e.kind==='checkpoint'&&e.callsReserved===offset+call&&e.pendingRead===null&&e.coveredMessageIds?.includes(payload.messages?.at(-1)?.id)):undefined
    const updates=(body?.candidateUpdates??[]).map(update=>({...update,accepted:acceptedReading?.checks.some(c=>c.id===update.id&&(update.action==='resolve'?c.state==='finished'&&equal(c.finding,update.finding):c.state==='pending'&&c.observation===update.observation))??false}))
    timeline.push({file,call,stage:request.stage,sent,repair:payload.repair===true,messageIds:payload.messages?.map(m=>m.id),relatedOriginalIds:payload.relatedMessages?.map(m=>m.id),knownCandidates:payload.knownCandidates?.map(({id,state})=>({id,state})),candidates:body?.candidates,candidateUpdates:updates,readingAccepted:!!acceptedReading,checkingAction:body?.action,checkingOriginalIds:request.stage==='checking'?unique([...payload.evidence??[],...payload.earlierEvidence??[]].map(m=>m.id)):[],compression,request,payload})
    if(sent)totals[request.stage==='compress-navigation'?'compression':request.stage]++
   }
   if(checkpoint?.navigation&&arm==='current-v2'){for(const [id,node]of checkpoint.navigation.nodes.entries()){const ids=unique((node.facts??[]).flatMap(f=>f.sourceIds));check(equal(node.sourceIds,ids)&&ids.every(id=>sources.has(id)),name+'/'+id,'Retained node sources differ');if(node.children.length)check(equal([...ids].sort(),unique(node.children.flatMap(child=>checkpoint.navigation.nodes[child].sourceIds)).sort()),name+'/'+id,'Retained parent sources differ')}if(checkpoint.stage!=='reading'&&checkpoint.observations.length&&checkpoint.openThreads.length)check(checkpoint.navigation.reconciled===true,name,'Mixed original notes skipped coordination')}
   if(report)for(const citation of report.citations??[])for(const fragment of citation.fragments??[])for(const ref of fragment.sources??[])check(sources.get(ref.messageId)?.revision===ref.revision,name,'Report citation ID/revision differs')
   if(variant==='adaptive'&&result&&reading?.result)check(reading.result.calls+result.calls<=50&&reading.result.inputCharged+result.inputCharged<=400000&&reading.result.outputCharged+result.outputCharged<=40000,name,'Shared reading plus adaptive exceeds task budget')
   totals.requests+=dispatched.size;totals.settled+=settled.size;totals.inputTokens+=inputTokens;totals.outputTokens+=outputTokens
   const phase={name,variant,state:result?.state??'running',error:result?.error,requests:dispatched.size,settled:settled.size,inputTokens,outputTokens,reportPresent:!!report,elapsedMs:result?.elapsedMs,result,checkpoint,timeline,readingRelatedOriginals:readingReExposure(timeline),writingBase:json(dir+'/writing-base.json')};phases.push(phase);casePhases.push(phase)
  }
  const reading=casePhases.find(p=>p.variant==='reading'),adaptive=casePhases.find(p=>p.variant==='adaptive'),direct=casePhases.find(p=>p.variant==='direct'),rich=casePhases.find(p=>p.variant==='direct-rich'),writer=p=>p?.timeline.find(t=>t.stage==='writing'&&t.sent),aw=writer(adaptive),dw=writer(direct),rw=writer(rich),writingBase=p=>({timezone:p.timezone,observations:p.observations,openThreads:p.openThreads})
  const comparison={caseName,sourceHash:expectedHashes[caseName],completePair:!!adaptive?.reportPresent&&!!direct?.reportPresent,naturalCandidates:reading?.checkpoint?.checks.length??null,acceptedCandidateUpdates:casePhases.flatMap(p=>p.timeline).flatMap(t=>t.candidateUpdates).filter(u=>u.accepted).length,checkingRequestsWithOriginals:adaptive?.timeline.filter(t=>t.sent&&t.checkingOriginalIds.length).length??0,modelReadRequests:adaptive?.timeline.filter(t=>t.sent&&t.stage==='checking'&&t.checkingAction==='read').length??0,modelNavigationRequests:adaptive?.timeline.filter(t=>t.sent&&t.stage==='checking'&&t.checkingAction==='navigate').length??0}
  comparison.availableReports={adaptive:!!adaptive?.reportPresent,direct:!!direct?.reportPresent,rich:!!rich?.reportPresent}
  comparison.failedPhases=casePhases.filter(phase=>phase.state==='failed').map(({name,error,requests})=>({name,error,requests}))
  comparison.outcome=comparison.completePair?'reports-completed':comparison.failedPhases.length?'stopped-after-failure':runHalt?'not-run-after-stop':'incomplete'
  comparison.readingRelatedOriginals=reading?.readingRelatedOriginals??null
  if(aw&&dw&&adaptive.writingBase&&direct.result){comparison.sameBase=equal(writingBase(aw.payload),writingBase(dw.payload));comparison.sameWriter=['model','systemPrompt','outputLimit'].every(key=>aw.request[key]===dw.request[key]);check(comparison.sameBase&&comparison.sameWriter,runId+'/'+caseName,'Shared writing base or writer differs');check(adaptive.writingBase?.sharedBaseHash===digest(writingBase(aw.payload))&&direct.result.sharedBaseHash===adaptive.writingBase?.sharedBaseHash,caseName,'Writing-base digest differs');if(reading?.checkpoint){const frozenHash=digest(reading.checkpoint);check(adaptive.writingBase?.readingCheckpointHash===frozenHash,caseName,'Reading checkpoint digest differs');check(equal(dw.payload.checks,reading.checkpoint.checks.map(({id,state,finding,observation})=>({id,state,finding,...(finding?{}:{observation})}))),caseName,'Direct candidate state not frozen')}}
  if(rw)check(comparison.checkingRequestsWithOriginals>0&&rw.payload.readEvidence?.length>0&&equal(writingBase(rw.payload),writingBase(aw.payload))&&rw.request.systemPrompt===aw.request.systemPrompt,caseName,'Rich control lacks original checking or shared base')
  const deepest=casePhases.map(phase=>phase.checkpoint).filter(checkpoint=>checkpoint?.navigation).sort((a,b)=>b.navigation.nodes.length-a.navigation.nodes.length)[0]
  if(deepest){const accepted=new Set(casePhases.flatMap(phase=>phase.timeline).map(step=>step.compression?.acceptedNode).filter(id=>id!==null&&id!==undefined));for(const[id,node]of deepest.navigation.nodes.entries())if(node.children.length)check(accepted.has(id),runId+'/'+caseName+'/navigation/'+id,'Accepted parent lacks its saved response')}
  if(!comparison.completePair&&!runHalt)pending.push(runId+'/'+caseName+':comparison-incomplete')
  comparisons.push(comparison)
 }
 check(totals.requests<=104,runId,'Global requests exceed budget')
 if(runHalt)check(phases.some(phase=>phase.state==='failed'&&equal(runHalt,{caseName:phase.name.slice(0,-phase.variant.length-1),variant:phase.variant,...phase.result})),runId,'Halt has no matching failed phase')
 const active=fs.existsSync(root+'/.active-comparison');if(final)check(!active,runId,'Run still active')
 runs.push({arm,runId,active,halt:json(root+'/halt.json')?.error,totals,comparisons,phases:phases.map(({checkpoint,timeline,result,...phase})=>({...phase,checkpoint:checkpoint&&{stage:checkpoint.stage,callsReserved:checkpoint.callsReserved,readingBatches:checkpoint.readLayouts?.length,covered:checkpoint.coveredMessageIds.length,checks:checkpoint.checks},timeline:timeline.map(({request,payload,...step})=>step)}))})
}
dispatchIntervals.sort((a,b)=>a.start-b.start)
const order=['baseline/shared-workload','current-v2/shared-workload','baseline/conditional-reschedule','current-v2/conditional-reschedule']
for(let index=1;index<dispatchIntervals.length;index++){const previous=dispatchIntervals[index-1],current=dispatchIntervals[index];if(previous.end!==undefined)check(previous.end<=current.start,'paired-order','Model requests overlap');check(order.indexOf(previous.arm+'/'+previous.caseName)<=order.indexOf(current.arm+'/'+current.caseName),'paired-order','Case/engine execution order differs')}
if(final)for(const where of pending)issues.push({where,message:'Incomplete final audit'})
const pairedTotals=runs.reduce((sum,run)=>({requests:sum.requests+run.totals.requests,inputTokens:sum.inputTokens+run.totals.inputTokens,outputTokens:sum.outputTokens+run.totals.outputTokens}),{requests:0,inputTokens:0,outputTokens:0})
const priorClosed={requests:84,inputTokens:151868,outputTokens:77887},retiredCosts={requests:retiredCurrent?.result.httpRequests??0,inputTokens:retiredCurrent?.result.inputCharged??0,outputTokens:retiredCurrent?.result.outputCharged??0}
const allActual=Object.fromEntries(Object.keys(pairedTotals).map(key=>[key,pairedTotals[key]+priorClosed[key]+retiredCosts[key]]))
const comparisonScope=Object.keys(materials).map(caseName=>{const baseline=runs.find(run=>run.arm==='baseline')?.comparisons.find(item=>item.caseName===caseName),current=runs.find(run=>run.arm==='current-v2')?.comparisons.find(item=>item.caseName===caseName);return{caseName,baselineOutcome:baseline?.outcome??'not-started',currentV2Outcome:current?.outcome??'not-started',fourReportComparisonAvailable:!!baseline?.completePair&&!!current?.completePair,currentV2AbsoluteReviewAvailable:!!current?.availableReports?.adaptive||!!current?.availableReports?.direct,accuracyScoredByThisAudit:false}})
const audit={mode:final?'final':'partial',status:issues.length?'issues-found':'evidence-consistent-with-recorded-outcomes',auditScope:'Artifact integrity, protocol and budget compliance; not completion or model accuracy.',reportComparisonScope:comparisonScope,costs:{priorClosedDiagnostics:priorClosed,retiredInitialCurrent:retiredCosts,pairedBaselineAndCurrentV2:pairedTotals,allActual,tokenCharges:'settled requests only'},retiredInitialCurrent:{runId:retiredCurrent?.runId,closed:true,resumePermitted:false,originalFilesVerified:Object.keys(retiredCurrent?.originalHashes??{}).length,reportGenerated:false,readingRelatedOriginals:retiredRelatedOriginals},snapshot:{initialCurrentFiles:implementation.currentFiles.length,currentV2Files:v2Implementation?.currentFiles.length??null,baselineFiles:implementation.baselineFiles.length,baselineBundleSha256:implementation.baselineBundleSha256},dispatchIntervals,runs,pending:unique(pending),issues,limitations:['Pending phases are not scored.','A preserved failed phase is a valid recorded outcome, not a successful comparison.','Reading-stage relatedMessages can re-present prior originals without an active checking request.','Evidence identity and source coverage do not establish semantic accuracy.','Old 84 requests and the retired 11-request current attempt are separate from the paired report comparison.']}
console.log(JSON.stringify(full?audit:{...audit,runs:runs.map(run=>({...run,phases:run.phases.map(({timeline,checkpoint,...phase})=>({...phase,checkpoint:checkpoint&&{...checkpoint,checks:checkpoint.checks.map(({id,state,rounds})=>({id,state,rounds}))},compressions:timeline.filter(t=>t.compression).map(({file,repair,compression})=>({file,repair,...compression}))}))}))},null,2))
if(issues.length)process.exitCode=1
