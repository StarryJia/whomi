import { createHash } from 'node:crypto'
import { BoundaryError } from '../../../src/shared/desktop-validation'
import rawSkill from './SKILL.md?raw'
import manifest from './manifest.json'

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
// Pin the manifest independently so a damaged bundled manifest cannot validate itself.
const manifestSha256 = '69d40dbb8315020b2ff859c51f31146f36309866a343f47d14ef79d59518bce3'

export function loadPersonalysis(raw: unknown = rawSkill, metadata: unknown = manifest) {
  const invalid = () => new BoundaryError('METHODOLOGY_RESOURCE_INVALID', '分析方法资源校验失败，请重新安装应用后重试。')
  if (typeof raw !== 'string' || !raw.trim() || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw invalid()
  const supplied = metadata as typeof manifest
  const fields = Object.entries(supplied).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  if (fields.some(([, value]) => typeof value !== 'string') || sha256(JSON.stringify(fields)) !== manifestSha256) throw invalid()
  // Git may check out CRLF on Windows; provenance always hashes LF text.
  const normalized = raw.replace(/\r\n/g, '\n')
  if (sha256(normalized) !== supplied.sourceSha256) throw invalid()
  const body = normalized.replace(/^---\n[\s\S]*?\n---\n+/, '')
  if (!body.trim() || body === normalized || sha256(body) !== supplied.bodySha256) throw invalid()
  const { id, version, sourceRepo, sourceCommit, sourceSha256, bodySha256 } = supplied
  return { id, version, sourceRepo, sourceCommit, sourceSha256, bodySha256, body }
}
