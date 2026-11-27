import { createHash } from 'node:crypto'
import { BoundaryError } from '../../../src/shared/desktop-validation'
import rawSkill from './SKILL.md?raw'
import manifest from './manifest.json'

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
// Pin the manifest independently so a damaged bundled manifest cannot validate itself.
const manifestSha256 = 'afe346db8eba6003430d47cc35a4756b853cca0fe905221644d8e23cee011ca2'
const invalid = () => new BoundaryError('METHODOLOGY_RESOURCE_INVALID', '分析方法资源校验失败，请重新安装应用后重试。')

export function splitPersonalysisBody(body: string) {
  const headings = [...body.matchAll(/^## .*$/gm)]
  const material = headings.find(heading => heading[0] === '## Task: Material analysis')
  const dialogue = headings.find(heading => heading[0] === '## Task: Interactive dialogue')
  if (!material || !dialogue || material !== headings.at(-2) || dialogue !== headings.at(-1)) throw invalid()

  const core = body.slice(0, material.index).trim()
  const materialAnalysis = body.slice(material.index, dialogue.index).trim()
  const interactiveDialogue = body.slice(dialogue.index).trim()
  return { core, materialAnalysis, interactiveDialogue,
    materialAnalysisSlice: core + '\n\n' + materialAnalysis,
    interactiveDialogueSlice: core + '\n\n' + interactiveDialogue }
}

export function loadPersonalysisBundle(raw: unknown = rawSkill, metadata: unknown = manifest) {
  if (typeof raw !== 'string' || !raw.trim() || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw invalid()
  const supplied = metadata as typeof manifest
  const fields = Object.entries(supplied).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  if (fields.some(([, value]) => typeof value !== 'string') || sha256(JSON.stringify(fields)) !== manifestSha256) throw invalid()
  // Git may check out CRLF on Windows; provenance always hashes LF text.
  const normalized = raw.replace(/\r\n/g, '\n')
  if (sha256(normalized) !== supplied.sourceSha256) throw invalid()
  const body = normalized.replace(/^---\n[\s\S]*?\n---\n+/, '').trim()
  if (sha256(body) !== supplied.bodySha256) throw invalid()
  const sections = splitPersonalysisBody(body)
  if (sha256(sections.materialAnalysisSlice) !== supplied.materialAnalysisSha256 ||
      sha256(sections.interactiveDialogueSlice) !== supplied.interactiveDialogueSha256) throw invalid()
  return { manifest: supplied, body, ...sections }
}

export function loadPersonalysis(mode: 'insight' | 'dialogue', raw: unknown = rawSkill, metadata: unknown = manifest) {
  const bundle = loadPersonalysisBundle(raw, metadata)
  const { id, version, sourceRepo, sourceCommit, sourceSha256, materialAnalysisSha256, interactiveDialogueSha256 } = bundle.manifest
  return { id, version, sourceRepo, sourceCommit, sourceSha256,
    bodySha256: mode === 'insight' ? materialAnalysisSha256 : interactiveDialogueSha256,
    body: mode === 'insight' ? bundle.materialAnalysisSlice : bundle.interactiveDialogueSlice }
}
