import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createServer} from 'vite';
const vite = await createServer({configFile:false,server:{middlewareMode:true},optimizeDeps:{noDiscovery:true,include:[]},appType:'custom'});
try {
  const {buildInsightPrompt} = await vite.ssrLoadModule('/electron/data/ai/insight-prompts.ts');
  const {countInsightInput} = await vite.ssrLoadModule('/electron/main/insight-packing.ts');
  const base = 'release/conversation-insights-20261115/long-comparison-runs/memory-bounded-20261116/shared-workload-reading-resume-2/';
  const read = name => JSON.parse(fs.readFileSync(base + name, 'utf8'));
  const checkpoint = read('checkpoint.json'), snapshot = read('snapshot.json');
  const hashes = Object.fromEntries(['checkpoint.json','snapshot.json'].map(name => [name,createHash('sha256').update(fs.readFileSync(base+name)).digest('hex')]));
  const sourceOrder = new Map(snapshot.sources.map((source,index)=>[source.messageId,index]));
  const facts = [...checkpoint.observations.map(note=>({...note,kind:'fact'})),...checkpoint.openThreads.map(note=>({...note,kind:'unknown'}))]
    .map((fact,index)=>({...fact,originalIndex:index}));
  const ordinal = fact => Math.min(...fact.sourceIds.map(id=>sourceOrder.get(id) ?? Infinity));
  const sorted = [...facts].sort((a,b)=>ordinal(a)-ordinal(b) || (a.kind===b.kind ? 0 : a.kind==='fact' ? -1 : 1));
  const model = {id:checkpoint.modelId,version:checkpoint.modelVersion,label:'offline-source-order',model:'gpt-6.1-sol',baseUrl:'https://invalid.example',contextWindow:16000,maxInputTokens:7000,maxTokens:3000,enabled:true,hasCredential:false};
  const systemPrompt = buildInsightPrompt(checkpoint.prompts,'reading','compress-navigation');
  const payload = nodes => ({stage:'reading',operation:'compress-navigation',
    targetFactTextLength:Math.max(160,Math.floor(nodes.flatMap(node=>node.entries).reduce((sum,entry)=>sum+[...entry.text].length,0)*0.6)),
    maxFactCount:nodes.length*2,nodes});
  async function pack(order) {
    const groups=[]; let cursor=0;
    while(cursor<order.length) {
      const group=[]; let inputEstimate=0;
      for(let index=cursor;index<order.length;index++) {
        const fact=order[index], node={navigationId:index,childCount:0,entries:[{entryId:`${index}:0`,kind:fact.kind,text:fact.text}]};
        const count=await countInsightInput({systemPrompt,prompt:JSON.stringify(payload([...group,node])),history:[],model},model);
        if(count.tokens>6744)break;
        group.push(node);inputEstimate=count.tokens;
      }
      if(!group.length)throw new Error('single entry cannot fit');
      groups.push({inputEstimate,notes:order.slice(cursor,cursor+group.length)});cursor+=group.length;
    }
    const overlap=(a,b)=>a.sourceIds.some(id=>b.sourceIds.includes(id));
    const unknowns=order.filter(fact=>fact.kind==='unknown');
    const eligible=unknowns.filter(unknown=>facts.some(fact=>fact.kind==='fact'&&overlap(fact,unknown)));
    const together=groups.flatMap(group=>group.notes.filter(unknown=>unknown.kind==='unknown'&&group.notes.some(fact=>fact.kind==='fact'&&overlap(fact,unknown))));
    return {entryCount:order.length,unknownCount:unknowns.length,unknownsWithSameSourceKnown:eligible.length,
      unknownsWithSameSourceKnownInBatch:together.length,sameSourceKnownInBatchRatio:together.length/eligible.length,
      allOriginalEntriesExactlyOnce:order.length===facts.length&&new Set(order.map(f=>f.originalIndex)).size===facts.length,
      groups:groups.map((group,index)=>({batch:index+1,inputEstimate:group.inputEstimate,
        count:group.notes.length,facts:group.notes.filter(f=>f.kind==='fact').length,unknowns:group.notes.filter(f=>f.kind==='unknown').length,
        coLocatedUnknowns:group.notes.filter(u=>u.kind==='unknown'&&group.notes.some(f=>f.kind==='fact'&&overlap(f,u))).length,
        originalIndices:group.notes.map(f=>f.originalIndex)}))};
  }
  const result={kind:'offline-source-order-packing',networkCalls:0,inputLimit:7000,availableInput:6744,outputLimit:3000,
    basis:'original raw observations and openThreads; exact current compression protocol and default conservative byte counter; no model or semantic scoring',
    current:await pack(facts),sourceOrdinalStable:await pack(sorted),
    originalsUnchanged:Object.entries(hashes).every(([name,hash])=>createHash('sha256').update(fs.readFileSync(base+name)).digest('hex')===hash)};
  fs.writeFileSync('release/conversation-insights-20261115/memory-retest/source-order-packing.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(result));
} finally {await vite.close();}
