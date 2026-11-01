import { expect, test } from 'vitest'
import { openStore } from '../../electron/data/db/open'
import { createAiRepository } from '../../electron/data/ai/repository'
import { temporaryStore } from './helpers'

test('saved task and turn retain their strength through restart and retry', async () => {
  const temp = temporaryStore()
  let store = openStore(temp.path)
  try {
    store.writer.exec(`INSERT INTO conversations(id,title,kind,created_at_ms) VALUES(1,'示例','direct',0);
      INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES(1,1,'example','one');
      INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES(1,1,1,'me','本人');
      INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES(1,1,'confirmed','user');
      INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal) VALUES(1,1,1,'member','本人','text','示例',0)`)
    let repo = createAiRepository(store, async fn => fn())
    await repo.saveModel({id:'m',label:'示例',model:'example',baseUrl:'https://example.com',contextWindow:4096,maxTokens:512,enabled:true})
    const preparation = await repo.prepareAnalysis({conversationId:'1',modelId:'m',thinkingLevel:'high'})
    const task = await repo.confirmAnalysis({token:preparation.token,requestId:'analysis'})
    await repo.saveAnalysis(task.id,{state:'stopped'})
    const thread = await repo.createThread('1')
    const turn = await repo.createTurn({threadId:thread.id,requestId:'turn',prompt:'你好',referenceIds:[],modelId:'m',thinkingLevel:'low'})
    await repo.saveTurn(turn.id,{state:'failed'})
    store.close()
    store = openStore(temp.path)
    repo = createAiRepository(store, async fn => fn())
    expect((await repo.resumeAnalysis(task.id)).thinkingLevel).toBe('high')
    expect(repo.analysisContext(task.id).task.thinkingLevel).toBe('high')
    expect((await repo.beginRetryTurn(turn.id)).thinkingLevel).toBe('low')
    expect(repo.turnContext(turn.id).turn.thinkingLevel).toBe('low')
  } finally { store.close(); temp.cleanup() }
})
