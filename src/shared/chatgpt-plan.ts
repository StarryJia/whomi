export const chatgptProviderId = 'cherry:openai-codex'
export const chatgptBaseUrl = 'https://api.openai.com/v1'
export const chatgptUsageUrl = 'https://chatgpt.com/settings/usage'
export type ChatgptStatus = {
  state: 'disconnected' | 'pending' | 'connected'
  email?: string
  accountId?: string
  planPermissionNeeded?: boolean
  userCode?: string
  verificationUrl?: string
}

export const subscriptionProviders = {
  'openai-codex': { name: 'OpenAI Codex', baseUrl: chatgptBaseUrl, protocol: 'openai-responses' },
  'grok-cli': { name: 'Grok CLI', baseUrl: 'https://cli-chat-proxy.grok.com/v1', protocol: 'openai-responses' },
  copilot: { name: 'GitHub Copilot', baseUrl: 'https://api.githubcopilot.com', protocol: 'openai-completions' },
} as const
export type SubscriptionProviderId = keyof typeof subscriptionProviders
export function isSubscriptionId(value: unknown): value is SubscriptionProviderId {
  return typeof value === 'string' && Object.hasOwn(subscriptionProviders, value)
}
export function getSubscriptionId(providerId: unknown): SubscriptionProviderId | undefined {
  const id = typeof providerId === 'string' && providerId.startsWith('cherry:') && providerId.slice('cherry:'.length)
  return isSubscriptionId(id) ? id : undefined
}
