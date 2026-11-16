import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual as equal } from 'node:util'
import { insightLongComparisonCases as materials } from '../../tests/quality/insight-long-comparison-material.mjs'

const root = 'release/conversation-insights-20261115/long-comparison-runs/memory-source-order-20261116'
const final = process.argv.includes('--final')
const full = process.argv.includes('--json')
if (process.argv.slice(2).some(arg => !['--final', '--json'].includes(arg))) throw new Error('Only --final and --json are supported')
const issues = [], pending = [], phases = [], comparisons = []
const totals = { dispatched: 0, settled: 0, inputTokens: 0, outputTokens: 0, readingRequests: 0, compressionRequests: 0, checkingRequests: 0, writingRequests: 0 }
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const unique = values => [...new Set(values)]
const requireTrue = (condition, where, message) => { if (!condition) issues.push({ where, message }) }
const expected = {
  'shared-workload': '6f63b461c034eacaebc473ea5637bef13119aae59e286fa1d449347d9c6af756',
  'conditional-reschedule': '907c6b680d1acc0e4c021e7ae6c26393d1fd144c9c6f45d6ee4a47b316640b2d',
}
function json(file, optional = false) {
  if (!fs.existsSync(file)) { if (!optional) pending.push(file); return undefined }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) }
  catch { (final ? issues : pending).push(final ? { where: file, message: 'Invalid JSON artifact' } : file); return undefined }
}
function jsonl(file) {
  if (!fs.existsSync(file)) return []
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean), entries = []
  for (const [index, line] of lines.entries()) {
    try { entries.push(JSON.parse(line)) }
    catch {
      if (!final && index === lines.length - 1) pending.push(file + ':' + (index + 1))
      else issues.push({ where: file, message: 'Invalid ledger line ' + (index + 1) })
    }
  }
  return entries
}
function response(file) {
  if (!fs.existsSync(file)) return undefined
  const text = fs.readFileSync(file, 'utf8').trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1')
  try { return JSON.parse(text) } catch { return { invalidJson: true } }
}
function factNotes(facts) {
  const notes = kind => facts.filter(fact => fact.kind === kind).map(({ text, sourceIds }) => ({ text, sourceIds }))
  return { observations: notes('fact'), openThreads: notes('unknown') }
}
const factBytes = facts => Buffer.byteLength(JSON.stringify(factNotes(facts)), 'utf8')
const factCharacters = facts => facts.reduce((total, fact) => total + [...fact.text].length, 0)
const navigationFacts = (navigation, id) => navigation?.nodes[id]?.facts

const profile = json(path.join(root, 'run-profile.json'))
requireTrue(profile?.runId === 'memory-source-order-20261116' && profile?.perTaskLimits.maxCalls === 50
  && profile?.totalRequestLimit === 104 && profile?.syntheticPackingInputEstimateLimit === 7000
  && profile?.perRequestOutputLimit === 3000 && profile?.perTaskLimits.maxOutputTokens === 40000, 'run-profile', 'Unexpected fixed trial profile')
