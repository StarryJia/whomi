export function wechatTypeNumber(value: unknown): number | undefined {
  const numeric = typeof value === 'bigint' || (typeof value === 'string' && /^\d+$/.test(value)) ? Number(value) : value
  return typeof numeric === 'number' && Number.isSafeInteger(numeric) && numeric > 0 ? numeric : undefined
}

export function hasWechatRecallMarker(label: unknown, localType: unknown, content: unknown): boolean {
  if (label === '撤回消息' || label === '消息撤回') return true
  const type = wechatTypeNumber(localType)
  if ((type !== 10000 && type !== 10002) || typeof content !== 'string') return false
  // 标签与数字类型冲突时，需同时符合微信撤回提示的完整格式。
  return /^(?:\[撤回了一条消息\]|(?:你|对方|“[^”\r\n]+”|"[^"\r\n]+")\s*撤回了一条消息)$/.test(content.trim())
}
