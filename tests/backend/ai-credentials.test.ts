import { expect, test } from 'vitest'
import { createCredentialVault } from '../../electron/main/ai-credentials'

test('unavailable system encryption refuses credentials instead of writing plain text', () => {
  const vault = createCredentialVault({ isEncryptionAvailable: () => false, encryptString: () => Buffer.from('plain'), decryptString: () => 'secret' })
  expect(() => vault.encrypt('secret')).toThrow('系统加密')
  expect(() => vault.decrypt('c2VjcmV0')).toThrow()
})
test('credential vault stores an encoded encrypted value and refuses malformed ciphertext', () => {
  const vault = createCredentialVault({ isEncryptionAvailable: () => true, encryptString: value => Buffer.from(`encrypted:${value}`), decryptString: value => { const text = value.toString(); if (!text.startsWith('encrypted:')) throw new Error('bad'); return text.slice(10) } })
  const stored = vault.encrypt('secret')
  expect(stored).not.toBe('secret')
  expect(vault.decrypt(stored)).toBe('secret')
  expect(() => vault.decrypt('bad!')).toThrow()
})
