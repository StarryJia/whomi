import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, copyFile, symlink, rmdir, unlink, readFile, readdir } from 'node:fs/promises'
import Database from 'better-sqlite3'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

for (const boundary of ['main', 'data']) test(`rejects a test directory junction at the ${boundary} boundary without opening its target database`, async () => {
  const target = await mkdtemp(resolve('.whomi-runtime-target-'))
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-'))
  let application
  let linked = false
  let validDirectory
  try {
    const database = new Database(join(target, 'whomi.db'))
    database.exec("CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES ('untouched')")
    database.close()
    await copyFile('tests/desktop/probe.cjs', join(target, 'probe.cjs'))
    const before = await readFile(join(target, 'whomi.db'))
    const files = (await readdir(target)).sort()
    await rmdir(directory)
    await symlink(target, directory, 'junction')
    linked = true
    let started = false
    if (boundary === 'main') try {
      application = await electron.launch({
        ...(process.env.WHOMI_PACKAGED_EXECUTABLE
          ? { executablePath: resolve(process.env.WHOMI_PACKAGED_EXECUTABLE), args: ['--whomi-runtime-test'] }
          : { args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'] }),
        env: { ...process.env, WHOMI_RUNTIME_TEST: directory },
        timeout: 10000,
      })
      await application.firstWindow()
    } catch {}
    if (boundary === 'main') started = Boolean(application)
    else {
      validDirectory = await mkdtemp(join(tmpdir(), 'whomi-runtime-'))
      await copyFile('tests/desktop/probe.cjs', join(validDirectory, 'probe.cjs'))
      application = await electron.launch({
        ...(process.env.WHOMI_PACKAGED_EXECUTABLE
          ? { executablePath: resolve(process.env.WHOMI_PACKAGED_EXECUTABLE), args: ['--whomi-runtime-test'] }
          : { args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'] }),
        env: { ...process.env, WHOMI_RUNTIME_TEST: validDirectory },
      })
      await application.firstWindow()
      started = await application.evaluate(async ({ app, utilityProcess }, linkedDirectory) => {
        const { dirname, join } = process.getBuiltinModule('node:path')
        const entry = app.isPackaged ? join(app.getAppPath(), 'out/main/data/entry.cjs') : join(dirname(process.argv[1]), 'data/entry.cjs')
        const child = utilityProcess.fork(entry, [linkedDirectory, '--runtime-probe'])
        return new Promise(resolve => {
          child.once('exit', () => resolve(false))
          child.once('message', () => { child.kill(); resolve(true) })
          child.postMessage({ id: 1, method: 'health', payload: null })
        })
      }, directory)
    }
    await application?.close()
    application = undefined
    expect.soft(started).toBe(false)
    expect.soft((await readdir(target)).sort()).toEqual(files)
    expect(await readFile(join(target, 'whomi.db'))).toEqual(before)
  } finally {
    await application?.close()
    if (linked) await unlink(directory)
    else await rm(directory, { recursive: true, force: true })
    await rm(target, { recursive: true, force: true })
    if (validDirectory) await rm(validDirectory, { recursive: true, force: true })
  }
})

test('saved data survives a restart while the renderer stays isolated', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'whomi-runtime-'))
  await copyFile('tests/desktop/probe.cjs', join(directory, 'probe.cjs'))
  const launch = () => electron.launch({
    ...(process.env.WHOMI_PACKAGED_EXECUTABLE
      ? { executablePath: resolve(process.env.WHOMI_PACKAGED_EXECUTABLE), args: ['--whomi-runtime-test'] }
      : { args: [resolve('out/main/index.cjs'), '--whomi-runtime-test'] }),
    env: { ...process.env, WHOMI_RUNTIME_TEST: directory },
  })
  let application
  try {
    application = await launch()
    const page = await application.firstWindow()
    await expect(page.locator('main')).toBeAttached()
    expect(await page.evaluate(() => typeof window.require !== 'undefined' || typeof window.process !== 'undefined')).toBe(false)
    const health = await application.evaluate(async () => globalThis.__whomiRuntimeProbe.request('health', null))
    expect(health.writable).toBe(true)
    console.info(`runtime=${health.runtime} sqlite=${health.sqliteVersion} writable=${health.writable}`)
    const [major, minor, patch] = health.sqliteVersion.split('.').map(Number)
    expect(major * 1000000 + minor * 1000 + patch).toBeGreaterThanOrEqual(3051003)
    await application.evaluate(async () => globalThis.__whomiRuntimeProbe.request('probe.write', null))
    await application.close()
    application = await launch()
    await application.firstWindow()
    expect(await application.evaluate(async () => globalThis.__whomiRuntimeProbe.request('probe.read', null))).toBe('saved')
    await expect(application.evaluate(async () => globalThis.__whomiRuntimeProbe.request('unknown', null))).rejects.toThrow()
    await expect(application.evaluate(async () => {
      const pending = globalThis.__whomiRuntimeProbe.request('probe.pending', null)
      await globalThis.__whomiRuntimeProbe.close()
      return pending
    })).rejects.toThrow()
  } finally {
    await application?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
