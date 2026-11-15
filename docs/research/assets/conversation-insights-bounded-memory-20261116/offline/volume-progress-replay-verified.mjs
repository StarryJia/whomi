import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createServer} from 'vite';
const vite=await createServer({configFile:false,server:{middlewareMode:true},optimizeDeps:{noDiscovery:true,include:[]},appType:'custom'});
try{
 const {generateInsight}=await vite.ssrLoadModule('/electron/main/insight-generation.ts');
 const {countInsightInput}=await vite.ssrLoadModule('/electron/main/insight-packing.ts');
 const cases=[];
 for(const spec of [
  {name:'old-08',folder:'memory-preservation-20261115/shared-workload-reading-resume-2',number:'08',cursor:0,nextRoots:[],capOriginalGroup:true},
  {name:'old-09',folder:'memory-preservation-20261115/shared-workload-reading-resume-2',number:'09',cursor:16,nextRoots:[142],capOriginalGroup:true},
  {name:'current-03',folder:'memory-bounded-20261116/shared-workload-reading-resume',number:'03',capOriginalGroup:false},
 ]){
  const base='release/conversation-insights-20261115/long-comparison-runs/'+spec.folder+'/';
  const read=name=>JSON.parse(fs.readFileSync(base+name,'utf8'));
  const checkpoint=read('checkpoint.json'),input=read('input.json'),snapshot=read('snapshot.json');
  if(spec.cursor!==undefined){checkpoint.navigation.cursor=spec.cursor;checkpoint.navigation.nextRoots=spec.nextRoots;}
  const expected=JSON.parse(read('request-'+spec.number+'.json').prompt),response=fs.readFileSync(base+'response-'+spec.number+'.txt','utf8');
  const expectedWireNodes=expected.nodes.map(({navigationId,childCount,entries})=>({navigationId,childCount,entries:entries.map(({entryId,kind,text})=>({entryId,kind,text}))}));
  const originalFiles=['checkpoint.json','input.json','snapshot.json','request-'+spec.number+'.json','response-'+spec.number+'.txt'];
  const hash=name=>createHash('sha256').update(fs.readFileSync(base+name)).digest('hex');
  const before=Object.fromEntries(originalFiles.map(name=>[name,hash(name)]));
  const model={id:checkpoint.modelId,version:checkpoint.modelVersion,label:'offline-volume-progress',model:'gpt-6.1-sol',baseUrl:'https://invalid.example',contextWindow:16000,maxInputTokens:7000,maxTokens:3000,enabled:true,hasCredential:false};
  const entries=new Map(expected.nodes.flatMap(node=>node.entries.map(entry=>{const index=Number(entry.entryId.split(':')[1]);return[entry.entryId,checkpoint.navigation.nodes[node.navigationId].facts[index]]})));
  const responseBody=JSON.parse(response),projected=responseBody.facts.map(f=>({kind:f.kind,text:f.text,sourceIds:[...new Set(f.entryIds.flatMap(id=>entries.get(id).sourceIds))]}));
  const bytes=f=>Buffer.byteLength(JSON.stringify({observations:f.filter(x=>x.kind==='fact').map(({text,sourceIds})=>({text,sourceIds})),openThreads:f.filter(x=>x.kind==='unknown').map(({text,sourceIds})=>({text,sourceIds}))}));
  let saved,attempts=[],accepted=false,error=null;const stop=new Error('OFFLINE_ACCEPTED_RESPONSE');
  try{await generateInsight({snapshot,conversationId:'offline',model,prompts:checkpoint.prompts,limits:checkpoint.limits,checkpoint},{
   signal:new AbortController().signal,onText(){},async read(ids){return input.messages.filter(m=>ids.includes(m.id))},
   async saveCheckpoint(value){saved=structuredClone(value);if(value.navigation.cursor===checkpoint.navigation.cursor+expected.nodes.length&&value.navigation.nextRoots.length===checkpoint.navigation.nextRoots.length+1){accepted=true;throw stop}},
   ...(spec.capOriginalGroup?{async countInput(request,selected){const p=JSON.parse(request.prompt);if(p.operation==='compress-navigation'&&p.nodes.length>expected.nodes.length)return{method:'estimate',tokens:100000};return countInsightInput(request,selected)}}:{}),
   async run(request){const p=JSON.parse(request.prompt);if(p.operation!=='compress-navigation'||attempts.length>=2||JSON.stringify(p.nodes)!==JSON.stringify(expectedWireNodes))throw new Error('OFFLINE_REQUEST_MISMATCH');attempts.push({inputEstimate:(await countInsightInput(request,model)).tokens,targetFactTextLength:p.targetFactTextLength,maxFactCount:p.maxFactCount,repair:p.repair??false});return{text:response,checkpoint:'',usage:{inputTokens:0,outputTokens:0}};}
  })}catch(e){if(e!==stop)error=e.code??e.message}
  cases.push({name:spec.name,grouping:spec.capOriginalGroup?'diagnostic-original-node-count-cap':'default-current-capacity',accepted,error,attempts,inputWritingFactBytes:bytes([...entries.values()]),outputWritingFactBytes:bytes(projected),outputTextLength:projected.reduce((s,f)=>s+[...f.text].length,0),cursorBefore:checkpoint.navigation.cursor,cursorAfter:saved?.navigation.cursor,nextRootsUnchanged:JSON.stringify(checkpoint.navigation.nextRoots)===JSON.stringify(saved?.navigation.nextRoots),callsReservedBefore:checkpoint.callsReserved,simulatedCallsReservedAfter:saved?.callsReserved,repairsBefore:checkpoint.navigation.repairs,repairsAfter:saved?.navigation.repairs,originalsUnchanged:originalFiles.every(name=>before[name]===hash(name))});
 }
 const result={kind:'offline-writing-volume-progress',networkCalls:0,cases};
 fs.writeFileSync('release/conversation-insights-20261115/memory-retest/volume-progress-replay-verified.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));
}finally{await vite.close()}

