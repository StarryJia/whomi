import { openStore } from '../../electron/data/db/open'
import { createCommitter } from '../../electron/data/import/merge'
import { resolveTarget } from '../../electron/data/import/identity'
import { runImport } from '../../electron/data/import/runner'
import { candidate,view } from './import-fixture'
const store=openStore(process.argv[2]),boundary=process.argv[3]
const job=store.writer.prepare("INSERT INTO import_jobs(status,phase,created_at_ms) VALUES ('running','committing',0)").run().lastInsertRowid.toString()
// SIGKILL from the parent ends this child at the actual transaction boundary.
function reachedBoundary() {process.send?.('boundary');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)}
const signal = new AbortController().signal
if (boundary === 'afterFirstTarget') {
  const candidates = [candidate('a','first'), candidate('b','second')]
  for (const c of candidates) c.counts = {seen:1,validRecords:1,invalidRecords:0}
  void runImport(store, {
    path:process.argv[2], jobId:job, candidates, counts:{seen:2,validRecords:2,invalidRecords:0}, issues:[],
    conversation(ids) { return view(job, candidates.filter(c => ids.includes(c.candidateId)), ids.map(id => [id])) },
    preview() { throw new Error('Unexpected preview') }, close() {}, async cleanup() {},
  }, {jobId:job,decisions:[]}, signal, {
    async write(operation) { return operation() },
    commit:createCommitter({ afterCommit:reachedBoundary }),
  }).catch(()=>process.exit(2))
} else {
  const c=candidate(),r=resolveTarget(store,c)
  if(r.status!=='matched')throw Error('target')
  void createCommitter({[boundary]:reachedBoundary})(store,view(job,[c],[['m1','m2','m3']]),r.target,signal).catch(()=>process.exit(2))
}
