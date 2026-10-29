import { realpath } from 'node:fs/promises'
import { createReadStream, readFileSync, statSync } from './snapshot-fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { ParserInput } from './types'

export class ParseFailure extends Error {
  constructor(public code: string, public ordinal?: number) { super(code) }
}
export function checkCancelled(input: ParserInput) {
  if (input.signal.aborted) throw new ParseFailure('cancelled')
}
export const recordLimit = (input: ParserInput) => Math.min(input.limits?.maxRecordBytes ?? 8 * 1024 ** 2, 8 * 1024 ** 2)
export async function checkFile(input: ParserInput, file: string, stream = false) {
  checkCancelled(input)
  const info = statSync(file)
  const limit = Math.min(input.limits?.maxFileBytes ?? Infinity, stream ? 2 * 1024 ** 3 : 32 * 1024 ** 2)
  if (!info.isFile() || info.size > limit) throw new ParseFailure('file-limit')
  return info.size
}
export async function dependency(input: ParserInput, name: unknown) {
  if (typeof name !== 'string' || !name || isAbsolute(name)) throw new ParseFailure('manifest-path')
  const root = await realpath(dirname(input.entry))
  const target = resolve(dirname(input.entry), name)
  if (!input.allowedFiles.some(file => resolve(file) === target)) throw new ParseFailure('manifest-path')
  const actual = await realpath(target)
  const rel = relative(root, actual)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new ParseFailure('manifest-path')
  await checkFile(input, target)
  return target
}
export async function boundedText(input: ParserInput, file = input.entry) {
  await checkFile(input, file)
  const text = readFileSync(file, 'utf8')
  if (Buffer.byteLength(text) > Math.min(input.limits?.maxFileBytes ?? Infinity, 32 * 1024 ** 2)) throw new ParseFailure('file-limit')
  return text
}
// Node 24 supplies the numeric source spelling before precision can be lost.
export function parseJson(text: string): any {
  // Bound nesting before both the native reviver and upstream quadratic-depth filters.
  let depth = 0, quoted = false, escaped = false
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === '{' || char === '[') {
      if (++depth > 128) throw new ParseFailure('json-depth')
    } else if (char === '}' || char === ']') depth--
  }
  return JSON.parse(text, (key, value, context?: { source: string }) => {
    // Upstream Assembler writes properties onto ordinary objects.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new ParseFailure('unsafe-property')
    return typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)
      ? context?.source ?? (() => { throw new ParseFailure('unsafe-number') })() : value
  })
}
export async function* lines(input: ParserInput, file = input.entry): AsyncGenerator<string> {
  await checkFile(input, file, true)
  const source = createReadStream(file, { highWaterMark: 64 * 1024, signal: input.signal })
  let parts: Buffer[] = [], size = 0, total = 0
  const max = recordLimit(input)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    for await (const chunk of source) {
      checkCancelled(input)
      const bytes = chunk as Buffer
      total += bytes.length
      if (total > Math.min(input.limits?.maxFileBytes ?? Infinity, 2 * 1024 ** 3)) throw new ParseFailure('file-limit')
      let offset = 0
      while (offset < bytes.length) {
        const newline = bytes.indexOf(10, offset)
        const end = newline < 0 ? bytes.length : newline
        const part = bytes.subarray(offset, end)
        if (size + part.length > max) throw new ParseFailure('record-limit')
        parts.push(part); size += part.length
        if (newline < 0) break
        yield decoder.decode(Buffer.concat(parts, size)).replace(/\r$/, '')
        parts = []; size = 0; offset = newline + 1
      }
    }
    if (size) yield decoder.decode(Buffer.concat(parts, size)).replace(/\r$/, '')
  } finally { source.destroy() }
}
