import Database from 'better-sqlite3'
import { expect, test } from 'vitest'
import { openStore } from '../../electron/data/db/open'
import { schema, schemaVersion, selfOptOutSchema } from '../../electron/data/db/schema'
import { temporaryStore } from './helpers'
test('migrates and reopens a durable store with independent committed reads', () => {
  const temp = temporaryStore(); const store = openStore(temp.path)
  try {
    expect(store.writer.pragma('user_version', {simple:true})).toBe(BigInt(schemaVersion))
    store.writer.exec("BEGIN; INSERT INTO conversations(title,kind,created_at_ms) VALUES ('A','direct',0)")
    expect(store.reader.prepare('SELECT count(*) AS n FROM conversations').get()).toEqual({n:0n})
    store.writer.exec('COMMIT')
    expect(store.reader.prepare('SELECT count(*) AS n FROM conversations').get()).toEqual({n:1n})
    expect(store.writer.pragma('foreign_key_check')).toEqual([])
    expect(store.writer.pragma('integrity_check', {simple:true})).toBe('ok')
    expect(() => store.reader.exec("DELETE FROM conversations")).toThrow()
    store.close(); const reopened = openStore(temp.path)
    expect(reopened.writer.pragma('user_version',{simple:true})).toBe(BigInt(schemaVersion)); reopened.close()
  } finally { store.close(); temp.cleanup() }
})
test('rejects newer schemas without changing their contents', () => {
  const temp = temporaryStore(); const db = new Database(temp.path)
  db.exec(`PRAGMA user_version=${schemaVersion+1}; CREATE TABLE future(value TEXT); INSERT INTO future VALUES ('kept')`); db.close()
  try { expect(() => openStore(temp.path)).toThrow(/升级/)
    const check = new Database(temp.path); expect(check.prepare('SELECT value FROM future').get()).toEqual({value:'kept'}); check.close()
  } finally { temp.cleanup() }
})

test('upgrades schema one without rewriting records and preserves revoked-only local self choices', () => {
  const temp = temporaryStore(); const old = new Database(temp.path)
  old.exec(schema)
  old.exec("PRAGMA user_version=1; INSERT INTO conversations(id,title,kind,created_at_ms) VALUES (1,'revoked','group',0),(2,'confirmed','group',0),(3,'empty','group',0); INSERT INTO source_conversations(id,conversation_id,platform,namespace) VALUES (1,1,'p','n'),(2,2,'p','n'); INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES (1,1,1,'owner','Owner'),(2,2,2,'owner','Owner'); INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES (1,1,'revoked','user'),(2,2,'revoked','user'),(2,2,'confirmed','user'); INSERT INTO messages(id,conversation_id,sender_kind,sender_name,kind,text,ordinal) VALUES (9007199254740993,1,'system','','system','kept',0)")
  const before = old.prepare('SELECT * FROM self_confirmations ORDER BY id').all(); old.close()
  try {
    const upgraded = openStore(temp.path)
    try {
      expect(upgraded.writer.pragma('user_version', { simple: true })).toBe(BigInt(schemaVersion))
      expect(upgraded.writer.prepare('SELECT conversation_id FROM self_opt_outs').all()).toEqual([{ conversation_id: 1n }])
      expect(upgraded.writer.prepare('SELECT id,text FROM messages').get()).toEqual({ id: 9007199254740993n, text: 'kept' })
      upgraded.writer.defaultSafeIntegers(false)
      expect(upgraded.writer.prepare('SELECT * FROM self_confirmations ORDER BY id').all()).toEqual(before)
      expect(upgraded.writer.pragma('foreign_key_check')).toEqual([])
      expect(() => upgraded.writer.exec('INSERT INTO self_opt_outs VALUES (999)')).toThrow()
      upgraded.writer.exec('INSERT INTO self_opt_outs VALUES (3)')
    } finally { upgraded.close() }
    const reopened = openStore(temp.path)
    try { expect(reopened.writer.prepare('SELECT conversation_id FROM self_opt_outs ORDER BY conversation_id').all()).toEqual([{ conversation_id: 1n }, { conversation_id: 3n }]) } finally { reopened.close() }
  } finally { temp.cleanup() }
})

