import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createServer} from 'vite';
const root='release/conversation-insights-20261115/long-comparison-runs/';
const current=root+'memory-capacity-current-v2-20261116/';
const baseline=root+'memory-capacity-baseline-20261116/conditional-reschedule-reading/';
const artifacts=new Set();
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const originalHashes=new Map();
const read=file=>{artifacts.add(file);originalHashes.set(file,hash(file));return JSON.parse(fs.readFileSync(file,'utf8'));};
const input=read(current+'shared-workload-reading/input.json');
const checkpoint=read(current+'shared-workload-reading/checkpoint.json');
const report=read(current+'shared-workload-adaptive/report.json');
const writingRequest=read(current+'shared-workload-adaptive/request-01.json');
const writingResponse=read(current+'shared-workload-adaptive/response-01.txt');
const writingPayload=JSON.parse(writingRequest.prompt);
const writingBase=read(current+'shared-workload-adaptive/writing-base.json');
const base={timezone:writingPayload.timezone,observations:writingPayload.observations,openThreads:writingPayload.openThreads};
const relevant=text=>/借书|借出|第二问|第二个问题|组织回忆|所有沉默/.test(text);
const stages=[];
for(const file of fs.readdirSync(current+'shared-workload-reading').filter(file=>/^request-\d+\.json$/.test(file)).sort()){
  const requestPath=current+'shared-workload-reading/'+file;
  const responsePath=requestPath.replace('request-','response-').replace(/\.json$/,'.txt');
  const request=read(requestPath),payload=JSON.parse(request.prompt),response=read(responsePath);
  if(!payload.operation){
    const notes=response.observations.map((note,index)=>({...note,index})).filter(note=>relevant(note.text));
    if(notes.length)stages.push({stage:'reading',requestPath,responsePath,notes});
    continue;
  }
  const entries=new Map(payload.nodes.flatMap(node=>node.entries.map(entry=>[entry.entryId,
    checkpoint.navigation.nodes[node.navigationId].facts[Number(entry.entryId.split(':')[1])]])));
  const facts=response.facts.map((fact,index)=>({...fact,index,sourceIds:[...new Set(fact.entryIds.flatMap(id=>entries.get(id).sourceIds))]}));
  const outputNode=checkpoint.navigation.nodes.findIndex(node=>JSON.stringify(node.children)===JSON.stringify(payload.nodes.map(node=>node.navigationId))
    &&JSON.stringify(node.facts?.map(fact=>fact.text))===JSON.stringify(facts.map(fact=>fact.text)));
  const notes=facts.filter(fact=>relevant(fact.text));
  if(notes.length)stages.push({stage:'compression',requestPath,responsePath,inputNodeIds:payload.nodes.map(node=>node.navigationId),outputNode,notes});
}
const sourceIds=['37','38','39','40','41','42','43','45','46'];
const rawSources=input.messages.filter(message=>sourceIds.includes(message.id));
const writerNotes=[...writingPayload.observations.map((note,index)=>({...note,field:'observations',index})),
  ...writingPayload.openThreads.map((note,index)=>({...note,field:'openThreads',index}))].filter(note=>relevant(note.text));
const reportFragments=[...report.aboutYou.flatMap((paragraph,index)=>paragraph.content.map((fragment,contentIndex)=>({...fragment,section:'aboutYou',paragraph:index,contentIndex}))),
  ...report.relationship.flatMap((paragraph,index)=>paragraph.content.map((fragment,contentIndex)=>({...fragment,section:'relationship',paragraph:index,contentIndex})))];