for (const [caseName, material] of Object.entries(materials)) {
  requireTrue(digest(material.messages) === expected[caseName], caseName, 'Frozen material changed')
  requireTrue(profile?.materialHashes[caseName] === digest({ scope: material.scope, messages: material.messages, excluded: material.excluded }), caseName, 'Profile material hash mismatch')
  const sources = new Map(material.messages.map(source => [source.id, source]))
  const casePhases = []
  const phaseOrder = ['reading', 'reading-resume', 'reading-resume-2', 'adaptive', 'direct', 'direct-rich']
  const directories = fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory() && item.name.startsWith(caseName + '-'))
    .sort((a, b) => phaseOrder.indexOf(a.name.slice(caseName.length + 1)) - phaseOrder.indexOf(b.name.slice(caseName.length + 1)))
  for (const folder of directories) {
    const directory = path.join(root, folder.name)
    const input = json(path.join(directory, 'input.json'))
    const result = json(path.join(directory, 'result.json'), true)
    const checkpoint = json(path.join(directory, 'checkpoint.json'), true)
    const snapshot = json(path.join(directory, 'snapshot.json'))
    const report = json(path.join(directory, 'report.json'), true)
    const events = jsonl(path.join(directory, 'events.jsonl'))
    if (!input) continue
    requireTrue(digest(input.messages) === expected[caseName] && equal(input.scope, material.scope) && equal(input.excluded, material.excluded), folder.name, 'Input material or scope mismatch')
    requireTrue(input.runId === profile.runId && input.totalRequestLimit === profile.totalRequestLimit
      && input.syntheticPackingInputEstimateLimit === 7000 && input.perRequestOutputLimit === 3000
      && input.model === 'gpt-6.1-sol', folder.name, 'Input profile differs')
    const single = ['direct', 'direct-rich'].includes(input.variant)
    requireTrue(equal(input.limits, { ...profile.perTaskLimits, ...(single ? { maxCalls: 1, maxOutputTokens: 3000 } : {}) }), folder.name, 'Phase task limits differ')
    if (snapshot) requireTrue(equal(snapshot.sources, material.messages.map(message => ({ messageId: message.id, revision: message.revision }))), folder.name, 'Snapshot sources differ')
    const ledger = jsonl(path.join(directory, 'attempts.jsonl'))
    const reserved = new Map(), dispatched = new Set(), settled = new Set()
    let chargedInput = 0, chargedOutput = 0
    for (const entry of ledger) {
      if (entry.kind === 'reserved') {
        requireTrue(entry.call === reserved.size + 1 && !reserved.has(entry.call), folder.name, 'Reservation order differs')
        reserved.set(entry.call, entry)
      } else if (entry.kind === 'dispatched') {
        requireTrue(reserved.has(entry.call) && !dispatched.has(entry.call) && entry.wireOutputLimit > 0
          && entry.wireOutputLimit <= 3000 && entry.wireOutputLimit === reserved.get(entry.call)?.outputLimit, folder.name, 'Dispatch or wire output cap differs')
        dispatched.add(entry.call)
      } else if (entry.kind === 'settled') {
        const reservation = reserved.get(entry.call)
        requireTrue(reservation && !settled.has(entry.call), folder.name, 'Settlement lacks a unique reservation')
        const usage = entry.usage
        chargedInput += usage?.totalInputTokens ?? (usage?.inputTokens === undefined ? reservation?.inputEstimate ?? 0
          : usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0))
        chargedOutput += usage?.outputTokens ?? reservation?.outputLimit ?? 0
        requireTrue(equal(entry.charged, { input: chargedInput, output: chargedOutput }), folder.name, 'Cumulative usage differs')
        settled.add(entry.call)
      }
    }
    if (result) requireTrue(result.httpRequests === dispatched.size && result.calls === reserved.size && result.calls === settled.size
      && result.inputCharged === chargedInput && result.outputCharged === chargedOutput, folder.name, 'Result totals differ from ledger')
    else pending.push(folder.name + '/result.json')
    requireTrue(reserved.size <= input.limits.maxCalls, folder.name, 'Local reservations exceed phase request limit')
    const callOffset = checkpoint && result ? checkpoint.callsReserved - result.calls : 0
    if (checkpoint && result) {
      requireTrue(checkpoint.attempts.length === checkpoint.callsReserved && checkpoint.callsReserved <= 50
        && equal(checkpoint.limits, profile.perTaskLimits), folder.name, 'Checkpoint budget differs')
      for (const [call, reservation] of reserved) {
        const attempt = checkpoint.attempts[callOffset + call - 1]
        const usage = ledger.find(item => item.kind === 'settled' && item.call === call)?.usage
        requireTrue(attempt && attempt.input.tokens === reservation.inputEstimate && attempt.reservedOutput === reservation.outputLimit
          && equal(attempt.usage, usage), folder.name, 'Checkpoint attempt differs from local ledger: ' + call)
      }
      for (const check of checkpoint.checks) for (const note of check.evidenceNotes ?? []) {
        requireTrue(sources.get(note.sourceId)?.text.includes(note.quote), folder.name, 'Accepted quote differs from original')
      }
      if (result.state === 'completed') {
        const cumulativeInput = checkpoint.attempts.reduce((total, attempt) => total + (attempt.usage?.totalInputTokens
          ?? (attempt.usage?.inputTokens === undefined ? attempt.input.tokens : attempt.usage.inputTokens + (attempt.usage.cacheReadTokens ?? 0) + (attempt.usage.cacheWriteTokens ?? 0))), 0)
        const cumulativeOutput = checkpoint.attempts.reduce((total, attempt) => total + (attempt.usage?.outputTokens ?? attempt.reservedOutput), 0)
        requireTrue(cumulativeInput <= 400000 && cumulativeOutput <= 40000 && checkpoint.elapsedMs <= 1200000, folder.name, 'Completed cumulative task exceeds fixed budget')
      }
    }
    const timeline = []
    for (const file of fs.readdirSync(directory).filter(name => /^request-\d+\.json$/.test(name)).sort()) {
      const call = Number(file.match(/\d+/)[0])
      const request = json(path.join(directory, file))
      if (!request) continue
      let payload
      try { payload = JSON.parse(request.prompt) } catch { issues.push({ where: folder.name + '/' + file, message: 'Invalid request payload' }); continue }
      const where = folder.name + '/' + file
      const body = response(path.join(directory, file.replace('request-', 'response-').replace('.json', '.txt')))
      const wasDispatched = dispatched.has(call)
      const reservation = reserved.get(call)
      requireTrue(reservation && request.inputEstimate === reservation.inputEstimate && request.outputLimit === reservation.outputLimit
        && request.inputEstimate <= 6744, where, 'Request differs from reservation or input capacity')
      requireTrue(!request.prompt.includes(material.excluded.text), where, 'Excluded source sent')
      for (const field of ['messages', 'relatedMessages', 'evidence', 'earlierEvidence']) for (const part of payload[field] ?? []) {
        const original = sources.get(part.id)
        requireTrue(original && ['revision', 'senderName', 'isSelf', 'sentAtMs', 'replyToMessageId'].every(key => original[key] === part[key]), where, 'Original metadata mismatch')
        requireTrue(original && part.text === (part.fragment ? original.text.slice(part.fragment.start, part.fragment.end) : original.text), where, 'Original text mismatch')
      }
      for (const note of [...payload.evidenceNotes ?? [], ...payload.readEvidence ?? [], ...(payload.knownCandidates ?? []).flatMap(candidate => candidate.evidenceNotes ?? [])]) {
        const original = sources.get(note.sourceId)
        requireTrue(original?.text.includes(note.quote), where, 'Sent excerpt differs from original')
        for (const key of ['senderName', 'isSelf', 'sentAtMs', 'replyToMessageId']) if (Object.hasOwn(note, key)) requireTrue(original?.[key] === note[key], where, 'Sent excerpt metadata differs')
      }
      let compression
      if (payload.operation === 'compress-navigation') {
        const entries = new Map(payload.nodes.flatMap(node => node.entries).map(entry => [entry.entryId, entry]))
        const childIds = payload.nodes.map(node => node.navigationId)
        const strictTextLimit = Object.hasOwn(payload, 'maxFactTextLength')
        const textTarget = strictTextLimit ? payload.maxFactTextLength : payload.targetFactTextLength
        requireTrue([...entries.values()].every(entry => !Object.hasOwn(entry, 'sourceIds')), where, 'Compression unexpectedly sends raw source IDs')
        requireTrue(textTarget === Math.max(160, Math.floor(factCharacters([...entries.values()]) * 0.6))
          && !(strictTextLimit && Object.hasOwn(payload, 'targetFactTextLength'))
          && payload.maxFactCount === entries.size * 2, where, 'Compression output budget differs')
        const mapped = new Map()
        if (checkpoint?.navigation) for (const node of payload.nodes) {
          const original = checkpoint.navigation.nodes[node.navigationId]
          requireTrue(original?.children.length === node.childCount, where, 'Navigation input child count differs')
          for (const entry of node.entries) {
            const index = Number(entry.entryId.slice(String(node.navigationId).length + 1))
            const fact = navigationFacts(checkpoint.navigation, node.navigationId)?.[index]
            requireTrue(entry.entryId === node.navigationId + ':' + index && fact?.kind === entry.kind && fact?.text === entry.text, where, 'Compression entry differs from saved navigation')
            if (fact) mapped.set(entry.entryId, fact)
          }
        }
        const outputFacts = Array.isArray(body?.facts) ? body.facts : []
        const referenced = outputFacts.flatMap(fact => Array.isArray(fact.entryIds) ? fact.entryIds : [])
        const retainedKnown = outputFacts.filter(fact => fact.kind === 'fact').flatMap(fact => fact.entryIds ?? [])
        const foreignIds = referenced.filter(id => !entries.has(id))
        const omittedIds = [...entries.keys()].filter(id => !referenced.includes(id))
        const omittedKnownIds = [...entries.values()].filter(entry => entry.kind === 'fact' && !retainedKnown.includes(entry.entryId)).map(entry => entry.entryId)
        const inherited = mapped.size === entries.size && !foreignIds.length ? outputFacts.map(fact => ({
          kind: fact.kind, text: fact.text, sourceIds: unique((fact.entryIds ?? []).flatMap(id => mapped.get(id)?.sourceIds ?? [])),
        })) : undefined
        const acceptedNode = inherited && checkpoint.navigation.nodes.findIndex(node => equal(node.children, childIds) && node.text === body?.text && equal(node.facts, inherited))
        compression = {
          inputEntries: entries.size, outputEntries: outputFacts.length,
          ...(strictTextLimit ? { maxFactTextLength: textTarget } : { targetFactTextLength: textTarget }),
          textPolicy: strictTextLimit ? 'hard-character-limit' : 'character-guidance-with-serialized-progress',
          responseState: !body ? 'pending' : body.invalidJson ? 'invalid-json' : 'returned',
          outputTextLength: Array.isArray(body?.facts) && outputFacts.every(fact => typeof fact.text === 'string') ? factCharacters(outputFacts) : null,
          foreignIds: body ? foreignIds : null, omittedIds: body ? omittedIds : null, omittedKnownIds: body ? omittedKnownIds : null,
          sourceMappingAvailable: mapped.size === entries.size,
          acceptedNode: typeof acceptedNode === 'number' && acceptedNode >= 0 ? acceptedNode : null,
          ...(inherited ? { inputFactBytes: factBytes([...mapped.values()]), outputFactBytes: factBytes(inherited), inheritedFacts: inherited,
            serializedReduction: 1 - factBytes(inherited) / factBytes([...mapped.values()]),
            ...(!strictTextLimit ? { meetsTwentyPercentReduction: factBytes(inherited) <= factBytes([...mapped.values()]) * 0.8 } : {}),
          } : {}),
        }
        if (compression.acceptedNode !== null) requireTrue(!foreignIds.length && !omittedIds.length && !omittedKnownIds.length
          && (!strictTextLimit || compression.outputTextLength <= textTarget), where, 'Accepted compression violates coverage or saved text policy')
        if (compression.acceptedNode !== null && !strictTextLimit && !compression.meetsTwentyPercentReduction) {
          compression.fitExceptionNeedsIndependentReview = true
        }
      }
      const acceptedReading = payload.stage === 'reading' && !payload.operation ? events.findLast(event => event.kind === 'checkpoint'
        && event.callsReserved === callOffset + call && event.pendingRead === null
        && event.coveredMessageIds?.includes(payload.messages?.at(-1)?.id)) : undefined
      const updates = (body?.candidateUpdates ?? []).map(update => ({ ...update,
        accepted: acceptedReading?.checks.some(check => check.id === update.id && (update.action === 'resolve'
          ? check.state === 'finished' && equal(check.finding, update.finding) : check.state === 'pending' && check.observation === update.observation)) ?? false,
      }))
      const step = { file, call, stage: request.stage, dispatched: wasDispatched, repair: payload.repair === true,
        messageIds: payload.messages?.map(message => message.id), relatedIds: payload.relatedMessages?.map(message => message.id),
        knownCandidates: payload.knownCandidates?.map(({ id, state }) => ({ id, state })), proposedCandidates: body?.candidates,
        candidateUpdates: updates, readingAccepted: !!acceptedReading, resolvedThreadSourceIds: body?.resolvedThreadSourceIds,
        action: body?.action, evidenceIds: payload.evidence?.map(message => message.id), earlierEvidenceIds: payload.earlierEvidence?.map(message => message.id),
        compression, responsePresent: !!body, invalidResponseJson: body?.invalidJson, request, payload }
      timeline.push(step)
      if (wasDispatched) {
        if (request.stage === 'reading') totals.readingRequests++
        else if (request.stage === 'compress-navigation') totals.compressionRequests++
        else if (request.stage === 'checking') totals.checkingRequests++
        else if (request.stage === 'writing') totals.writingRequests++
      }
    }
    if (checkpoint?.navigation) for (const [index, node] of checkpoint.navigation.nodes.entries()) {
      const nodeSources = unique((node.facts ?? []).flatMap(fact => fact.sourceIds))
      requireTrue(equal(node.sourceIds, nodeSources) && nodeSources.every(id => sources.has(id)), folder.name + '/navigation/' + index, 'Node sources differ from retained facts')
      if (node.children.length) {
        const childrenSources = unique(node.children.flatMap(child => navigationFacts(checkpoint.navigation, child)?.flatMap(fact => fact.sourceIds) ?? []))
        requireTrue(equal([...nodeSources].sort(), childrenSources.sort()), folder.name + '/navigation/' + index, 'Accepted parent loses or adds child source IDs')
      }
    }
    let citationCount = 0
    if (report) for (const citation of report.citations ?? []) for (const fragment of citation.fragments ?? []) for (const ref of fragment.sources ?? []) {
      citationCount++
      requireTrue(sources.get(ref.messageId)?.revision === ref.revision, folder.name, 'Final citation source or revision differs')
    }
    totals.dispatched += dispatched.size
    totals.settled += settled.size
    totals.inputTokens += chargedInput
    totals.outputTokens += chargedOutput
    const phase = { phase: folder.name, variant: input.variant, state: result?.state ?? 'in-progress', error: result?.error,
      actualRequests: dispatched.size, settledCalls: settled.size, inputTokens: chargedInput, outputTokens: chargedOutput,
      elapsedMs: result?.elapsedMs, reportPresent: !!report, citationReferencesChecked: citationCount,
      checkpoint: checkpoint && { callsReserved: checkpoint.callsReserved, coveredCount: checkpoint.coveredMessageIds.length,
        readingBatches: checkpoint.readLayouts.length, facts: checkpoint.observations.length, unknowns: checkpoint.openThreads.length,
        checks: checkpoint.checks, navigationRootIds: checkpoint.navigation?.roots, navigationNodeCount: checkpoint.navigation?.nodes.length },
      timeline, rawCheckpoint: checkpoint, writingBase: json(path.join(directory, 'writing-base.json'), true) }
    phases.push(phase)
    casePhases.push(phase)
  }
  const adaptive = casePhases.find(phase => phase.variant === 'adaptive')
  const direct = casePhases.find(phase => phase.variant === 'direct')
  const adaptiveWrite = adaptive?.timeline.find(step => step.stage === 'writing' && step.dispatched)
  const directWrite = direct?.timeline.find(step => step.stage === 'writing' && step.dispatched)
  const base = payload => ({ timezone: payload.timezone, observations: payload.observations, openThreads: payload.openThreads })
  const frozen = casePhases.filter(phase => phase.variant === 'reading').at(-1)?.rawCheckpoint
  const deepest = casePhases.map(phase => phase.rawCheckpoint).filter(checkpoint => checkpoint?.navigation)
    .sort((a, b) => b.navigation.nodes.length - a.navigation.nodes.length)[0]
  if (deepest) {
    const matchedNodes = new Set(casePhases.flatMap(phase => phase.timeline).map(step => step.compression?.acceptedNode).filter(id => id !== null && id !== undefined))
    for (const [id, node] of deepest.navigation.nodes.entries()) if (node.children.length) {
      requireTrue(matchedNodes.has(id), caseName + '/navigation/' + id, 'Accepted compression node lacks an exactly matching saved response')
    }
  }
  const pair = { caseName, sourceHash: expected[caseName], completePair: !!adaptive?.reportPresent && !!direct?.reportPresent,
    naturalCandidates: frozen?.checks.length ?? null, naturalAcceptedUpdates: casePhases.flatMap(phase => phase.timeline).flatMap(step => step.candidateUpdates).filter(update => update?.accepted).length,
    checkingRequestsWithOriginals: adaptive?.timeline.filter(step => step.dispatched && step.stage === 'checking' && (step.evidenceIds?.length || step.earlierEvidenceIds?.length)).length ?? 0,
    modelReadRequests: adaptive?.timeline.filter(step => step.dispatched && step.stage === 'checking' && step.action === 'read').length ?? 0,
    modelNavigationRequests: adaptive?.timeline.filter(step => step.dispatched && step.stage === 'checking' && step.action === 'navigate').length ?? 0 }
  if (adaptiveWrite && directWrite) {
    pair.identicalBase = equal(base(adaptiveWrite.payload), base(directWrite.payload))
    pair.identicalFullWritingInputs = ['model', 'systemPrompt', 'prompt', 'outputLimit'].every(key => adaptiveWrite.request[key] === directWrite.request[key])
    pair.sameWriterAndOutputLimit = ['model', 'systemPrompt', 'outputLimit'].every(key => adaptiveWrite.request[key] === directWrite.request[key])
    requireTrue(pair.identicalBase && pair.sameWriterAndOutputLimit, caseName, 'Paired writer or shared notes differ')
    requireTrue(adaptive.writingBase?.sharedBaseHash === digest(base(adaptiveWrite.payload))
      && direct.writingBase?.sharedBaseHash === adaptive.writingBase.sharedBaseHash, caseName, 'Writing base hashes differ')
    if (frozen) {
      requireTrue(adaptive.writingBase?.readingCheckpointHash === digest(frozen) && direct.writingBase?.readingCheckpointHash === digest(frozen), caseName, 'Frozen reading checkpoint differs')
      const checks = frozen.checks.map(({ id, state, finding, observation }) => ({ id, state, finding, ...(finding ? {} : { observation }) }))
      requireTrue(equal(directWrite.payload.checks, checks), caseName, 'Direct arm does not use frozen reading candidates')
    }
  }
  comparisons.push(pair)
}
requireTrue(totals.dispatched <= 104, 'trial', 'Actual dispatches exceed fixed global limit')
if (final) {
  requireTrue(!fs.existsSync(path.join(root, '.active-comparison')), 'trial', 'Trial still active')
  for (const item of pending) issues.push({ where: item, message: 'Unsettled artifact in final audit' })
}
const audit = { mode: final ? 'final' : 'partial', status: issues.length ? 'issues-found' : 'passed-available-artifacts', totals, comparisons,
  pending: unique(pending), issues, reportCitationAudit: phases.some(phase => phase.reportPresent) ? 'IDs and revisions only; semantic review separate' : 'not-applicable-no-report',
  limitations: ['Partial artifacts are not scored as final results.', 'Coverage and inherited source IDs do not establish semantic preservation or citation relevance.'],
  phases: phases.map(({ rawCheckpoint, timeline, ...phase }) => ({ ...phase, timeline: timeline.map(({ request, payload, ...step }) => step) })) }
