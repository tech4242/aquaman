/**
 * Utility functions for aquaman
 */

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
  type SelfSignedCert
} from './hash.js';

export {
  getConfigDir,
  getConfigPath,
  expandPath,
  getDefaultConfig,
  loadConfig,
  ensureConfigDir,
  saveConfig,
  applyEnvOverrides
} from './config.js';