const errors=[
  {id:'borrow-answer-became-promise',firstDefiniteErrorStage:'writing',firstDefiniteErrorArtifact:current+'shared-workload-adaptive/response-01.txt',
    precursorStage:'compression',precursorArtifact:current+'shared-workload-reading/response-11.txt',
    interpretation:'Source 38 and reading response 02 say answering questions about borrowing. Compression 08 still says answering borrowing questions. Compression 11 first shortens this to 答借书, retained in 12/13 and the writer input. That is ambiguous and loses 问题; the first explicit unsupported commitment 答应借书 occurs in writer response 01, then report.json unchanged.',
    source38:rawSources.find(message=>message.id==='38'),fragment:reportFragments.find(fragment=>fragment.text.includes('答应借书')),
    qualification:'Source 46 says the other party did not promise lending on the owner’s behalf for the later inquiry. It does not prove that no earlier lending promise occurred; source 38 simply does not support the report’s affirmative claim.'},
  {id:'silence-counterexample-cited-neighboring-sources',firstDefiniteErrorStage:'writing',firstDefiniteErrorArtifact:current+'shared-workload-adaptive/response-01.txt',
    precursorStage:'compression',precursorArtifact:current+'shared-workload-reading/response-08.txt',
    interpretation:'The concrete second-question counterexample is source 40. Reading response 02 preserves it with sources 38/39/40. Compression 08 merges that note with adjacent material and inherits 38–43; subsequent notes and the final writer input still contain source 40. Writer response 01 attaches citation 43 with only 41/42/43, none of which states the counterexample; report.json retains those IDs.',
    source40:rawSources.find(message=>message.id==='40'),fragment:reportFragments.find(fragment=>fragment.text.includes('这提供了一个具体反例')),
    selectedCitation:report.citations.find(citation=>citation.id==='43'),
    qualification:'Broad inherited sources reduce citation precision but did not erase source 40. The first incorrect final source selection is the writer output, not a parser remapping.'},
];
for(const error of errors){const citation=report.citations.find(citation=>citation.id===error.fragment.citationId);error.citation=citation;error.citedRawSources=input.messages.filter(message=>citation.fragments.flatMap(fragment=>fragment.sources.map(source=>source.messageId)).includes(message.id));}
const baselineRequest=read(baseline+'request-04.json'),baselinePayload=JSON.parse(baselineRequest.prompt),baselineResponse=read(baseline+'response-04.txt');
const generationFile='electron/main/insight-generation.ts',generationHash=hash(generationFile);
// 内存中仅导出既有私有解析函数，保留其完整实现和依赖。
const vite=await createServer({configFile:false,server:{middlewareMode:true},optimizeDeps:{noDiscovery:true,include:[]},appType:'custom',plugins:[{
  name:'offline-expose-existing-reading-parser',enforce:'pre',transform(code,id){
    if(id.replaceAll('\\','/').endsWith('/electron/main/insight-generation.ts'))return code+'\nexport { parseReading as offlineParseReading };\n';
  },
}]});
const {offlineParseReading}=await vite.ssrLoadModule('/electron/main/insight-generation.ts');
const rawEvidence=[...baselinePayload.messages,...baselinePayload.relatedMessages],rawIds=new Set(rawEvidence.map(message=>message.id));
const knownNotes=baselinePayload.knownCandidates.flatMap(candidate=>candidate.evidenceNotes);
const repeatedOldNotes=baselineResponse.candidateUpdates.flatMap(update=>update.evidenceNotes).filter(note=>!rawIds.has(note.sourceId))
  .map(note=>({...note,exactlyMatchesVisiblePriorQuote:knownNotes.some(prior=>prior.sourceId===note.sourceId&&prior.quote===note.quote)}));
const parserCases=[];
for(const control of ['original','disjoint-only','current-notes-only','both']){
  const response=structuredClone(baselineResponse);
  for(const update of response.candidateUpdates){
    if(control==='disjoint-only'||control==='both')update.finding.supportingIds=update.finding.supportingIds.filter(id=>!update.finding.counterexampleIds.includes(id));
    if(control==='current-notes-only'||control==='both')update.evidenceNotes=update.evidenceNotes.filter(note=>rawIds.has(note.sourceId));
  }
  let code;
  try{offlineParseReading({text:JSON.stringify(response),checkpoint:''},rawEvidence,baselinePayload.knownCandidates,baselinePayload.openThreads);code='ACCEPTED_READING_RESPONSE';}
  catch(error){code=error.code??error.message;}
  parserCases.push({control,code,networkCalls:0,checkpointApplied:false});
}
const evidence={kind:'paired-capacity-workload-error-trace',networkCalls:0,productionCodeEdited:false,trialRecoveryPerformed:false,
  readingResult:read(current+'shared-workload-reading/result.json'),adaptiveResult:read(current+'shared-workload-adaptive/result.json'),
  errors,rawSources,stages,
  checkpointNodes:checkpoint.navigation.nodes.map((node,index)=>({...node,index})).filter(node=>node.facts?.some(fact=>relevant(fact.text))),
  writer:{requestPath:current+'shared-workload-adaptive/request-01.json',baseSidecar:writingBase,
    baseHashMatches:createHash('sha256').update(JSON.stringify(base)).digest('hex')===writingBase.sharedBaseHash,notes:writerNotes,
    rawCitation43:writingResponse.citations.find(citation=>citation.id==='43')},
  baselineSecondCaseCurrentParser:{requestPath:baseline+'request-04.json',responsePath:baseline+'response-04.txt',
    method:'Exact current parser loaded through Vite with an in-memory export of the existing private function; saved request fields supplied directly. Controls modify only in-memory response copies, never original artifacts or trial state.',
    currentGenerationSha256:generationHash,repeatedOldNotes,cases:parserCases,
    conclusion:'The current parser still immediately rejects re-emitted prior notes 62/63 that are absent from current raw evidence, even though their exact quotes are visible in knownCandidates. Removing only those repeated notes leaves support/counterexample overlap, now a repairable INVALID_INSIGHT_OUTPUT in current code. Removing both conditions accepts the response in this parser-only control; it is not an accepted trial result.'},
  originalsUnchanged:[...originalHashes].every(([file,before])=>hash(file)===before)&&hash(generationFile)===generationHash,
  originalHashes:Object.fromEntries(originalHashes)};
