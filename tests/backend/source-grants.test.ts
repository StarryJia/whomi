import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSourceGrants } from '../../electron/main/source-grants'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function sources() {
  const directory = await mkdtemp(join(tmpdir(), 'whomi-grants-')); directories.push(directory)
  const file = join(directory, 'sample.json'); await writeFile(file, '{}')
  const folder = join(directory, 'exports'); await mkdir(folder)
  return { file, folder }
}
describe('source authority', () => {
  it('returns opaque capabilities for actual files and directories without paths', async () => {
    const { file, folder } = await sources(), grants = createSourceGrants()
    const handles = await grants.issue(1, [file, folder])
    expect(handles).toEqual([{ token: expect.any(String), displayName: 'sample.json', kind: 'file' }, { token: expect.any(String), displayName: 'exports', kind: 'directory' }])
    expect(JSON.stringify(handles)).not.toContain(file)
    expect(grants.consume(1, handles)).toEqual([{ rootPath: file }, { rootPath: folder }])
    expect(() => grants.consume(1, handles)).toThrowError(expect.objectContaining({ code: 'INVALID_SOURCE' }))
  })
  it('rejects foreign, forged, expired and revoked capabilities', async () => {
    const { file } = await sources(); let now = 0
    const grants = createSourceGrants(() => now)
    const handles = await grants.issue(1, [file])
    for (const [owner, input] of [[2, handles], [1, [{ ...handles[0], token: 'fake' }]], [1, [{ ...handles[0], rootPath: file }]]] as const) {
      expect(() => grants.consume(owner, input)).toThrowError(expect.objectContaining({ code: 'INVALID_SOURCE' }))
    }
    now = 31 * 60 * 1000
    expect(() => grants.consume(1, handles)).toThrowError(expect.objectContaining({ code: 'INVALID_SOURCE' }))
    const fresh = await grants.issue(1, [file]); grants.revokeWindow(1)
    expect(() => grants.consume(1, fresh)).toThrowError(expect.objectContaining({ code: 'INVALID_SOURCE' }))
  })
  it('rejects missing and relative paths without granting partial authority', async () => {
    const { file } = await sources(), grants = createSourceGrants()
    await expect(grants.issue(1, [file, join(file, 'missing')])).rejects.toMatchObject({ code: 'INVALID_SOURCE' })
    await expect(grants.issue(1, ['relative.json'])).rejects.toMatchObject({ code: 'INVALID_SOURCE' })
  })
})
