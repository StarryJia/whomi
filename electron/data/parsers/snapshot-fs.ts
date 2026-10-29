import * as fs from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { dirname, relative, resolve, isAbsolute } from 'node:path'
import type { ParserInput } from './types'

type Scope = { files: Map<string, fs.Stats>; streams: Set<fs.ReadStream>; descriptors: Set<number>; signal: AbortSignal }
const active = new AsyncLocalStorage<Scope>()
const key = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
function denied(): never { throw new Error('snapshot-access') }
function same(a: fs.Stats, b: fs.Stats) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && b.isFile() }
function scope() { const value = active.getStore(); if (!value || value.signal.aborted) denied(); return value }
function checked(path: string) {
  const context = scope(), expected = context.files.get(key(path))
  if (!expected || key(fs.realpathSync(path)) !== key(path)) denied()
  return { context, expected }
}
export function openSync(path: string, flags: string) {
  if (flags !== 'r') denied()
  const { context, expected } = checked(path)
  const fd = fs.openSync(path, 'r')
  if (!same(expected, fs.fstatSync(fd))) { fs.closeSync(fd); denied() }
  context.descriptors.add(fd)
  return fd
}
export function closeSync(fd: number) {
  const context = active.getStore()
  if (!context?.descriptors.delete(fd)) denied()
  fs.closeSync(fd)
}
export function readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number) {
  if (!scope().descriptors.has(fd)) denied()
  return fs.readSync(fd, buffer, offset, length, position)
}
export function statSync(path: string) {
  const { expected } = checked(path), actual = fs.statSync(path)
  if (!same(expected, actual)) denied()
  return actual
}
export function existsSync(path: string) { checked(path); return fs.existsSync(path) }
export function readFileSync(path: string, encoding: BufferEncoding): string {
  const fd = openSync(path, 'r')
  try {
    const bytes = fs.readFileSync(fd)
    const value = encoding === 'utf8' || encoding === 'utf-8'
      ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes.toString(encoding)
    const expected = scope().files.get(key(path))!
    if (!same(expected, fs.fstatSync(fd))) denied()
    return value
  } finally { closeSync(fd) }
}
export type ReadStream = fs.ReadStream
export function createReadStream(path: string, options: { encoding?: BufferEncoding; highWaterMark?: number; signal?: AbortSignal } = {}) {
  const fd = openSync(path, 'r'), context = scope()
  // Descriptor validation precedes any bytes read, even if a path changed after realpath.
  const stream = fs.createReadStream(path, { ...options, fd, autoClose: true })
  context.descriptors.delete(fd)
  context.streams.add(stream)
  stream.once('close', () => context.streams.delete(stream))
  return stream
}
export async function* withSnapshot<T>(input: ParserInput, create: () => AsyncGenerator<T>): AsyncGenerator<T> {
  const root = fs.realpathSync(dirname(input.entry))
  const context: Scope = { files: new Map(), streams: new Set(), descriptors: new Set(), signal: input.signal }
  for (const file of new Set([input.entry, ...input.allowedFiles])) {
    const actual = fs.realpathSync(file), rel = relative(root, actual)
    if (key(actual) !== key(file) || isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) denied()
    const info = fs.statSync(actual)
    if (!info.isFile()) denied()
    context.files.set(key(file), info)
  }
  const iterator = create()
  try {
    while (true) {
      const result = await active.run(context, () => iterator.next())
      if (result.done) break
      yield result.value
    }
  } finally {
    await active.run(context, () => iterator.return(undefined))
    for (const stream of context.streams) stream.destroy()
    for (const fd of context.descriptors) fs.closeSync(fd)
  }
}
