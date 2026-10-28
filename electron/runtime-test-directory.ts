import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { tmpdir } from 'node:os'

export function validateRuntimeTestDirectory(directory: string | undefined): string {
  if (!directory) throw new Error('请使用独立的临时测试目录。')
  const actual = realpathSync(directory)
  // 独立目录排除目录联接，避免辅助探针触碰链接目标。
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(actual).isDirectory()
    || dirname(actual) !== realpathSync(tmpdir()) || !basename(actual).startsWith('whomi-runtime-')) {
    throw new Error('请使用独立的临时测试目录。')
  }
  return actual
}
