import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('./', import.meta.url);
const sourcePath = 'docs/designs/whomi-hongloumeng-demo-dialogues.md';
const sourceUrl = new URL('../../designs/whomi-hongloumeng-demo-dialogues.md', root);
const revision = 'hongloumeng-v1';
const selfId = 'whomi-fiction-hongloumeng-jiabaoyu';
const intervalSeconds = 45;
const checkOnly = process.argv.includes('--check');
assert(process.argv.slice(2).every(arg => arg === '--check'), '请使用 node build-fixtures.mjs 或追加 --check。');

const relationships = [
  { heading: '宝玉与黛玉', speaker: '黛玉', name: '林黛玉', id: 'lindaiyu', prefix: '黛', stablePrefix: 'dai', segments: 9, messages: 195 },
  { heading: '宝玉与宝钗', speaker: '宝钗', name: '薛宝钗', id: 'xuebaochai', prefix: '钗', stablePrefix: 'chai', segments: 8, messages: 155 },
  { heading: '宝玉与袭人', speaker: '袭人', name: '袭人', id: 'xiren', prefix: '袭', stablePrefix: 'xi', segments: 10, messages: 210 },
];

// 同次言谈保持同日；正文明确隔日的往返保留间隔。
const schedule = {
  '袭01': '2026-01-01T10:00:00+08:00',
  '袭02': '2026-01-01T20:00:00+08:00',
  '袭03': '2026-01-01T20:30:00+08:00',
  '袭04': '2026-01-01T21:00:00+08:00',
  '钗01': '2026-01-10T13:00:00+08:00',
  '钗02': '2026-01-12T10:00:00+08:00',
  '黛01': '2026-01-20T14:00:00+08:00',
  '黛02': '2026-01-20T14:30:00+08:00',
  '黛03': '2026-01-22T16:00:00+08:00',
  '袭05': '2026-02-01T18:00:00+08:00',
  '黛04': '2026-02-02T10:00:00+08:00',
  '钗03': '2026-02-02T11:30:00+08:00',
  '黛05': '2026-02-02T13:00:00+08:00',
  '钗04': '2026-02-05T10:00:00+08:00',
  '钗05': '2026-02-06T10:00:00+08:00',
  '黛06': '2026-02-08T14:00:00+08:00',
  '袭06': '2026-02-08T14:30:00+08:00',
  '袭07': '2026-02-10T14:00:00+08:00',
  '钗06': '2026-02-10T14:30:00+08:00',
  '黛07': '2026-02-10T15:00:00+08:00',
  '袭08': '2026-02-10T19:00:00+08:00',
  '黛08': '2026-02-10T19:30:00+08:00',
  '钗07': '2026-02-11T10:00:00+08:00',
  '钗08': '2026-02-11T11:00:00+08:00',
  '袭09': '2026-02-11T12:00:00+08:00',
  '黛09': '2026-02-11T15:00:00+08:00',
  '袭10': '2026-02-11T21:00:00+08:00',
};

const sha256 = value => createHash('sha256').update(value).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const sourceBytes = await readFile(sourceUrl);
const sourceLines = sourceBytes.toString('utf8').split(/\r?\n/);
const parsed = new Map(relationships.map(relation => [relation.id, []]));
let relation;
let segment;

for (let index = 0; index < sourceLines.length; index++) {
  const line = sourceLines[index];
  const sourceLine = index + 1;
  if (!line.trim()) continue;
  const heading = /^## (.+)$/.exec(line);
  if (heading) {
    relation = relationships.find(candidate => candidate.heading === heading[1]);
    assert(relation, `请检查第 ${sourceLine} 行的会话标题。`);
    segment = undefined;
    continue;
  }
  if (!relation) continue;
  const scene = /^### ([黛钗袭]\d{2}) · (.+)$/.exec(line);
  if (scene) {
    assert(scene[1].startsWith(relation.prefix), `请检查第 ${sourceLine} 行的片段归属。`);
    segment = { sourceId: scene[1], title: scene[2], headingLine: sourceLine, lines: [] };
    parsed.get(relation.id).push(segment);
    continue;
  }
  assert(segment, `请检查第 ${sourceLine} 行的片段标题。`);
  const context = /^总顺序 (\d{2})。/.exec(line);
  if (context) {
    assert(segment.totalOrder === undefined && segment.lines.length === 0, `请检查第 ${sourceLine} 行的总顺序。`);
    segment.totalOrder = Number(context[1]);
    segment.contextLine = sourceLine;
    continue;
  }
  const dialogue = /^(宝玉|黛玉|宝钗|袭人)：(.+)$/.exec(line);
  assert(dialogue && dialogue[2].trim(), `请检查第 ${sourceLine} 行的对白。`);
  assert(['宝玉', relation.speaker].includes(dialogue[1]), `请检查第 ${sourceLine} 行的发言者。`);
  assert(segment.totalOrder !== undefined, `请补充第 ${segment.headingLine} 行片段的总顺序。`);
  segment.lines.push({ sourceLine, speaker: dialogue[1], content: dialogue[2] });
}

