/**
 * aquaman-core - Core credential storage, audit logging, and utilities
 *
 * This package provides the shared functionality for:
 * - Credential storage backends (Keychain, 1Password, Vault, encrypted file)
 * - Hash-chained tamper-evident audit logs
 * - Cryptographic utilities
 * - Configuration management
 */

// Types
export * from './types.js';

// Credentials
export {
  type Credential,
  type CredentialStore,
  type CredentialStoreOptions,
  KeychainStore,
  EncryptedFileStore,
  MemoryStore,
  createCredentialStore,
  validatePasswordStrength,
  type OnePasswordStoreOptions,
  OnePasswordStore,
  createOnePasswordStore,
  type VaultStoreOptions,
  VaultStore,
  createVaultStore
} from './credentials/index.js';

// Audit
export {
  type AuditLoggerOptions,
  AuditLogger,
  createAuditLogger,
  redactSensitiveParams
} from './audit/index.js';

// Utils
export {
  computeHash,
  computeChainedHash,
  generateId,
  generateNonce,
  generateSigningKeyPair,
  sign,
  verify,
  encryptWithPassword,
  decryptWithPassword,
  generateSelfSignedCert,
  type SigningKeyPair,
  type SelfSignedCert,
  getConfigDir,
  getConfigPath,
  expandPath,
  getDefaultConfig,
  loadConfig,
  ensureConfigDir,
  saveConfig,
  applyEnvOverrides
} from './utils/index.js';
