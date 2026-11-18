/**
 * Credential storage module
 */

export {
  type Credential,
  type CredentialStore,
  type CredentialStoreOptions,
  KeychainStore,
  EncryptedFileStore,
  MemoryStore,
  createCredentialStore,
  validatePasswordStrength
} from './store.js';

export {
  CachingStore,
  wrapWithCache
} from './caching-store.js';

export {
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
  findLinkProblems
} from './links.js';

export {
  LinkedStore,
  createCredentialLinker,
  type CredentialLinker,
  type LinkPlan,
  type LinkOutcome
} from './linked-store.js';

export {
  type OnePasswordStoreOptions,
  OnePasswordStore,
  createOnePasswordStore,
  isItemNotFoundError,
  writeTemplateAndRun
} from './backends/onepassword.js';

export {
  type VaultStoreOptions,
  VaultStore,
  createVaultStore
} from './backends/vault.js';

export {
  type KeePassXCStoreOptions,
  KeePassXCStore,
  createKeePassXCStore
} from './backends/keepassxc.js';

export {
  type SystemdCredsStoreOptions,
  SystemdCredsStore,
  createSystemdCredsStore,
  isSystemdCredsAvailable
} from './backends/systemd-creds.js';
