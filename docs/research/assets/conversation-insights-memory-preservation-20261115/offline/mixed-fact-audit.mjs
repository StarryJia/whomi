import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createServer} from 'vite';
const base='release/conversation-insights-20261115/long-comparison-runs/memory-preservation-20261115/shared-workload-reading-resume-2/';
const read=name=>JSON.parse(fs.readFileSync(base+name,'utf8'));
const checkpoint=read('checkpoint.json'), input=read('input.json'), snapshot=read('snapshot.json');
const audited=['checkpoint.json','input.json','snapshot.json','request-08.json','response-08.txt','request-09.json','response-09.txt'];
const hash=name=>createHash('sha256').update(fs.readFileSync(base+name)).digest('hex');
const hashes=Object.fromEntries(audited.map(name=>[name,hash(name)]));
const metrics=[];
for(const number of ['08','09']){
 const request=read('request-'+number+'.json'),payload=JSON.parse(request.prompt),response=read('response-'+number+'.txt');
 const entries=payload.nodes.flatMap(n=>n.entries), byId=new Map(entries.map(e=>[e.entryId,e]));
 const projected=response.facts.map(f=>({kind:f.kind,text:f.text,sourceIds:[...new Set(f.entryIds.flatMap(id=>byId.get(id).sourceIds))]}));
 const before=entries.map(({entryId,...fact})=>fact);
 const bytes=x=>Buffer.byteLength(JSON.stringify(x));
 metrics.push({response:number,inputEntries:entries.length,outputEntries:projected.length,inputFactBytes:bytes(before),outputFactBytes:bytes(projected),factByteChange:bytes(projected)-bytes(before),inputTextBytes:entries.reduce((s,e)=>s+Buffer.byteLength(e.text),0),outputTextBytes:projected.reduce((s,e)=>s+Buffer.byteLength(e.text),0)});
}
const vite=await createServer({configFile:false,server:{middlewareMode:true},optimizeDeps:{noDiscovery:true,include:[]},appType:'custom'});
try{
 const {generateInsight}=await vite.ssrLoadModule('/electron/main/insight-generation.ts');
 const {countInsightInput}=await vite.ssrLoadModule('/electron/main/insight-packing.ts');
 const {buildInsightPrompt}=await vite.ssrLoadModule('/electron/data/ai/insight-prompts.ts');
 const model={id:checkpoint.modelId,version:checkpoint.modelVersion,label:'offline-replay',model:'gpt-6.1-sol',baseUrl:'https://invalid.example',contextWindow:16000,maxInputTokens:7000,maxTokens:3000,enabled:true,hasCredential:false};
 const expected=JSON.parse(read('request-09.json').prompt);
 const response=fs.readFileSync(base+'response-09.txt','utf8');
 const stop=new Error('OFFLINE_ACCEPTED_ORIGINAL_RESPONSE'); let accepted=false, dispatches=0,saved;
 try{await generateInsight({snapshot,conversationId:'offline',model,prompts:checkpoint.prompts,limits:checkpoint.limits,checkpoint},{
  signal:new AbortController().signal,onText(){},async read(ids){return input.messages.filter(m=>ids.includes(m.id))},
  async saveCheckpoint(value){saved=structuredClone(value);if(value.navigation.cursor===30&&value.navigation.nextRoots.length===2){accepted=true;throw stop}},
  async run(request){dispatches++;const payload=JSON.parse(request.prompt);if(dispatches!==1||JSON.stringify(payload.nodes)!==JSON.stringify(expected.nodes))throw new Error('REPLAY_INPUT_DIFFERS');return{text:response,checkpoint:'',usage:{inputTokens:0,outputTokens:0}};}
 })}catch(e){if(e!==stop)throw e}
 const remaining=checkpoint.navigation.roots.slice(checkpoint.navigation.cursor);
 const allNodes=remaining.map(n=>({navigationId:n,childCount:checkpoint.navigation.nodes[n].children.length,entries:checkpoint.navigation.nodes[n].facts.map((f,i)=>({entryId:n+':'+i,kind:f.kind,text:f.text,sourceIds:f.sourceIds}))}));
 const chunks=[];let payload={stage:'reading',operation:'compress-navigation',nodes:[]};
 for(const node of allNodes){payload.nodes.push(node);const size=(await countInsightInput({key:'offline',model,systemPrompt:buildInsightPrompt(checkpoint.prompts,'reading','compress-navigation'),prompt:JSON.stringify(payload)},model)).tokens;if(size>6744){payload.nodes.pop();chunks.push(payload.nodes.length);payload={...payload,nodes:[node]};}}
 if(payload.nodes.length)chunks.push(payload.nodes.length);
 const result={kind:'offline-mixed-fact-audit',networkCalls:0,simulatedDispatches:dispatches,originalResponse09Accepted:accepted,originalsUnchanged:audited.every(name=>hashes[name]===hash(name)),metrics,actualCallsReserved:checkpoint.callsReserved,actualCallLimit:checkpoint.limits.maxCalls,remainingActualCalls:checkpoint.limits.maxCalls-checkpoint.callsReserved,unprocessedOriginalEntries:remaining.length,remainingFirstLayerRequests:chunks.length,remainingChunks:chunks,minimumRemainingCallsWithWriting:chunks.length+1,excludesFurtherGlobalMerge:true,simulatedCallsReservedAfterReplay:saved.callsReserved,simulatedCursorAfterReplay:saved.navigation.cursor};
 fs.writeFileSync('release/conversation-insights-20261115/memory-retest/mixed-fact-audit.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify(result));
}finally{await vite.close()}
