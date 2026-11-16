import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'vite';
const vite=await createServer({configFile:false,server:{middlewareMode:true},optimizeDeps:{noDiscovery:true,include:[]},appType:'custom'});
try {
  const {generateInsight}=await vite.ssrLoadModule('/electron/main/insight-generation.ts');
  const {countInsightInput}=await vite.ssrLoadModule('/electron/main/insight-packing.ts');
  const base='release/conversation-insights-20261115/long-comparison-runs/memory-bounded-20261116/shared-workload-reading-resume-2/';
  const files=['checkpoint.json','snapshot.json','input.json'];
  const hash=name=>createHash('sha256').update(fs.readFileSync(base+name)).digest('hex');
  const hashes=Object.fromEntries(files.map(name=>[name,hash(name)]));
  const read=name=>JSON.parse(fs.readFileSync(base+name,'utf8'));
  const checkpoint=read('checkpoint.json'),snapshot=read('snapshot.json'),input=read('input.json');
  const audit=JSON.parse(fs.readFileSync('release/conversation-insights-20261115/memory-retest/source-order-packing.json','utf8'));
  const facts=[...checkpoint.observations.map(note=>({...note,kind:'fact'})),...checkpoint.openThreads.map(note=>({...note,kind:'unknown'}))];
  const expected=audit.sourceOrdinalStable.groups.flatMap(group=>group.originalIndices).map(index=>facts[index]);
  const model={id:checkpoint.modelId,version:checkpoint.modelVersion,label:'offline-source-order-migration',model:'gpt-6.1-sol',baseUrl:'https://invalid.example',contextWindow:16000,maxInputTokens:7000,maxTokens:3000,enabled:true,hasCredential:false};
  const stop=new Error('OFFLINE_FIRST_REQUEST_CAPTURED');
  let migrated,saved,captured;
  try {
    await generateInsight({snapshot,conversationId:'offline',model,prompts:checkpoint.prompts,limits:checkpoint.limits,checkpoint},{
      signal:new AbortController().signal,onText(){},async read(ids){return input.messages.filter(message=>ids.includes(message.id));},
      async saveCheckpoint(value){saved=structuredClone(value);if(!migrated&&value.navigation?.factsVersion===2)migrated=structuredClone(value);},
      async run(request){captured={payload:JSON.parse(request.prompt),inputEstimate:(await countInsightInput(request,model)).tokens};throw stop;},
    });
  } catch(error) {if(error!==stop)throw error;}
  assert.deepEqual(migrated.navigation.nodes.flatMap(node=>node.facts),expected);
  assert.equal(migrated.callsReserved,checkpoint.callsReserved);
  assert.deepEqual(migrated.attempts,checkpoint.attempts);
  assert.deepEqual(migrated.observations,checkpoint.observations);
  assert.deepEqual(migrated.openThreads,checkpoint.openThreads);
  assert.deepEqual(migrated.checks,checkpoint.checks.map(check=>({...check,pendingNavigation:null,navigationRequests:[]})));
  assert.equal(migrated.navigation.repairs,checkpoint.navigation.repairs);
  assert.equal(migrated.writingRepairs,checkpoint.writingRepairs);
  assert.deepEqual(migrated.limits,checkpoint.limits);
  assert.deepEqual(captured.payload.nodes.flatMap(node=>node.entries).map(entry=>({kind:entry.kind,text:entry.text})),
    expected.slice(0,audit.sourceOrdinalStable.groups[0].count).map(({kind,text})=>({kind,text})));
  assert.ok(captured.inputEstimate<=6744);
  const result={kind:'offline-source-order-migration',networkCalls:0,basis:'closed checkpoint copied in memory only; runner stops before any network operation',
    exactSorted139EntriesPreserved:true,sourceMappingPreserved:true,originalRawNotesUnchanged:true,originalChecksRetainedExceptObsoleteNavigation:true,
    factsVersionBefore:checkpoint.navigation.factsVersion,factsVersionAfter:migrated.navigation.factsVersion,
    callsReservedBefore:checkpoint.callsReserved,callsReservedAfterMigration:migrated.callsReserved,simulatedNextReservation:saved.callsReserved,
    compressionRepairsBefore:checkpoint.navigation.repairs,compressionRepairsAfterMigration:migrated.navigation.repairs,
    writingRepairsBefore:checkpoint.writingRepairs,writingRepairsAfterMigration:migrated.writingRepairs,
    attemptsUnchangedAtMigration:true,limitsUnchanged:true,elapsedAtLeastPrior:migrated.elapsedMs>=checkpoint.elapsedMs,
    firstCompression:{entryCount:captured.payload.nodes.length,facts:captured.payload.nodes.flatMap(node=>node.entries).filter(entry=>entry.kind==='fact').length,
      unknowns:captured.payload.nodes.flatMap(node=>node.entries).filter(entry=>entry.kind==='unknown').length,inputEstimate:captured.inputEstimate,repair:captured.payload.repair??false},
    originalsUnchanged:files.every(name=>hashes[name]===hash(name))};
  fs.writeFileSync('release/conversation-insights-20261115/memory-retest/source-order-migration.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(result));
} finally {await vite.close();}
