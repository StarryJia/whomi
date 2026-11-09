import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url))
const vendor = 'src/vendor/cherry-chat'
const commit = '263667f7a99dfed736c939708a55deb435164820'
const sourceRoot = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(repo, 'artifacts/cherry-chat-source-263667f')

function read(root, file) {
  const path = resolve(root, file)
  const fromRoot = relative(root, path)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`请使用来源清单内的相对路径：${file}`)
  }
  try {
    return readFileSync(path)
  } catch {
    throw new Error(`无法读取文件：${path}`)
  }
}

function digest(bytes, algorithm) {
  return createHash(algorithm).update(bytes).digest('hex')
}

function verifySource(file, bytes, sha256, gitHash) {
  if (digest(bytes, 'sha256') !== sha256) throw new Error(`原文件 SHA-256 不匹配：${file}`)
  if (gitHash) {
    const gitBlob = Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])
    if (digest(gitBlob, 'sha1') !== gitHash) throw new Error(`原文件 Git 摘要不匹配：${file}`)
  }
}

const textExtensions = new Set(['.css', '.ts', '.tsx'])
const normalizeLineEndings = (bytes) => bytes.toString('utf8').replaceAll('\r\n', '\n')

function verifyUnmodified(file, source, local) {
  if (source.equals(local)) return
  const isText = textExtensions.has(extname(file)) || file.endsWith('/LICENSE')
  if (isText && normalizeLineEndings(source) === normalizeLineEndings(local)) return
  throw new Error(`标记为原样保留的文件内容不匹配：${file}`)
}

function verifyManifests() {
  const counts = { original: 0, unmodified: 0, adapted: 0, local: 0 }
  for (const area of ['composer', 'messages', 'shared']) {
    const manifestPath = `${vendor}/${area}/source-manifest.json`
    const manifest = JSON.parse(read(repo, manifestPath))
    if (manifest.commit !== commit) throw new Error(`清单提交不匹配：${manifestPath}`)

    for (const entry of manifest.files) {
      const file = entry.local ?? `${vendor}/${area}/${entry.target}`
      const local = read(repo, file)
      const upstream = entry.upstream ?? entry.source
      if (entry.upstream === null) {
        counts.local += 1
        continue
      }

      const source = read(sourceRoot, upstream)
      verifySource(upstream, source, entry.upstreamSha256 ?? entry.sha256, entry.gitHash)
      counts.original += 1
      const unmodified = area === 'shared' || entry.modified === false || entry.adaptation?.startsWith('原样保留')
      if (unmodified) {
        verifyUnmodified(file, source, local)
        counts.unmodified += 1
      } else {
        counts.adapted += 1
      }
    }
  }
  return counts
}

function verifyLicenses() {
  const upstreamLicense = read(sourceRoot, 'LICENSE')
  verifySource('LICENSE', upstreamLicense, '0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0')
  verifyUnmodified(`${vendor}/LICENSE`, upstreamLicense, read(repo, `${vendor}/LICENSE`))

  const uiPackage = read(sourceRoot, 'packages/ui/package.json')
  verifySource('packages/ui/package.json', uiPackage, 'a25ee3ddab4cf5e77e743805ea4821c9f93b77ea62a370ae4c9faf6a066f64fb')
  const { license, author } = JSON.parse(uiPackage)
  const mit = read(repo, `${vendor}/shared/LICENSE`).toString('utf8')
  if (license !== 'MIT' || !mit.includes('MIT License') || !mit.includes(`Copyright (c) ${author}`)) {
    throw new Error('请核对共用界面包的 MIT 许可与作者署名。')
  }
}

try {
  if (process.argv.length > 3) throw new Error('请仅传入一个固定版本的 Cherry Studio 源码目录。')
  const { original, unmodified, adapted, local } = verifyManifests()
  verifyLicenses()
  console.log(`Cherry 来源校验通过。上游 ${original} 个，本地原样 ${unmodified} 个，适配 ${adapted} 个，清单内本地新增 ${local} 个。`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
