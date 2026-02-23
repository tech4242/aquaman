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
  type OnePasswordStoreOptions,
  OnePasswordStore,
  createOnePasswordStore
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