const prefix='release/conversation-insights-20261115/memory-retest/paired-capacity-workload-error-trace';
fs.writeFileSync(prefix+'.json',JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
const md=`# 配对试验首组残余错误追溯\n\n本记录只读检查 current-v2 的 shared-workload 已完成结果，未调用模型、未修改冻结代码或原产物。正文和引用的原始证据见同名 JSON；文件哈希核对通过。\n\n## 回答借书被写成答应借书\n\n- 原文 38：对方看到本人收笔记时仍在回答借书的事，没有确认借出承诺。\n- 通读 response-02：准确记为仍回答借书问题，来源 38、39、40；原笔记保存在叶节点 29。\n- 压缩 response-08／节点 90：仍答借书问题，已与相邻事项合并。\n- 压缩 response-11／节点 93：首次缩成仍答借书，删去了问题，表达出现歧义；response-12／节点 94、response-13／最终节点 95 沿用这一缩写。\n- 实际 writer request-01 中仍是答借书，并未明确承诺。writing-base.json 是摘要哈希侧车，本身不保存正文；其 sharedBaseHash 与该请求提取的正文基底一致。\n- 首个明确的错误发生在 adaptive response-01：写成一边收笔记一边答应借书；report.json 原样保留。\n\n结论：通读未误录；压缩引入易误解的省略，成稿首次明确增加了承诺。原文 46 的未代为答应属于稍后询问，不能倒推九号绝无任何承诺，但原文 38 不支持报告的肯定说法。\n\n## 沉默反例引用了相邻原文\n\n- 原文 40 才是对方尚在回忆第二个问题、本人已换段的具体例子。\n- 通读 response-02 正确保留该例，来源 38、39、40；叶节点 29 保留正文与编号。\n- 压缩 response-08 把该笔记与叶 30 合并，来源扩成 38–43，包含担心赶车及买菜讨论。后续各轮与最终 writer 输入都仍保留 40，没有丢失正确来源。\n- 成稿 adaptive response-01 为该句选择 citationId 43，对应 messageIds 41、42、43；三条分别是赶车／休息、买菜、蘑菇豆腐做法，不是沉默反例。report.json 没有改写这些编号。\n\n结论：首次确定的错误是成稿错选引用，非程序转换编号。压缩后每条事实继承较宽的来源集合，降低了细分陈述与来源的对应精度，但这一次正确来源 40 确实仍在输入中。\n\n## 基线第二组的当前解析边界\n\n对基线 conditional-reschedule response-04 直接调用当前完整阅读解析函数，仅在内存导出既有私有函数，没有运行生成流程或修改账本：\n\n| 内存控制 | 当前解析结果 |\n|---|---|\n${parserCases.map(row=>`| ${row.control} | ${row.code} |`).join('\n')}\n\n原响应重发 62、63 的逐字摘录；这两句与 knownCandidates 中已验证摘录完全一致，却不在本批 messages／relatedMessages 内。当前新增 evidenceNotes 只允许从本批原文摘录，因此仍立即 INVALID_EVIDENCE。这是当前仍未解决的恢复／格式容错边界，不能描述为修复版一定不会遇到。\n\n只移除这两条重发摘录后，支持与反例编号重叠触发当前版本的一次格式修复错误 INVALID_INSIGHT_OUTPUT；旧基线对此是 INVALID_EVIDENCE。两项都移除的内存控制能通过解析，但不是原真实试验接受的结果。\n\n## 尚未解决的边界\n\n1. 简短压缩措辞可能产生歧义，成稿仍可能把回答问题补写成承诺；条目覆盖和来源继承不能验证逐句语义。\n2. 来源集合完整不等于每一句引用精准；当前引用校验验证编号资格，不能判断选中的原文是否支持该句。\n3. 重复输出已验证旧摘录仍会被当作无本批原文依据的新增摘录立即拒绝。\n\n以上只界定本次两处报告错误与基线失败边界，不修改评分，也不推断其他未检查内容全部正确。\n`;
fs.writeFileSync(prefix+'.md',md,{flag:'wx'});
console.log(JSON.stringify({json:prefix+'.json',markdown:prefix+'.md',firstDefiniteErrors:errors.map(error=>({id:error.id,stage:error.firstDefiniteErrorStage,precursor:error.precursorArtifact})),baseHashMatches:evidence.writer.baseHashMatches,parserCases,originalsUnchanged:evidence.originalsUnchanged}));
await vite.close();
