import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
const selected = args.indexOf('--case')
const name = selected < 0 ? 'runtime' : args[selected + 1]
if (!['runtime','crash-recovery'].includes(name)) throw new Error('请选择 runtime 或 crash-recovery 用例。')
const environment = { ...process.env }
// Playwright 的颜色设置与宿主终端的 NO_COLOR 冲突。
delete environment.NO_COLOR
const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', 'tests/desktop/runtime.spec.mjs', '--workers=1', '--timeout=60000', ...(name === 'crash-recovery' ? ['--grep','crash recovery']:['--grep-invert','crash recovery'])], { stdio: 'inherit', env: environment })
process.exit(result.status ?? 1)