test('rolls back a failed schema two migration without advancing schema one', () => {
  const temp = temporaryStore(); const old = new Database(temp.path)
  old.exec(schema)
  old.exec("PRAGMA user_version=1; INSERT INTO conversations(title,kind,created_at_ms) VALUES ('kept','group',0); CREATE TABLE self_opt_outs(marker TEXT); INSERT INTO self_opt_outs VALUES ('kept')")
  old.close()
  try {
    expect(() => { const unexpected = openStore(temp.path); unexpected.close() }).toThrow()
    const check = new Database(temp.path)
    try {
      expect(check.pragma('user_version', { simple: true })).toBe(1)
      expect(check.prepare('SELECT title FROM conversations').get()).toEqual({ title: 'kept' })
      expect(check.prepare('SELECT marker FROM self_opt_outs').get()).toEqual({ marker: 'kept' })
    } finally { check.close() }
  } finally { temp.cleanup() }
})
test('upgrades schema two additively and rolls back failed state migration',()=> {
  for(const conflict of [false,true]) {
    const temp=temporaryStore(),old=new Database(temp.path)
    old.exec(schema);old.exec(selfOptOutSchema);old.exec("PRAGMA user_version=2;INSERT INTO import_jobs(id,status,created_at_ms) VALUES (1,'running',0)")
    if(conflict)old.exec('CREATE TABLE import_staging_areas(marker TEXT)')
    old.close()
    try {
      if(conflict) {
        expect(()=>openStore(temp.path)).toThrow()
        const check=new Database(temp.path);try {expect(check.pragma('user_version',{simple:true})).toBe(2);expect(check.prepare('PRAGMA table_info(import_jobs)').all().some((r:unknown)=>(r as {name:string}).name==='phase')).toBe(false)}finally{check.close()}
      }else {
        const s=openStore(temp.path);try {expect(s.writer.pragma('user_version',{simple:true})).toBe(BigInt(schemaVersion));expect(s.reader.prepare('SELECT status,phase FROM import_jobs').get()).toEqual({status:'running',phase:'committing'})}finally{s.close()}
      }
    }finally{temp.cleanup()}
  }
})
test('keeps identifiers exact and never reuses deleted message ids', () => {
  const temp = temporaryStore(); const s = openStore(temp.path)
  try {
    s.writer.exec("INSERT INTO conversations(id,title,kind,created_at_ms) VALUES (9007199254740993,'A','direct',0)")
    expect(s.writer.prepare('SELECT id FROM conversations').get()).toEqual({id:9007199254740993n})
    const insert = s.writer.prepare("INSERT INTO messages(conversation_id,sender_kind,sender_name,kind,text,ordinal) VALUES (?,'unknown','','text',' 好',0)")
    const id = insert.run(9007199254740993n).lastInsertRowid
    s.writer.prepare('DELETE FROM messages WHERE id=?').run(id)
    expect(insert.run(9007199254740993n).lastInsertRowid > id).toBe(true)
  } finally { s.close(); temp.cleanup() }
})
test('sorts known times before unknown times and keeps unknown source order', () => {
  const temp=temporaryStore(); const s=openStore(temp.path)
  try {
    s.writer.exec("INSERT INTO conversations(id,title,kind,created_at_ms) VALUES (1,'A','direct',0); INSERT INTO messages(conversation_id,sender_kind,sender_name,kind,text,ordinal,sent_at_ms) VALUES (1,'system','','system','unknown first',0,NULL),(1,'system','','system','zero',1,0),(1,'unknown','','text','negative',2,-1),(1,'unknown','','text','unknown second',3,NULL)")
    expect(s.reader.prepare('SELECT text FROM messages ORDER BY conversation_id,time_bucket,sort_time,id').all()).toEqual([{text:'negative'},{text:'zero'},{text:'unknown first'},{text:'unknown second'}])
    expect(s.reader.prepare("SELECT name FROM sqlite_master WHERE name='runtime_probe'").get()).toBeUndefined()
  } finally { s.close(); temp.cleanup() }
})
test('enforces scoped identities, member ownership, keys and reply targets', () => {
  const temp = temporaryStore(); const s = openStore(temp.path); const db=s.writer
  try {
    db.exec("INSERT INTO conversations(id,title,kind,created_at_ms) VALUES (1,'A','group',0),(2,'B','group',0); INSERT INTO source_conversations(id,conversation_id,platform,owner_key,conversation_key,namespace) VALUES (1,1,'p','o','a','n'),(2,2,'p','o','b','n'); INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES (1,1,1,'alice','Alice'),(2,2,2,'alice','Alice'); INSERT INTO messages(id,conversation_id,member_id,sender_kind,sender_name,kind,text,ordinal) VALUES (1,1,1,'member','Alice','text','old',0),(2,2,2,'member','Alice','text','other',0); INSERT INTO message_keys(conversation_id,id_namespace,original_id,message_id) VALUES (1,'n','same',1),(2,'n','same',2)")
    expect(() => db.exec("INSERT INTO message_keys VALUES (1,'n','same',1)")).toThrow()
    expect(() => db.exec("INSERT INTO message_keys VALUES (1,'n','wrong',2)")).toThrow()
    expect(() => db.exec("UPDATE messages SET member_id=2 WHERE id=1")).toThrow()
    expect(() => db.exec("INSERT INTO message_replies(message_id,conversation_id,target_message_id) VALUES (1,1,2)")).toThrow()
    db.exec("INSERT INTO message_keys VALUES (1,'n','actual',1)")
    expect(() => db.exec("INSERT INTO message_replies(message_id,conversation_id,target_message_id,original_id,id_namespace,state) VALUES (1,1,1,'invented','n','resolved')")).toThrow()
    db.exec("INSERT INTO message_replies(message_id,conversation_id,target_message_id,original_id,id_namespace,state) VALUES (1,1,1,'actual','n','resolved')")
    expect(() => db.exec("INSERT INTO memberships(conversation_id,source_conversation_id,source_key,display_name) VALUES (1,2,'bad','Bad')")).toThrow()
    db.exec("INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES (1,1,'confirmed','user')")
    expect(db.prepare('SELECT text,sender_name FROM messages WHERE id=1').get()).toEqual({text:'old',sender_name:'Alice'})
    expect(db.pragma('foreign_key_check')).toEqual([])
  } finally { s.close(); temp.cleanup() }
})
test('rolls back a failed migration and preserves the original database', () => {
  const temp=temporaryStore(); const db=new Database(temp.path)
  db.exec("CREATE TABLE messages(marker TEXT); INSERT INTO messages VALUES ('kept')"); db.close()
  try {
    expect(() => openStore(temp.path)).toThrow()
    const check=new Database(temp.path)
    expect(check.pragma('user_version',{simple:true})).toBe(0)
    expect(check.prepare('SELECT marker FROM messages').get()).toEqual({marker:'kept'})
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name='conversations'").get()).toBeUndefined()
    check.close()
  } finally { temp.cleanup() }
})
test('keeps unknown source identities separate and allows only one confirmed self', () => {
  const temp=temporaryStore(); const s=openStore(temp.path); const db=s.writer
  try {
    db.exec("INSERT INTO conversations(id,title,kind,created_at_ms) VALUES (1,'A','group',0); INSERT INTO source_conversations(id,conversation_id,platform,owner_key,conversation_key,namespace) VALUES (1,1,'p',NULL,NULL,'n'),(2,1,'p',NULL,NULL,'n'); INSERT INTO memberships(id,conversation_id,source_conversation_id,source_key,display_name) VALUES (1,1,1,'a','Same'),(2,1,1,'b','Same'); INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES (1,1,'confirmed','user'),(1,2,'candidate','parser')")
    expect(() => db.exec("INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES (1,2,'confirmed','user')")).toThrow()
    expect(() => db.exec("INSERT INTO memberships(conversation_id,source_conversation_id,source_key,display_name) VALUES (1,1,'a','Duplicate')")).toThrow()
    expect(() => db.exec("INSERT INTO accounts(platform,stable_account_key) VALUES ('p','a'),('p','a')")).toThrow()
    expect(db.prepare('SELECT count(*) AS n FROM source_conversations').get()).toEqual({n:2n})
    db.exec("UPDATE self_confirmations SET status='revoked' WHERE status='confirmed'")
    expect(() => db.exec("INSERT INTO self_confirmations(conversation_id,member_id,status,source) VALUES (1,2,'confirmed','parser')")).toThrow()
  } finally { s.close(); temp.cleanup() }
})
