import { openStore } from '../../electron/data/db/open'
import { commitConversation } from '../../electron/data/import/merge'
import { resolveTarget } from '../../electron/data/import/identity'
import { candidate } from './import-fixture'
import { message } from './helpers'
import { normalizeModel } from '../../src/shared/conversation-model'

async function main() {
  const store=openStore(process.argv[2]),c=candidate('bounded-dedup'),count=250000
  c.members=[{sourceKey:'sender',stableAccountKey:'account',displayName:'Synthetic',selfHint:null}]
  try {
    store.writer.exec("INSERT INTO conversations VALUES(1,'Synthetic','direct',0);INSERT INTO source_conversations VALUES(1,1,'p','owner','chat','test');INSERT INTO accounts VALUES(1,'p','account');INSERT INTO memberships VALUES(1,1,1,'sender','Synthetic',1,NULL)")
    const content=(ordinal:number)=>`Synthetic ${ordinal} ${'x'.repeat(512)}`
    const insert=store.writer.prepare("INSERT INTO messages(conversation_id,member_id,sender_kind,sender_name,sent_at_ms,time_precision,timezone,kind,text,ordinal) VALUES(1,1,'member','Synthetic',1000,'millisecond','UTC','text',?,?)")
    store.writer.transaction(()=>{for(let i=0;i<count;i++)insert.run(content(i),i)})()
    const jobId=store.writer.prepare("INSERT INTO import_jobs(status,created_at_ms) VALUES('running',0)").run().lastInsertRowid.toString()
    const target=resolveTarget(store,c);if(target.status!=='matched')throw Error('target')
    const result=await commitConversation(store,{jobId,candidates:[c],candidateIds:[c.candidateId],sources:[{candidateId:c.candidateId,identity:c.identity}],
      *messages(){for(let ordinal=0;ordinal<count;ordinal++)yield{candidateId:c.candidateId,
        message:normalizeModel(message({ordinal,senderKey:'sender',senderKind:'member',senderName:'Synthetic',sentAtMs:1000,timePrecision:'millisecond',timezone:'UTC',text:content(ordinal)})),
        origin:{fingerprint:'new-export',sourceConversationKey:'chat',ordinal,parserId:'test',parserVersion:'1'}}}
    },target.target,new AbortController().signal)
    process.send?.({inserted:result.inserted,duplicates:result.duplicates},()=>process.disconnect())
  }finally{store.close()}
}
void main().catch(error=>{process.stderr.write(String(error));process.exit(1)})
