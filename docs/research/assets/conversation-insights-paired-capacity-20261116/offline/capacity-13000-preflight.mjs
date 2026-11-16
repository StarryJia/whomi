import fs from 'node:fs';
import {createServer} from 'vite';
import {insightLongComparisonCases} from '../../../tests/quality/insight-long-comparison-material.mjs';
const vite=await createServer({configFile:false,server:{middlewareMode:true},optimizeDeps:{noDiscovery:true,include:[]},appType:'custom'});
try {
  const {generateInsight}=await vite.ssrLoadModule('/electron/main/insight-generation.ts');
  const {defaultInsightPrompts,buildInsightPrompt}=await vite.ssrLoadModule('/electron/data/ai/insight-prompts.ts');
  const {countInsightInput,resolveInsightCapacity}=await vite.ssrLoadModule('/electron/main/insight-packing.ts');
  const {longComparisonWritingPrompt}=await vite.ssrLoadModule('/tests/quality/insight-comparison.ts');
  const model={id:'offline',label:'offline',model:'gpt-6.1-sol',baseUrl:'https://invalid.example',maxInputTokens:13000,maxTokens:3000,enabled:true,version:1,hasCredential:false};
  const limits={maxChecks:8,maxRoundsPerCheck:4,maxCalls:50,maxInputTokens:400000,maxOutputTokens:40000,maxElapsedMs:1200000};
  const result={kind:'offline-uniform-13000-capacity',networkCalls:0,modelCapacity:resolveInsightCapacity(model),availableInput:12744,
    caveat:'Reading uses no generated candidates and either empty responses or historical notes selected from visible raw sources; batch counts are projections, not future model outcomes. Compression estimates cover packing only, not output quality or successful convergence.',cases:[]};
  for(const [name,material] of Object.entries(insightLongComparisonCases)) {
    const baselinePath=name==='shared-workload'
      ? 'release/conversation-insights-20261115/long-comparison-runs/memory-source-order-20261116/shared-workload-reading-resume/checkpoint.json'
      : 'docs/research/assets/conversation-insights-long-comparison-20261115/conditional-reschedule-reading/checkpoint.json';
    const baseline=JSON.parse(fs.readFileSync(baselinePath,'utf8'));
    const snapshot={taskId:'offline',scope:material.scope,timezone:'Asia/Shanghai',createdAtMs:0,
      sourceStartTimeMs:material.messages[0].sentAtMs,sourceEndTimeMs:material.messages.at(-1).sentAtMs,
      sources:material.messages.map(message=>({messageId:message.id,revision:message.revision}))};
    const row={name,messages:material.messages.length,historicalNoteSource:baselinePath,reading:[]};
    for(const mode of ['empty-notes','historical-notes']) {
      const stop=new Error('OFFLINE_READING_COMPLETE'),emitted=new Set(),requests=[];let saved;
      try {await generateInsight({snapshot,conversationId:'offline',model,prompts:defaultInsightPrompts,limits,checkpoint:null},{
        signal:new AbortController().signal,onText(){},async read(ids){return material.messages.filter(message=>ids.includes(message.id));},
        async saveCheckpoint(value){saved=structuredClone(value);if(value.coveredMessageIds.length===material.messages.length)throw stop;},
        async run(request){
          const payload=JSON.parse(request.prompt);if(payload.operation||payload.stage!=='reading')throw new Error('UNEXPECTED_OFFLINE_STAGE');
          requests.push({ids:payload.messages.map(message=>message.id),inputEstimate:(await countInsightInput(request,model)).tokens});
          const visible=new Set([...payload.messages,...payload.relatedMessages].map(message=>message.id));
          const notes=(items,kind)=>mode==='empty-notes'?[]:items.filter(note=>!emitted.has(kind+JSON.stringify(note))&&note.sourceIds.every(id=>visible.has(id))).slice(0,48)
            .map(note=>{emitted.add(kind+JSON.stringify(note));return note;});
          return{text:JSON.stringify({observations:notes(baseline.observations,'fact'),openThreads:notes(baseline.openThreads,'unknown'),candidates:[]}),
            usage:{inputTokens:100,outputTokens:100},checkpoint:''};
        },
      });}catch(error){if(error!==stop)throw error;}
      row.reading.push({mode,requests:requests.length,covered:saved.coveredMessageIds.length,notes:saved.observations.length,unknowns:saved.openThreads.length,batches:requests});
    }
    const order=new Map(snapshot.sources.map((source,index)=>[source.messageId,index]));
    const facts=[...baseline.observations.map(note=>({...note,kind:'fact'})),...baseline.openThreads.map(note=>({...note,kind:'unknown'}))];
    const earliest=fact=>Math.min(...fact.sourceIds.map(id=>order.get(id)??Infinity));
    facts.sort((a,b)=>earliest(a)-earliest(b)||(a.kind===b.kind?0:a.kind==='fact'?-1:1));
    const payload=nodes=>({stage:'reading',operation:'compress-navigation',targetFactTextLength:Math.max(160,Math.floor(nodes.flatMap(node=>node.entries).reduce((sum,entry)=>sum+[...entry.text].length,0)*.6)),maxFactCount:nodes.length*2,nodes});
    const groups=[];let cursor=0;
    while(cursor<facts.length){const nodes=[];let estimate=0;
      for(let index=cursor;index<facts.length;index++){
        const fact=facts[index],node={navigationId:index,childCount:0,entries:[{entryId:index+':0',kind:fact.kind,text:fact.text}]};
        const size=(await countInsightInput({model,systemPrompt:buildInsightPrompt(defaultInsightPrompts,'reading','compress-navigation'),prompt:JSON.stringify(payload([...nodes,node])),history:[]},model)).tokens;
        if(size>12744)break;nodes.push(node);estimate=size;
      }
      if(!nodes.length)throw new Error('UNPACKABLE_OFFLINE_ENTRY');
      groups.push({entries:nodes.length,inputEstimate:estimate,targetFactTextLength:payload(nodes).targetFactTextLength});cursor+=nodes.length;
    }
    row.rawNoteCompression={entries:facts.length,firstLayerRequests:groups.length,groups};
    const notes=kind=>facts.filter(fact=>fact.kind===kind).map(({text,sourceIds})=>({text,sourceIds}));
    const writingPayload={stage:'writing',timezone:snapshot.timezone,observations:notes('fact'),openThreads:notes('unknown'),
      checks:baseline.checks.map(({id,state,finding,observation})=>({id,state,finding,...(finding?{}:{observation})}))};
    row.rawNoteWriterEstimate=(await countInsightInput({model,systemPrompt:longComparisonWritingPrompt,prompt:JSON.stringify(writingPayload),history:[]},model)).tokens;
    result.cases.push(row);
  }
  fs.writeFileSync('release/conversation-insights-20261115/memory-retest/capacity-13000-preflight.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(result));
}finally{await vite.close();}
