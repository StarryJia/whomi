import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createServer} from 'vite';
const baseline='release/conversation-insights-20261115/long-comparison-runs/memory-capacity-baseline-20261116/conditional-reschedule-reading/';
const files=['request-04.json','response-04.txt','checkpoint.json','result.json'];
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hashes=Object.fromEntries(files.map(name=>[name,hash(baseline+name)]));
const read=name=>JSON.parse(fs.readFileSync(baseline+name,'utf8'));
const request=read('request-04.json'),payload=JSON.parse(request.prompt),response=read('response-04.txt');
const vite=await createServer({configFile:false,server:{middlewareMode:true},optimizeDeps:{noDiscovery:true,include:[]},appType:'custom',plugins:[{
  name:'offline-expose-existing-reading-parser',enforce:'pre',transform(code,id){
    if(id.replaceAll('\\','/').endsWith('/electron/main/insight-generation.ts'))return code+'\nexport { parseReading as offlineParseReading };\n';
  },
}]});
try {
  const {offlineParseReading}=await vite.ssrLoadModule('/electron/main/insight-generation.ts');
  const raw=[...payload.messages,...payload.relatedMessages],rawIds=new Set(raw.map(message=>message.id));
  const cases=[];
  for(const control of ['original','disjoint-only','current-notes-only','both']){
    const copy=structuredClone(response);
    for(const update of copy.candidateUpdates){
      if(control==='disjoint-only'||control==='both')update.finding.supportingIds=update.finding.supportingIds.filter(id=>!update.finding.counterexampleIds.includes(id));
      if(control==='current-notes-only'||control==='both')update.evidenceNotes=update.evidenceNotes.filter(note=>rawIds.has(note.sourceId));
    }
    let code;
    try{offlineParseReading({text:JSON.stringify(copy),checkpoint:''},raw,payload.knownCandidates,payload.openThreads);code='ACCEPTED_READING_RESPONSE';}
    catch(error){code=error.code??error.message;}
    cases.push({control,code,checkpointApplied:false});
  }
  const generation='electron/main/insight-generation.ts',prompts='electron/data/ai/insight-prompts.ts';
  const frozen='release/conversation-insights-20261115/paired-capacity-v2-frozen/current/source/electron/main/insight-generation.ts';
  const result={kind:'local-visible-verified-excerpt-compatibility',networkCalls:0,modelResampled:false,trialRecoveryPerformed:false,
    method:'Exact current parser loaded with a temporary in-memory export. Saved baseline request fields are unchanged; response controls exist only in memory.',
    originalTrialOutcome:read('result.json'),cases,
    originalSourceHashes:hashes,originalsUnchanged:files.every(name=>hashes[name]===hash(baseline+name)),
    productHashes:Object.fromEntries([generation,prompts,'tests/backend/insight-quote-reuse.test.ts','tests/backend/fixtures/insight-visible-excerpt-reuse.json'].map(file=>[file,hash(file)])),
    frozenModelControlGenerationHash:fs.existsSync(frozen)?hash(frozen):null,
    disclosure:'This local compatibility fix was made after all real model calls ended. It changes neither the frozen real trial result nor the scores. The original baseline response still fails for overlapping support/counterexample roles; only its in-memory disjoint control passes parsing.'};
  fs.writeFileSync('release/conversation-insights-20261115/memory-retest/'+(process.argv[2]??'quote-reuse-replay.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(result));
} finally {await vite.close();}