console.log(JSON.stringify(full ? audit : { mode: audit.mode, status: audit.status, totals, comparisons, pending: audit.pending, issues,
  phases: audit.phases.map(({ phase, state, actualRequests, inputTokens, outputTokens, reportPresent, checkpoint, timeline }) => ({ phase, state, actualRequests, inputTokens, outputTokens, reportPresent,
    checkpoint: checkpoint && { callsReserved: checkpoint.callsReserved, coveredCount: checkpoint.coveredCount, readingBatches: checkpoint.readingBatches, candidateStates: checkpoint.checks.map(({ id, state, rounds }) => ({ id, state, rounds })) },
    compressions: timeline.filter(step => step.compression).map(({ file, compression }) => ({ file, inputEntries: compression.inputEntries, outputEntries: compression.outputEntries,
      responseState: compression.responseState, textPolicy: compression.textPolicy, outputTextLength: compression.outputTextLength,
      maxFactTextLength: compression.maxFactTextLength, targetFactTextLength: compression.targetFactTextLength, acceptedNode: compression.acceptedNode,
      inputFactBytes: compression.inputFactBytes, outputFactBytes: compression.outputFactBytes, serializedReduction: compression.serializedReduction,
      meetsTwentyPercentReduction: compression.meetsTwentyPercentReduction, fitExceptionNeedsIndependentReview: compression.fitExceptionNeedsIndependentReview,
      omittedIds: compression.omittedIds, foreignIds: compression.foreignIds })) })) }, null, 2))
if (issues.length) process.exitCode = 1
