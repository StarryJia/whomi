import { BoundaryError } from '../../src/shared/desktop-validation'

type SystemEncryption = { isEncryptionAvailable(): boolean; getSelectedStorageBackend?(): string; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
export function createCredentialVault(api: SystemEncryption) {
  function requireEncryption() { if (!api.isEncryptionAvailable() || api.getSelectedStorageBackend?.() === 'basic_text') throw new BoundaryError('ENCRYPTION_UNAVAILABLE', '系统加密不可用，请启用系统凭据存储后重试。') }
  return {
    encrypt(value: string) { requireEncryption(); return api.encryptString(value).toString('base64') },
    decrypt(value: string) { requireEncryption(); if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new BoundaryError('INVALID_CREDENTIAL', '请重新保存模型密钥。'); try { return api.decryptString(Buffer.from(value, 'base64')) } catch { throw new BoundaryError('INVALID_CREDENTIAL', '请重新保存模型密钥。') } },
  }
}
