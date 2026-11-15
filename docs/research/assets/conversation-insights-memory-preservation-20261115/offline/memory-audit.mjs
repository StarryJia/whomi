import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { insightLongComparisonCases as cases } from '../../tests/quality/insight-long-comparison-material.mjs'

const root = 'release/conversation-insights-20261115/long-comparison-runs/memory-preservation-20261115'
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const requireTrue = (condition, message) => { if (!condition) throw new Error(message) }
const expected = {
  'shared-workload': '6f63b461c034eacaebc473ea5637bef13119aae59e286fa1d449347d9c6af756',
  'conditional-reschedule': '907c6b680d1acc0e4c021e7ae6c26393d1fd144c9c6f45d6ee4a47b316640b2d',
}
const phases = []
const comparisons = []
const totals = { requests: 0, inputTokens: 0, outputTokens: 0 }
for (const [caseName, material] of Object.entries(cases)) {
  requireTrue(digest(material.messages) === expected[caseName], 'Frozen material changed: ' + caseName)
  const sources = new Map(material.messages.map(source => [source.id, source]))
  for (const folder of fs.readdirSync(root, { withFileTypes: true }).filter(folder => folder.isDirectory() && folder.name.startsWith(caseName + '-'))) {
    const directory = path.join(root, folder.name)
    const input = read(path.join(directory, 'input.json'))
    const result = read(path.join(directory, 'result.json'))
    requireTrue(digest(input.messages) === expected[caseName], 'Sent material differs')
    const ledger = fs.readFileSync(path.join(directory, 'attempts.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    const dispatched = ledger.filter(entry => entry.kind === 'dispatched')
    requireTrue(dispatched.length === result.httpRequests, 'Dispatch count mismatch')
    requireTrue(dispatched.every(entry => entry.wireOutputLimit <= 3000), 'Output cap not enforced')
    const timeline = []
    for (const file of fs.readdirSync(directory).filter(name => /^request-\d+\.json$/.test(name)).sort()) {
      const request = read(path.join(directory, file))
      const payload = JSON.parse(request.prompt)
      requireTrue(!request.prompt.includes(material.excluded.text), 'Excluded source sent')
      for (const field of ['messages', 'relatedMessages', 'evidence', 'earlierEvidence']) {
        for (const part of payload[field] ?? []) {
          const original = sources.get(part.id)
          requireTrue(original && ['revision', 'senderName', 'isSelf', 'sentAtMs', 'replyToMessageId'].every(key => original[key] === part[key]), 'Original metadata mismatch')
          requireTrue(part.text === (part.fragment ? original.text.slice(part.fragment.start, part.fragment.end) : original.text), 'Original text mismatch')
        }
      }
      const responseFile = path.join(directory, file.replace('request-', 'response-').replace('.json', '.txt'))
      let response
      if (fs.existsSync(responseFile)) {
        try { response = JSON.parse(fs.readFileSync(responseFile, 'utf8').trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1')) }
        catch { response = { invalidJson: true } }
      }
      let compression
      if (payload.operation === 'compress-navigation' && response?.facts) {
        const entries = new Map(payload.nodes.flatMap(node => node.entries).map(entry => [entry.entryId, entry]))
        const coverage = response.facts.flatMap(fact => fact.entryIds)
        const unknownIds = coverage.filter(id => !entries.has(id))
        const omittedIds = [...entries.keys()].filter(id => !coverage.includes(id))
        const facts = response.facts.map(fact => ({ ...fact,
          inheritedSourceIds: [...new Set(fact.entryIds.flatMap(id => entries.get(id)?.sourceIds ?? []))] }))
        compression = { inputEntries: entries.size, outputFacts: response.facts.length, omittedIds, unknownIds, facts }
      }
      timeline.push({ file, stage: request.stage, inputEstimate: request.inputEstimate,
        messageIds: payload.messages?.map(part => part.id), relatedIds: payload.relatedMessages?.map(part => part.id),
        knownCandidates: payload.knownCandidates?.map(candidate => ({ id: candidate.id, state: candidate.state })),
        candidates: response?.candidates, candidateUpdates: response?.candidateUpdates,
        resolvedThreadSourceIds: response?.resolvedThreadSourceIds,
        action: response?.action, evidenceIds: payload.evidence?.map(part => part.id), compression,
        invalidJson: response?.invalidJson })
    }
    const reportPath = path.join(directory, 'report.json')
    if (fs.existsSync(reportPath)) {
      for (const citation of read(reportPath).citations) for (const fragment of citation.fragments) for (const reference of fragment.sources) {
        requireTrue(sources.get(reference.messageId)?.revision === reference.revision, 'Report reference mismatch')
      }
    }
    totals.requests += result.httpRequests
    totals.inputTokens += result.inputCharged
    totals.outputTokens += result.outputCharged
    phases.push({ phase: folder.name, ...result, timeline })
  }
  const firstWriting = phase => {
    const directory = path.join(root, caseName + '-' + phase)
    if (!fs.existsSync(directory)) return undefined
    return fs.readdirSync(directory).filter(file => /^request-\d+\.json$/.test(file)).sort()
      .map(file => read(path.join(directory, file))).find(request => request.stage === 'writing')
  }
  const adaptive = firstWriting('adaptive'), direct = firstWriting('direct')
  comparisons.push({ caseName, materialDigest: expected[caseName],
    ...(adaptive && direct ? { identicalFinalRequests: ['model', 'systemPrompt', 'prompt', 'outputLimit'].every(key => adaptive[key] === direct[key]),
      adaptiveDigest: digest(adaptive), directDigest: digest(direct), checks: JSON.parse(adaptive.prompt).checks.length } : { completePair: false }) })
}
requireTrue(totals.requests <= 64, 'Trial budget exceeded')
const audit = { totals, comparisons, sourceIntegrity: 'passed', referenceIdsAndRevisions: 'passed',
  limitation: '条目与来源完整不代表文字忠实或引用相关；语义逐项复核另列。', phases }
fs.writeFileSync(path.join(root, 'audit.json'), JSON.stringify(audit, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ totals, comparisons, phases: phases.map(({ phase, state, code, httpRequests, inputCharged, outputCharged }) => ({ phase, state, code, httpRequests, inputCharged, outputCharged })) }, null, 2))
