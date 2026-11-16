import fs from 'node:fs'
import path from 'node:path'
const base='release/conversation-insights-20261115/long-comparison-runs'
function json(file){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return undefined}}
function lines(file){if(!fs.existsSync(file))return[];return fs.readFileSync(file,'utf8').split('\n').filter(Boolean).flatMap(line=>{try{return[JSON.parse(line)]}catch{return[]}})}
const retired=json(path.join(base,'memory-capacity-current-20261116','shared-workload-reading','result.json'))
console.log(JSON.stringify({priorClosedDiagnosticRequests:84,retiredInitialCurrent:retired?{requests:retired.httpRequests,inputTokens:retired.inputCharged,outputTokens:retired.outputCharged,error:retired.error,closed:true}:null}))
for(const arm of ['baseline','current-v2']){
 const runId=`memory-capacity-${arm}-20261116`,root=path.join(base,runId)
 if(!fs.existsSync(root)){console.log(JSON.stringify({arm,state:'not-started'}));continue}
 const phases=fs.readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&/^(shared-workload|conditional-reschedule)-(reading|adaptive|direct|direct-rich)$/.test(entry.name)).map(entry=>{
  const dir=path.join(root,entry.name),ledger=lines(path.join(dir,'attempts.jsonl')),files=fs.readdirSync(dir),requests=files.filter(file=>/^request-\d+\.json$/.test(file)).sort(),responses=files.filter(file=>/^response-\d+\.txt$/.test(file)).sort(),request=json(path.join(dir,requests.at(-1)??'_absent_')),payload=request?jsonString(request.prompt):undefined,result=json(path.join(dir,'result.json')),response=responses.length?responseJson(path.join(dir,responses.at(-1))):undefined
  const stages={};for(const event of ledger)if(event.kind==='reserved')stages[event.stage]=(stages[event.stage]??0)+1
  const ids=payload?.messages?.map(message=>message.id)
  return{phase:entry.name,dispatched:ledger.filter(e=>e.kind==='dispatched').length,settled:ledger.filter(e=>e.kind==='settled').length,result:result?{state:result.state,...(result.error?{error:result.error}:{})}:'running',stages,last:request?{request:requests.at(-1),stage:request.stage,...(ids?{ids:[ids[0],ids.at(-1)],messageCount:ids.length}:{}),...(payload?.nodes?{nodes:payload.nodes.length}:{}),repair:payload?.repair===true}:undefined,latestResponse:responses.at(-1),candidateUpdates:response?.candidateUpdates?.length??0,newCandidates:response?.candidates?.length??0}
 })
 console.log(JSON.stringify({arm,active:fs.existsSync(path.join(root,'.active-comparison')),halt:json(path.join(root,'halt.json'))?.error??null,phases}))
}
function jsonString(text){try{return JSON.parse(text)}catch{return undefined}}
function responseJson(file){try{return jsonString(fs.readFileSync(file,'utf8').trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i,'$1'))}catch{return undefined}}
