export function hasWechatRecallMarker(label: unknown, localType: unknown, content: unknown): boolean {
  if (label === '撤回消息' || label === '消息撤回') return true
  if (!['10000', '10002'].includes(String(localType)) || typeof content !== 'string') return false
  // 标签与数字类型冲突时，需同时符合微信撤回提示的完整格式。
  return /^(?:\[撤回了一条消息\]|(?:你|对方|“[^”\r\n]+”|"[^"\r\n]+")\s*撤回了一条消息)$/.test(content.trim())
}
