import { openStore } from '../../electron/data/db/open'
import { resolveAutoTarget } from '../../electron/data/import/auto-target'
import { candidate } from './import-fixture'
import { message } from './helpers'
import { normalizeModel } from '../../src/shared/conversation-model'

async function main() {
  const store=openStore(process.argv[2]),c=candidate('bounded')
  c.identity.ownerKey=null;c.identity.conversationKey=null
  c.members=[{sourceKey:'sender',stableAccountKey:'account',displayName:'Synthetic',selfHint:null}]
  let processed=0
  try {
    const result=await resolveAutoTarget(store,c,function*(){
      for(let ordinal=0;ordinal<1000000;ordinal++) {
        processed++
        yield {candidateId:c.candidateId,message:normalizeModel(message({ordinal,senderKey:'sender',senderKind:'member',sentAtMs:ordinal+1000,timePrecision:'millisecond',timezone:'UTC',text:`Synthetic ${ordinal}`})),
          origin:{fingerprint:'synthetic',sourceConversationKey:'chat',ordinal,parserId:'test',parserVersion:'1'}}
      }
    })
    process.send?.({processed,status:result.status,heapBytes:process.memoryUsage().heapUsed},()=>process.disconnect())
  }finally{store.close()}
}
void main().catch(error=>{process.stderr.write(String(error));process.exit(1)})
