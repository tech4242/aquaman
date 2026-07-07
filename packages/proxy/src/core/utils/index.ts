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
  applyEnvOverrides,
  generateLoopbackToken,
  DEFAULT_LOOPBACK_PORT,
  DEFAULT_CACHE_TTL_SECONDS,
  CACHED_BY_DEFAULT_BACKENDS,
  resolveCacheTtl
} from './config.js';
