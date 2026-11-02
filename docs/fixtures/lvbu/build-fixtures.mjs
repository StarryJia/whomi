import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { revision, relationships } from './scenes.mjs';

const root = new URL('./', import.meta.url);
const selfId = 'whomi-fiction-lvbu';
const ids = new Set();
const manifest = { revision, fictional: true, self: '吕布', files: [] };
const transcript = ['# 吕布虚构会话原文', '', '全部为架空测试数据。日期仅用于排列独立事件。作者核对点不写入聊天导入文件。', ''];
await mkdir(new URL('conversations/', root), { recursive: true });
for (const relation of relationships) {
  const peerId = `whomi-fiction-${relation.id}`;
  const messages = [];
  const events = [];
  transcript.push(`## ${relation.name}`, '');
  for (const event of relation.scenes) {
    if (ids.has(event.id)) throw new Error(`事件标识重复：${event.id}`);
    ids.add(event.id);
    const start = Date.parse(`${event.date}T19:30:00+08:00`) / 1000;
    if (!Number.isFinite(start) || !['吕布', relation.name].includes(event.first)) throw new Error(`请检查事件：${event.id}`);
    transcript.push(`### ${event.date} · ${event.title} · ${event.id}`, '');
    const messageIds = [];
    event.lines.forEach((content, index) => {
      if (typeof content !== 'string' || !content.trim()) throw new Error(`消息不能为空：${event.id}`);
      const accountName = index % 2 === 0 ? event.first : event.first === '吕布' ? relation.name : '吕布';
      const platformMessageId = `whomi-${revision}-${event.id}-${String(index + 1).padStart(2, '0')}`;
      messageIds.push(platformMessageId);
      messages.push({ sender: accountName === '吕布' ? selfId : peerId, accountName, timestamp: start + index * 45, type: 0, content, platformMessageId });
      transcript.push(`${accountName}：${content}`, '');
    });
    events.push({ id: event.id, title: event.title, date: event.date, messageIds, authorCheck: event.check });
  }
  const data = {
    chatlab: { version: '0.0.2' },
    meta: { name: relation.name, platform: 'telegram', type: 'private', groupId: `whomi-fiction-lvbu-${relation.id}`, ownerId: selfId },
    members: [{ platformId: selfId, accountName: '吕布' }, { platformId: peerId, accountName: relation.name }],
    messages
  };
  const filename = `conversations/${relation.id}.chatlab.json`;
  const content = `${JSON.stringify(data, null, 2)}\n`;
  await writeFile(new URL(filename, root), content, 'utf8');
  manifest.files.push({ path: filename, sha256: createHash('sha256').update(content).digest('hex'), messages: messages.length, selfMessages: messages.filter(message => message.sender === selfId).length, events });
}
await writeFile(new URL('manifest.json', root), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
await writeFile(new URL('conversations.md', root), `${transcript.join('\n')}\n`, 'utf8');
console.log(`已保存 ${manifest.files.length} 段会话、${ids.size} 个事件、${manifest.files.reduce((sum, file) => sum + file.messages, 0)} 条消息：${fileURLToPath(root)}`);
