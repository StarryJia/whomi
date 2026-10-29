import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseSynthetic } from './parser-helpers'
import streamChain from 'stream-chain'

// Deliver real parsed records outside the transform stack to exercise deferred stream events.
if (process.argv[4] === 'deferred') {
  const emit = streamChain.prototype.emit
  streamChain.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
    if (event === 'data' || event === 'end') {
      setImmediate(() => emit.call(this, event, ...args))
      return true
    }
    return emit.call(this, event, ...args)
  }
}

async function main() {
  const [id, mutation] = process.argv.slice(2)
  const raw = JSON.parse(await readFile(resolve('tests/fixtures/import', id, 'positive.json'), 'utf8'))
  if (mutation === 'empty') raw.messages = [{}]
  if (mutation === 'roles') delete raw.messages[1].author.roles
  if (mutation === 'attachment') raw.messages[0].attachments = [null]
  if (mutation === 'sender') {
    raw.messages[0].isSend = 1
    raw.messages[0].senderUsername = 123
  }
  if (mutation === 'member') raw.members = [null]
  const events = await parseSynthetic(id, JSON.stringify(raw))
  if (!events.some(e => e.type === 'issue' && e.value.severity === 'blocking')) throw new Error('missing-blocking-diagnostic')
  if (events.some(e => e.type === 'end')) throw new Error('unexpected-success')
  const valid = JSON.parse(await readFile(resolve('tests/fixtures/import', id, 'positive.json'), 'utf8'))
  const next = await parseSynthetic(id, JSON.stringify(valid))
  if (!next.some(e => e.type === 'end') || next.some(e => e.type === 'issue' && e.value.severity === 'blocking')) throw new Error('subsequent-parse-failed')
  process.stdout.write('blocked-and-survived')
}

void main().catch(() => { process.stderr.write('probe-failed'); process.exitCode = 1 })
