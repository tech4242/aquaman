/**
 * Utility functions for aquaman
 */

export {
  computeHash,
  computeChainedHash,
  generateId,
  encryptWithPassword,
  decryptWithPassword,
} from './hash.js';

export {
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
} from './config.js';
