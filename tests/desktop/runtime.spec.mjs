import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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
