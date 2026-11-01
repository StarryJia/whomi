import { describe, expect, it } from 'vitest'
import { reasoningCapabilities } from '../../electron/agent/reasoning-capabilities'

describe('reasoning capabilities', () => {
  it('uses only the exact provider and protocol catalog', async () => {
    const model = { model: 'gpt-5.2', baseUrl: 'https://api.openai.com/v1', protocol: 'openai-responses' as const }
    expect((await reasoningCapabilities(model))?.levels).toContain('high')
    expect(await reasoningCapabilities({ ...model, baseUrl: 'https://example.com/v1' })).toBeUndefined()
    expect(await reasoningCapabilities({ ...model, protocol: 'openai-completions' })).toBeUndefined()
    expect(await reasoningCapabilities({ ...model, model: 'unknown-model' })).toBeUndefined()
  })
})
