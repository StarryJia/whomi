import { openStore } from '../../electron/data/db/open'
import { createCommitter } from '../../electron/data/import/merge'
import { resolveTarget } from '../../electron/data/import/identity'
import { candidate,view } from './import-fixture'
const store=openStore(process.argv[2]),boundary=process.argv[3]
const job=store.writer.prepare("INSERT INTO import_jobs(status,phase,created_at_ms) VALUES ('running','committing',0)").run().lastInsertRowid.toString()
const c=candidate(),r=resolveTarget(store,c)
if(r.status!=='matched')throw Error('target')
// SIGKILL from the parent ends this child at the actual transaction boundary.
void createCommitter({[boundary]:()=> {process.send?.('boundary');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)}})(store,view(job,[c],[['m1','m2','m3']]),r.target,new AbortController().signal).catch(()=>process.exit(2))
