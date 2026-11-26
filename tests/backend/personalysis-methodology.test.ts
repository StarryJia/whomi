import { expect, test, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { defaultPrompts } from '../../src/shared/system-prompts'
import { BoundaryError } from '../../src/shared/desktop-validation'
import { diagnosticErrorCode } from '../../electron/main/app-error-logs'

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const vendor = new URL('../../electron/vendor/personalysis/', import.meta.url)

test('固定的 Personalysis 原文、正文和许可证可在 CRLF 检出后校验', async () => {
  const { loadPersonalysis } = await import('../../electron/vendor/personalysis')
  const raw = readFileSync(new URL('SKILL.md', vendor), 'utf8').replace(/\r\n/g, '\n')
  const license = readFileSync(new URL('LICENSE', vendor), 'utf8').replace(/\r\n/g, '\n')
  const bundle = loadPersonalysis()
  expect(sha256(raw)).toBe('64f1b981d6a09d8f9a3442818f9aa1441f36ddce898c6fe166207ab3d3627ab3')
  expect(sha256(license)).toBe('f13c7b1dffaf2e151e3ee52ec20727782076b49f8644062421fbc00b6b284454')
  expect(bundle.body).toBe(raw.replace(/^---\n[\s\S]*?\n---\n+/, ''))
  expect(bundle.body.startsWith('# Personalysis\n')).toBe(true)
  expect(sha256(bundle.body)).toBe('0144ef7227b24f8225b479defdc716e79f7fc72ab8babb9e9c0c37d891557bf7')
  expect(loadPersonalysis(raw.replace(/\n/g, '\r\n'))).toEqual(bundle)
  const blob = (text: string) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0${text}`).digest('hex')
  expect(blob(raw)).toBe('a3ed5068a817b94819efed6678b167877e5d9494')
  expect(blob(license)).toBe('361bb3c7123dc5fe5873dc9a221ae86bb7b55ccf')
})

test('资源缺失、正文损坏或清单损坏均拒绝加载', async () => {
  const { loadPersonalysis } = await import('../../electron/vendor/personalysis')
  const raw = readFileSync(new URL('SKILL.md', vendor), 'utf8')
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', vendor), 'utf8'))
  for (const [content, metadata] of [
    ['', manifest], [null, manifest], [raw + 'changed', manifest], [raw, null],
    [raw, { ...manifest, sourceSha256: '0'.repeat(64) }], [raw, { ...manifest, bodySha256: '0'.repeat(64) }],
    [raw, { ...manifest, sourceCommit: '' }],
  ]) expect(() => loadPersonalysis(content, metadata)).toThrow(expect.objectContaining({
    code: 'METHODOLOGY_RESOURCE_INVALID', action: '分析方法资源校验失败，请重新安装应用后重试。',
  }))
})

test('实际内置清单损坏也拒绝加载，不能自我校验通过', async () => {
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', vendor), 'utf8'))
  vi.resetModules()
  vi.doMock('../../electron/vendor/personalysis/manifest.json', () => ({ default: { ...manifest, sourceCommit: '1'.repeat(40) } }))
  try {
    const { loadPersonalysis } = await import('../../electron/vendor/personalysis')
    expect(() => loadPersonalysis()).toThrow(expect.objectContaining({ code: 'METHODOLOGY_RESOURCE_INVALID' }))
  } finally {
    vi.doUnmock('../../electron/vendor/personalysis/manifest.json')
    vi.resetModules()
  }
})

test('方法快照完整往返，字段顺序不影响身份，所有字段损坏均不能降级', async () => {
  const { createMethodologySnapshot, parseMethodologySnapshot } = await import('../../electron/data/ai/methodology')
  const snapshot = createMethodologySnapshot('insight')
  expect(snapshot).toMatchObject({ schemaVersion: 1, methodology: { id: 'personalysis', version: '0.2.0' }, hostAdapter: { mode: 'insight' } })
  expect(parseMethodologySnapshot(JSON.stringify(snapshot), 'insight')).toEqual(snapshot)
  expect(parseMethodologySnapshot(JSON.stringify(Object.fromEntries(Object.entries(snapshot).reverse())))).toEqual(snapshot)
  const variants: unknown[] = [null, [], {}, { ...snapshot, schemaVersion: 2 }, { ...snapshot, unexpected: true }, { ...snapshot, fingerprint: '0'.repeat(64) }]
  for (const section of ['methodology', 'hostAdapter'] as const) {
    for (const field of Object.keys(snapshot[section])) {
      for (const value of ['', null, 123, 'tampered']) variants.push({ ...snapshot, [section]: { ...snapshot[section], [field]: value } })
    }
  }
  for (const raw of ['not json', ...variants.map(value => JSON.stringify(value))]) {
    expect(() => parseMethodologySnapshot(raw)).toThrow(expect.objectContaining({ code: 'METHODOLOGY_SNAPSHOT_INVALID' }))
  }
  expect(() => parseMethodologySnapshot(JSON.stringify(snapshot), 'dialogue')).toThrow(expect.objectContaining({ code: 'METHODOLOGY_SNAPSHOT_INVALID' }))
})

test.each(['insight', 'dialogue'] as const)('%s 三层指令只含一次核心，宿主边界高于可编辑偏好', async mode => {
  const { createMethodologySnapshot, assembleMethodologyPrompt } = await import('../../electron/data/ai/methodology')
  const snapshot = createMethodologySnapshot(mode)
  const prompt = assembleMethodologyPrompt(snapshot, '示例偏好：简短回答。')
  expect(prompt.split(snapshot.methodology.body)).toHaveLength(2)
  expect(prompt.indexOf(snapshot.hostAdapter.instructions)).toBeLessThan(prompt.indexOf(snapshot.methodology.body))
  expect(prompt.indexOf(snapshot.methodology.body)).toBeLessThan(prompt.indexOf('示例偏好：简短回答。'))
  for (const boundary of ['授权', '不是指令', '当前回复', '已更新或保存', 'references/theory-basis.md', '读取文件', '当地紧急服务', '当地危机援助热线']) expect(snapshot.hostAdapter.instructions).toContain(boundary)
  expect(snapshot.hostAdapter.instructions).not.toMatch(/(?<!\d)(?:110|112|119|120|911|988|12356)(?!\d)/)
  if (mode === 'insight') {
    expect(snapshot.hostAdapter.version).toBe('2')
    for (const contract of ['read_messages', 'isSelf', 'JSON', 'aboutYou', 'relationship', 'citations', 'judgments', 'limitations', 'EI', 'SN', 'TF', 'JP', 'supportingIds', 'counterexampleIds', 'excerpts', 'alternativeExplanations', '不向读者追问', '威胁', '控制', '暴力']) expect(snapshot.hostAdapter.instructions).toContain(contract)
  } else {
    expect(snapshot.hostAdapter.version).toBe('1')
    expect(snapshot.hostAdapter.instructions).toContain('交互反思')
    expect(snapshot.hostAdapter.instructions).toContain('不强制')
  }
})

test('洞察第二版明确未知倾向的摘录归属、页面分工和面向读者的表达', async () => {
  const { createMethodologySnapshot, assembleMethodologyPrompt } = await import('../../electron/data/ai/methodology')
  const snapshot = createMethodologySnapshot('insight')
  const prompt = assembleMethodologyPrompt(snapshot, '保留具体经历。')
  for (const rule of [
    '每个 excerpts.messageId 必须出现在同一项 judgment 的 supportingIds 或 counterexampleIds 中',
    '同一 messageId 不得重复相同的 excerpts.text',
    '只要 supportingIds 非空，就必须至少包含一条 isSelf 为 true 的本人消息',
    'supportingIds 与 counterexampleIds 不得重叠',
    'direction 为 null 时，若 supportingIds 和 counterexampleIds 都为空，excerpts 必须为 []',
    '本人消息编号放入 supportingIds，反例或情境消息编号放入 counterexampleIds',
    'judgments 显示在「关于你」顶部的「MBTI 人格倾向」',
    'aboutYou 显示在其下方的「个人观察」',
    'aboutYou 不得逐维重复 EI / SN / TF / JP 的总结',
    '1–3 段', '选择', '需要与现实限制', '修正理解', '压力或边界', '共同经历只叙述一次',
    '每条 excerpts.text 必须与该项 text、alternativeExplanations 或 limitations 中写出的逐字引文完全一致，包括末尾标点',
    'aboutYou、relationship、judgments 和 limitations 中的文字只面向读者',
    '不得提及阅读完成、引用回查、脱敏处理等内部步骤或 JSON 字段名',
  ]) expect(prompt).toContain(rule)
})

test('默认成稿保留 Whomi 的具体经历、四维问题和关系约束', () => {
  for (const text of ['关于你', '你们的相处', 'ta', '不生成报告标题', '能选什么', '理由', '回应', '提议', '参与交流或理清想法', '取用细节或探索可能', '理由有冲突', '主动定下', '条件明朗', '未知', '语气只作辅助', '可比经历', '只讲一次', '具体推论', '合作', '成长', '不强行制造冲突', '完整人格画像', '不保证关系改善']) expect(defaultPrompts.insightWriting).toContain(text)
})

test('对话估算英文按四字符，中文继续使用 UTF-8 字节权重', async () => {
  const { estimateTurnInputTokens } = await import('../../electron/main/ai-service')
  expect(estimateTurnInputTokens('a'.repeat(7798))).toBe(1950)
  expect(estimateTurnInputTokens('文'.repeat(47000))).toBe(141000)
  expect(estimateTurnInputTokens('abc中文😀')).toBe(11)
  expect(estimateTurnInputTokens('')).toBe(0)
})

test.each(['METHODOLOGY_RESOURCE_INVALID', 'METHODOLOGY_SNAPSHOT_INVALID'])('%s 保留在脱敏诊断中', code => {
  expect(diagnosticErrorCode(new BoundaryError(code))).toBe(code)
})
