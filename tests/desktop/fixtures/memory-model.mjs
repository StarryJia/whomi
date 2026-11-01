// 本机模型夹具只供应明确的合成结果，正式生成不引用它。
export function memoryModelReply(messages, { title = '约好通话', text = '你们约好了通话的时间。', relationship = '你们似乎都愿意留时间给对方。' } = {}) {
  const system = JSON.stringify(messages[0].content)
  const last = messages.at(-1).content
  const prompt = Array.isArray(last) ? last.map(part => part.text ?? '').join('') : last
  if (system.includes('提取共同事件')) {
    const { messages: source } = JSON.parse(prompt)
    return JSON.stringify({ events: [{ key: title, text, evidenceMessageIds: source.flatMap(message => message.sourceIds ?? [message.id]), signals: [] }] })
  }
  if (system.includes('压缩共同事件')) {
    const { events } = JSON.parse(prompt)
    return JSON.stringify({ groups: events.map(event => [event.key]), events: events.map(event => ({ key: event.key, text })) })
  }
  if (system.includes('归并同一次经历')) {
    const { events } = JSON.parse(prompt)
    return JSON.stringify({ events: [{ key: title, text, evidenceMessageIds: [...new Set(events.flatMap(event => event.evidenceMessageIds))], signals: [] }] })
  }
  if (system.includes('撰写《我们的记忆》')) {
    const { events } = JSON.parse(prompt)
    return JSON.stringify({ ...(system.includes('groups') ? { groups: events.map(event => [event.key]) } : { dimensions: { EI: null, SN: null, TF: null, JP: null } }),
      ...(system.includes('dimensionExplanations') ? { dimensionExplanations: { EI: null, SN: null, TF: null, JP: null } } : {}),
      events: [{ key: title, title, text }], relationship })
  }
}
