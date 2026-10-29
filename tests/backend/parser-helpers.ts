import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getParsers } from '../../electron/data/parsers/registry'
import type { ParseEvent, ParserInput } from '../../electron/data/parsers/types'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

export async function collect(id: string, file = 'positive.json', overrides: Partial<ParserInput> = {}) {
  const folder = resolve('tests/fixtures/import', id)
  const manifest = JSON.parse(await readFile(resolve(folder, 'fixture.json'), 'utf8'))
  const input: ParserInput = {
    candidateId: 'synthetic', entry: resolve(folder, file),
    allowedFiles: manifest.files.map((p: string) => resolve(folder, p)),
    signal: new AbortController().signal, ...overrides,
  }
  const events: ParseEvent[] = []
  for await (const event of getParsers().find(p => p.id === id)!.parse(input)) events.push(event)
  return events
}

export async function parseSynthetic(id: string, text: string, options: Partial<ParserInput> = {}) {
  const dir = await mkdtemp(resolve(tmpdir(), 'whomi-parser-'))
  const entry = resolve(dir, id === 'chatlab-jsonl' ? 'input.jsonl' : 'input.json')
  try {
    await writeFile(entry, text)
    const events: ParseEvent[] = []
    for await (const event of getParsers().find(p => p.id === id)!.parse({ candidateId: 'synthetic', entry, allowedFiles: [], signal: new AbortController().signal, ...options })) events.push(event)
    return events
  } finally { await rm(dir, { recursive: true, force: true }) }
}