const orderedSegments = [...parsed.values()].flat().sort((a, b) => a.totalOrder - b.totalOrder);
assert.equal(orderedSegments.length, 27, '请核对 27 个剧本片段。');
assert.deepEqual(orderedSegments.map(item => item.totalOrder), Array.from({ length: 27 }, (_, index) => index + 1));
assert.deepEqual(new Set(orderedSegments.map(item => item.sourceId)), new Set(Object.keys(schedule)));
for (let index = 0; index < orderedSegments.length; index++) {
  const current = orderedSegments[index];
  assert(current.lines.length > 0, `请补充 ${current.sourceId} 的对白。`);
  current.start = Date.parse(schedule[current.sourceId]) / 1000;
  assert(Number.isSafeInteger(current.start), `请检查 ${current.sourceId} 的排序时间。`);
  if (index > 0) {
    const previous = orderedSegments[index - 1];
    assert(previous.start + (previous.lines.length - 1) * intervalSeconds < current.start, `请调整 ${current.sourceId} 的排序时间。`);
  }
}

const manifest = {
  revision,
  fictional: true,
  format: { name: 'ChatLab JSON', version: '0.0.2' },
  source: { path: sourcePath, sha256: sha256(sourceBytes) },
  self: { name: '贾宝玉', platformId: selfId },
  timeline: {
    fictional: true,
    timezone: 'Asia/Shanghai',
    messageIntervalSeconds: intervalSeconds,
    note: '日期仅用于按剧本总顺序排序，不是原著日期。27 个片段不等于 27 个独立事件；日期和片段数均不能用来统计独立事件。',
  },
  totals: { conversations: 3, segments: 27, messages: 560 },
  files: [],
};
const outputs = new Map();
const messageIds = new Set();
const mappedSourceLines = new Set();

for (const current of relationships) {
  const segments = parsed.get(current.id);
  assert.equal(segments.length, current.segments, `请核对 ${current.name} 的片段数。`);
  const peerId = `whomi-fiction-hongloumeng-${current.id}`;
  const messages = [];
  const segmentMappings = [];
  for (const scene of segments) {
    const mappings = [];
    scene.lines.forEach((line, index) => {
      // 原始片段编号和片段内序号不受 Markdown 空行或虚构日期影响。
      const platformMessageId = `whomi-${revision}-${current.stablePrefix}${scene.sourceId.slice(1)}-${String(index + 1).padStart(3, '0')}`;
      assert(!messageIds.has(platformMessageId), `请检查重复消息编号 ${platformMessageId}。`);
      assert(!mappedSourceLines.has(line.sourceLine), `请检查重复来源行 ${line.sourceLine}。`);
      messageIds.add(platformMessageId);
      mappedSourceLines.add(line.sourceLine);
      const isSelf = line.speaker === '宝玉';
      messages.push({
        sender: isSelf ? selfId : peerId,
        accountName: isSelf ? '贾宝玉' : current.name,
        timestamp: scene.start + index * intervalSeconds,
        type: 0,
        content: line.content,
        platformMessageId,
      });
      mappings.push({ platformMessageId, messageIndex: messages.length - 1, sourceLine: line.sourceLine, sourceSpeaker: line.speaker });
    });
    segmentMappings.push({
      sourceId: scene.sourceId,
      title: scene.title,
      totalOrder: scene.totalOrder,
      sourceHeadingLine: scene.headingLine,
      sourceContextLine: scene.contextLine,
      fictionalStart: schedule[scene.sourceId],
      messages: mappings,
    });
  }
  assert.equal(messages.length, current.messages, `请核对 ${current.name} 的消息数。`);
  assert(messages.every((message, index) => index === 0 || messages[index - 1].timestamp < message.timestamp));
  const data = {
    chatlab: { version: '0.0.2' },
    meta: { name: current.name, platform: 'telegram', type: 'private', groupId: `whomi-fiction-hongloumeng-jiabaoyu-${current.id}`, ownerId: selfId },
    members: [{ platformId: selfId, accountName: '贾宝玉' }, { platformId: peerId, accountName: current.name }],
    messages,
  };
  for (const scene of segmentMappings) {
    for (const mapping of scene.messages) {
      const message = data.messages[mapping.messageIndex];
      assert.equal(`${mapping.sourceSpeaker}：${message.content}`, sourceLines[mapping.sourceLine - 1]);
      assert.equal(message.platformMessageId, mapping.platformMessageId);
      assert.equal(message.sender, mapping.sourceSpeaker === '宝玉' ? selfId : peerId);
    }
  }
  const path = `conversations/${current.id}.chatlab.json`;
  const content = json(data);
  outputs.set(path, content);
  manifest.files.push({
    path,
    sha256: sha256(content),
    peer: { name: current.name, platformId: peerId },
    conversationId: data.meta.groupId,
    messages: messages.length,
    selfMessages: messages.filter(message => message.sender === selfId).length,
    peerMessages: messages.filter(message => message.sender === peerId).length,
    segments: segmentMappings,
  });
}

const dialogueSourceLines = sourceLines.flatMap((line, index) => /^(宝玉|黛玉|宝钗|袭人)：/.test(line) ? [index + 1] : []);
assert.equal(messageIds.size, manifest.totals.messages);
assert.deepEqual([...mappedSourceLines].sort((a, b) => a - b), dialogueSourceLines);
outputs.set('manifest.json', json(manifest));

if (!checkOnly) await mkdir(new URL('conversations/', root), { recursive: true });
for (const [path, content] of outputs) {
  const url = new URL(path, root);
  if (checkOnly) assert.equal(await readFile(url, 'utf8'), content, `请重新生成 ${path}。`);
  else await writeFile(url, content, 'utf8');
}
console.log(`${checkOnly ? '已核对' : '已生成'} 3 段会话、27 个剧本片段、560 条消息：${fileURLToPath(root)}`);
