import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createServer} from 'vite';
const base='release/conversation-insights-20261115/long-comparison-runs/memory-preservation-20261115/shared-workload-reading-resume-2/';
const read=name=>JSON.parse(fs.readFileSync(base+name,'utf8'));
const originalCheckpoint=read('checkpoint.json'),input=read('input.json'),snapshot=read('snapshot.json');
const audited=['checkpoint.json','input.json','snapshot.json','request-08.json','response-08.txt','request-09.json','response-09.txt'];
const hash=name=>createHash('sha256').update(fs.readFileSync(base+name)).digest('hex');
const hashes=Object.fromEntries(audited.map(name=>[name,hash(name)]));
const vite=await createServer({configFile:false,server:{middlewareMode:true},optimizeDeps:{noDiscovery:true,include:[]},appType:'custom'});
try{
 const {generateInsight}=await vite.ssrLoadModule('/electron/main/insight-generation.ts');
 const {countInsightInput}=await vite.ssrLoadModule('/electron/main/insight-packing.ts');
 const {buildInsightPrompt}=await vite.ssrLoadModule('/electron/data/ai/insight-prompts.ts');
 const model={id:originalCheckpoint.modelId,version:originalCheckpoint.modelVersion,label:'offline-bounded-compression',model:'gpt-6.1-sol',baseUrl:'https://invalid.example',contextWindow:16000,maxInputTokens:7000,maxTokens:3000,enabled:true,hasCredential:false};
 const cases=[];
 for(const number of ['08','09']){
  const oldRequest=read('request-'+number+'.json'),oldPayload=JSON.parse(oldRequest.prompt),response=fs.readFileSync(base+'response-'+number+'.txt','utf8');
  const expectedIds=oldPayload.nodes.flatMap(node=>node.entries.map(entry=>entry.entryId));
  const checkpoint=structuredClone(originalCheckpoint);
  checkpoint.navigation.cursor=number==='08'?0:16;
  checkpoint.navigation.nextRoots=number==='08'?[]:[142];
  let saved,attempts=[],error;
  try{await generateInsight({snapshot,conversationId:'offline',model,prompts:checkpoint.prompts,limits:checkpoint.limits,checkpoint},{
   signal:new AbortController().signal,onText(){},async read(ids){return input.messages.filter(m=>ids.includes(m.id))},
   async saveCheckpoint(value){saved=structuredClone(value)},
   async countInput(request,selected){const p=JSON.parse(request.prompt);if(p.operation==='compress-navigation'&&p.nodes.length>oldPayload.nodes.length)return {method:'estimate',tokens:100000};return countInsightInput(request,selected)},
   async run(request){const p=JSON.parse(request.prompt);if(p.operation!=='compress-navigation'||attempts.length>=2)throw new Error('UNEXPECTED_REQUEST');
    const ids=p.nodes.flatMap(node=>node.entries.map(entry=>entry.entryId));if(JSON.stringify(ids)!==JSON.stringify(expectedIds))throw new Error('ORIGINAL_GROUP_MISMATCH');
    attempts.push({inputEstimate:(await countInsightInput(request,model)).tokens,maxFactTextLength:p.maxFactTextLength,maxFactCount:p.maxFactCount,repair:p.repair??false,sourceIdsSent:p.nodes.some(node=>node.entries.some(entry=>'sourceIds'in entry))});
    return{text:response,checkpoint:'',usage:{inputTokens:0,outputTokens:0}};
   }
  })}catch(e){error=e.code??e.message}
  cases.push({response:number,diagnosticGrouping:'old-group-node-count-cap-only-no-model-call',error,attempts,outputFactTextLength:JSON.parse(response).facts.reduce((s,f)=>s+[...f.text].length,0),cursorBefore:checkpoint.navigation.cursor,cursorAfter:saved.navigation.cursor,nextRootsBefore:checkpoint.navigation.nextRoots,nextRootsAfter:saved.navigation.nextRoots,originalLeafCount:checkpoint.observations.length});
 }
 const navigation=originalCheckpoint.navigation;
 const remaining=navigation.roots.slice(navigation.cursor);
 const requestFor=ids=>{const nodes=ids.map(id=>({navigationId:id,childCount:navigation.nodes[id].children.length,entries:navigation.nodes[id].facts.map((f,i)=>({entryId:id+':'+i,kind:f.kind,text:f.text}))}));const entries=nodes.flatMap(n=>n.entries);return {stage:'reading',operation:'compress-navigation',maxFactTextLength:Math.max(160,Math.floor(entries.reduce((s,e)=>s+[...e.text].length,0)*.6)),maxFactCount:entries.length*2,nodes}};
 const chunks=[];let ids=[];
 for(const id of remaining){const candidate=[...ids,id];const estimate=(await countInsightInput({key:'offline',model,systemPrompt:buildInsightPrompt(originalCheckpoint.prompts,'reading','compress-navigation'),prompt:JSON.stringify(requestFor(candidate))},model)).tokens;if(estimate>6744){chunks.push(ids.length);ids=[id]}else ids=candidate}
 if(ids.length)chunks.push(ids.length);
 const output={kind:'bounded-compression-offline-replay',networkCalls:0,originalsUnchanged:audited.every(name=>hash(name)===hashes[name]),cases,currentProtocolRemainingFirstLayerChunks:chunks,currentProtocolRemainingFirstLayerCalls:chunks.length,actualCallsAlreadyUsed:22,remainingActualBudget:8,minimumRemainingWithWriting:chunks.length+1,excludesFurtherGlobalMerge:true};
 fs.writeFileSync('release/conversation-insights-20261115/memory-retest/bounded-compression-replay.json',JSON.stringify(output,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify(output));
}finally{await vite.close()}
