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
  CachingStore,
  wrapWithCache,
  type LinkScheme,
  type ParsedLocator,
  type LocatorResult,
  type LinkProblem,
  LOCATOR_MAX_LENGTH,
  LINK_SCHEME_BY_BACKEND,
  parseLocator,
  parseLocatorFor,
  parseLinkName,
  loadCredentialLinks,
  createLinkSource,
  writeCredentialLink,
  findLinkProblems,
  LinkedStore,
  createCredentialLinker,
  type CredentialLinker,
  type LinkPlan,
  type LinkOutcome,
  type OnePasswordStoreOptions,
  OnePasswordStore,
  createOnePasswordStore,
  isItemNotFoundError,
  writeTemplateAndRun,
  type VaultStoreOptions,
  VaultStore,
  createVaultStore,
  type KeePassXCStoreOptions,
  KeePassXCStore,
  createKeePassXCStore,
  type SystemdCredsStoreOptions,
  SystemdCredsStore,
  createSystemdCredsStore,
  isSystemdCredsAvailable
} from './credentials/index.js';

// Audit
export {
  type AuditLoggerOptions,
  type ChainVerification,
  AuditLogger,
  createAuditLogger,
  redactSensitiveParams
} from './audit/index.js';

// Secret-pattern redactor (v0.12.0+)
export {
  type SecretPattern,
  BUILTIN_PATTERNS,
  redact,
  redactDeep,
  containsSecret,
  buildValuePatterns,
  createStreamRedactor,
  type StreamRedactor,
} from './redactor/index.js';

// Utils
export {
  computeHash,
  computeChainedHash,
  generateId,
  encryptWithPassword,
  decryptWithPassword,
  getConfigDir,
  getConfigPath,
  expandPath,
  getDefaultConfig,
  loadConfig,
  loadStoredConfig,
  ensureConfigDir,
  saveConfig,
  applyEnvOverrides,
  generateLoopbackToken,
  isAquamanPlaceholder,
  LOOPBACK_TOKEN_PREFIX,
  DEFAULT_LOOPBACK_PORT,
  DEFAULT_CACHE_TTL_SECONDS,
  CACHED_BY_DEFAULT_BACKENDS,
  resolveCacheTtl
} from './utils/index.js';
