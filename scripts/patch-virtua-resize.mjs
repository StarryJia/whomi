import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { createAnimationFrameResizeObserver } from '../src/vendor/virtua-resize/defer-resize-observer.mjs'

const version = '0.49.1'
const require = createRequire(import.meta.url)
const metadataPath = require.resolve('virtua/package.json')
const packageRoot = dirname(metadataPath)
const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
if (metadata.version !== version) throw new Error('请安装 virtua@' + version + ' 后重新运行补丁脚本。')

const targets = [
  {
    file: 'index.js',
    before: 'd904b21d678ca8f8a8d5f12e07adebcce73b9f9527c65657d69fc8ae3651a0cb',
    after: 'a05755f309a928905220ee160b5ea2f976482d962ad39aa71b7222f01b2d16d3',
    originalCall: 'new (C(T(o)).ResizeObserver)(e)',
    ownerWindow: 'C(T(o))',
  },
  {
    file: 'index.cjs',
    before: '6e4d5f5944323d0ab2cd0ced2007e6d4477aa0f40d0bff77a1c8cd90359c68b2',
    after: '3ce8565b845a598497d76f6d4ebc6613eb5ff1ed3bd19af3d6aa027d6f394740',
    originalCall: 'new (z($(o)).ResizeObserver)(e)',
    ownerWindow: 'z($(o))',
  },
]

const hash = source => createHash('sha256').update(source).digest('hex')
const scheduler = createAnimationFrameResizeObserver.toString().replaceAll('\r\n', '\n')
const updates = []

for (const target of targets) {
  const path = join(packageRoot, 'lib', target.file)
  const source = readFileSync(path, 'utf8')
  const sourceHash = hash(source)
  if (sourceHash === target.after) continue
  if (sourceHash !== target.before) {
    throw new Error('请重新安装 virtua@' + version + ' 以恢复 lib/' + target.file + '。')
  }

  const patched = source
    .replace(target.originalCall, () => 'createAnimationFrameResizeObserver(' + target.ownerWindow + ', e)')
    .replace('//# sourceMappingURL=', () => scheduler + '\n//# sourceMappingURL=')
  if (hash(patched) !== target.after) {
    throw new Error('请核对 virtua/lib/' + target.file + ' 的补丁和校验值。')
  }
  updates.push({ path, patched })
}

for (const { path, patched } of updates) writeFileSync(path, patched)
