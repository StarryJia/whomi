import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createServer} from 'vite';
const base='release/conversation-insights-20261115/long-comparison-runs/memory-bounded-20261116/shared-workload-reading/';
const read=name=>JSON.parse(fs.readFileSync(base+name,'utf8'));
const checkpoint=read('checkpoint.json'),input=read('input.json'),snapshot=read('snapshot.json'),originalRequest=read('request-24.json');
const expected=JSON.parse(originalRequest.prompt),response=fs.readFileSync(base+'response-24.txt','utf8');
const files=['checkpoint.json','input.json','snapshot.json','request-24.json','response-24.txt'];
const hash=name=>createHash('sha256').update(fs.readFileSync(base+name)).digest('hex');
const before=Object.fromEntries(files.map(name=>[name,hash(name)]));
const vite=await createServer({configFile:false,server:{middlewareMode:true},optimizeDeps:{noDiscovery:true,include:[]},appType:'custom'});
try{
 const {generateInsight}=await vite.ssrLoadModule('/electron/main/insight-generation.ts');
 const {countInsightInput}=await vite.ssrLoadModule('/electron/main/insight-packing.ts');
 const model={id:checkpoint.modelId,version:checkpoint.modelVersion,label:'offline-mixed-unknown',model:'gpt-6.1-sol',baseUrl:'https://invalid.example',contextWindow:16000,maxInputTokens:7000,maxTokens:3000,enabled:true,hasCredential:false};
 let simulatedDispatches=0,saved,captured;const stop=new Error('OFFLINE_ORIGINAL_RESPONSE_ACCEPTED');
 try{await generateInsight({snapshot,conversationId:'offline',model,prompts:checkpoint.prompts,limits:checkpoint.limits,checkpoint},{
  signal:new AbortController().signal,onText(){},async read(ids){return input.messages.filter(m=>ids.includes(m.id))},
  async saveCheckpoint(value){saved=structuredClone(value);if(value.navigation.cursor===111&&value.navigation.nextRoots.length===7)throw stop},
  async run(request){simulatedDispatches++;const p=JSON.parse(request.prompt);if(simulatedDispatches!==1||JSON.stringify(p.nodes)!==JSON.stringify(expected.nodes))throw new Error('REPLAY_GROUP_DIFFERS');
   captured={inputEstimate:(await countInsightInput(request,model)).tokens,maxFactTextLength:p.maxFactTextLength,maxFactCount:p.maxFactCount,outputLimit:request.outputTokenLimit};
   return{text:response,checkpoint:'',usage:{inputTokens:0,outputTokens:0}};
  }
 })}catch(e){if(e!==stop)throw e}
 const facts=expected.nodes.flatMap(node=>checkpoint.navigation.nodes[node.navigationId].facts);
 const accepted=saved.navigation.nodes.at(-1).facts;
 const bytes=f=>Buffer.byteLength(JSON.stringify({observations:f.filter(x=>x.kind==='fact').map(({text,sourceIds})=>({text,sourceIds})),openThreads:f.filter(x=>x.kind==='unknown').map(({text,sourceIds})=>({text,sourceIds}))}));
 const out={kind:'offline-mixed-unknown-replay',networkCalls:0,simulatedDispatches,originalResponseAccepted:true,originalsUnchanged:files.every(n=>before[n]===hash(n)),callsReservedBefore:checkpoint.callsReserved,simulatedCallsReservedAfter:saved.callsReserved,cursorBefore:checkpoint.navigation.cursor,cursorAfter:saved.navigation.cursor,...captured,inputWritingFactBytes:bytes(facts),outputWritingFactBytes:bytes(accepted),outputTextLength:accepted.reduce((s,f)=>s+[...f.text].length,0),knownParts:accepted.filter(f=>f.kind==='fact'&&(f.text==='投影线已测正常。'||f.text==='二十七号已订室换文。')),remainingUnknowns:accepted.filter(f=>f.kind==='unknown'&&(f.text==='对方三号是否带线未明。'||f.text==='篇名及两处篇目指代未明。'))};
 fs.writeFileSync('release/conversation-insights-20261115/memory-retest/mixed-unknown-replay.json',JSON.stringify(out,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(out));
}finally{await vite.close()}
