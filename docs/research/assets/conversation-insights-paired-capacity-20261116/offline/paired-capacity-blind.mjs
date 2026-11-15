import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
const caseName=process.argv[2];
if(!['shared-workload','conditional-reschedule'].includes(caseName))throw new Error('Select one fixed case');
const root='release/conversation-insights-20261115';
const sourceRoot=path.join(root,'long-comparison-runs');
const mappingFile=path.join(root,`paired-blind-${caseName}-mapping.json`);
if(fs.existsSync(mappingFile))throw new Error('Blind bundle already exists');
let inputs=['baseline','current'].flatMap(arm=>['adaptive','direct'].map(method=>({arm,method,file:path.join(sourceRoot,arm==='current'?'memory-capacity-current-v2-20261116':'memory-capacity-baseline-20261116',`${caseName}-${method}`,'report.json')})));
let absentBaseline;
const baselineResult=path.join(sourceRoot,'memory-capacity-baseline-20261116',`${caseName}-reading`,'result.json');
if(caseName==='conditional-reschedule' && fs.existsSync(baselineResult)) {
  const result=JSON.parse(fs.readFileSync(baselineResult,'utf8'));
  if(result.state==='failed' && inputs.filter(item=>item.arm==='baseline').every(item=>!fs.existsSync(item.file))) {
    absentBaseline={state:result.state,error:result.error,calls:result.calls};
    inputs=inputs.filter(item=>item.arm==='current');
  }
}
if(inputs.some(item=>!fs.existsSync(item.file))){console.log(JSON.stringify({state:'awaiting-reports',caseName}));process.exit(0);}
const output=path.join(root,'blind-source-order',`paired-${caseName}`);
fs.mkdirSync(output,{recursive:true});
const map=inputs.map(item=>{
  const report=JSON.parse(fs.readFileSync(item.file,'utf8'));
  const anonymous={aboutYou:report.aboutYou,relationship:report.relationship,citations:report.citations,limitations:report.limitations};
  const label='report-'+randomBytes(4).toString('hex');
  const bytes=JSON.stringify(anonymous,null,2)+'\n';
  fs.writeFileSync(path.join(output,label+'.json'),bytes,{flag:'wx'});
  return{label,...item,anonymousSha256:createHash('sha256').update(bytes).digest('hex')};
});
fs.writeFileSync(mappingFile,JSON.stringify({caseName,output,...(absentBaseline?{absentBaseline}:{}),mapping:map},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({caseName,output,labels:map.map(item=>item.label).sort()}));
