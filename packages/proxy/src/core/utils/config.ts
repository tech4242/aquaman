/**
 * Configuration loader and validator for aquaman
 *
 * Focused on credential isolation features:
 * - Credential proxy settings
 * - Enterprise backend configuration
 * - Audit logging configuration
 * - OpenClaw integration settings
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { WrapperConfig } from '../types.js';

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.aquaman');
const CONFIG_FILE = 'config.yaml';

/** Default loopback TCP port for the opt-in Hermes listener. */
export const DEFAULT_LOOPBACK_PORT = 8585;

/** Default TTL for the daemon's in-memory credential cache (v0.13.1+). */
export const DEFAULT_CACHE_TTL_SECONDS = 900;

/**
 * Backends where the cache defaults ON: every read has a per-access cost
 * (1Password: a biometric prompt per `op` spawn in desktop-app mode;
 * Bitwarden: ~1-2s `bw` spawn; Vault: an HTTP round-trip). The remaining
 * backends are already fast (keychain) or cache internally for the daemon
 * lifetime (keepassxc, systemd-creds, encrypted-file), so the default there
 * is OFF — an explicit cacheTtlSeconds still applies to any backend.
 */
export const CACHED_BY_DEFAULT_BACKENDS: ReadonlyArray<WrapperConfig['credentials']['backend']> =
  ['1password', 'bitwarden', 'vault'];

/**
 * Resolve the effective credential-cache TTL (seconds) for daemon contexts.
 * Explicit credentials.cacheTtlSeconds always wins (0 = disabled); otherwise
 * the backend-conditional default above.
 */
export function resolveCacheTtl(config: WrapperConfig): number {
  const explicit = config.credentials.cacheTtlSeconds;
  if (explicit !== undefined && Number.isFinite(explicit) && explicit >= 0) {
    return Math.floor(explicit);
  }
  return CACHED_BY_DEFAULT_BACKENDS.includes(config.credentials.backend)
    ? DEFAULT_CACHE_TTL_SECONDS
    : 0;
}

/**
 * Generate an unguessable token for the loopback listener. Presented by the
 * agent host as the provider api_key; the proxy strips it and injects the real
 * credential. Prefixed so it's recognizable in `~/.hermes/.env` and logs.
 */
export function generateLoopbackToken(): string {
  return 'aqm_lb_' + crypto.randomBytes(24).toString('hex');
}

export function getConfigDir(): string {
  return process.env['AQUAMAN_CONFIG_DIR'] || DEFAULT_CONFIG_DIR;
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), CONFIG_FILE);
}

export function expandPath(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  if (p.includes('${HOME}')) {
    return p.replace('${HOME}', os.homedir());
  }
  return p;
}

export function getDefaultConfig(): WrapperConfig {
  return {
    credentials: {
      backend: 'keychain',
      proxiedServices: ['anthropic', 'openai', 'slack', 'discord', 'github'],
      vaultMountPath: 'secret'
    },
    audit: {
      enabled: true,
      logDir: path.join(getConfigDir(), 'audit')
    },
    services: {
      configPath: path.join(getConfigDir(), 'services.yaml')
    },
    openclaw: {
      autoLaunch: true,
      configMethod: 'env'
    },
    loopback: {
      enabled: false,
      port: DEFAULT_LOOPBACK_PORT,
      host: '127.0.0.1'
    },
    hermes: {
      configMethod: 'dotenv'
    }
  };
}

export function loadConfig(): WrapperConfig {
  const configPath = getConfigPath();
  const defaultConfig = getDefaultConfig();

  let config: WrapperConfig;
  if (!fs.existsSync(configPath)) {
    config = defaultConfig;
  } else {
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      const userConfig = parseYaml(content) as Partial<WrapperConfig>;
      config = mergeConfig(defaultConfig, userConfig);
    } catch (error) {
      console.error(`Warning: Failed to load config from ${configPath}, using defaults`);
      config = defaultConfig;
    }
  }

  return applyEnvOverrides(config);
}

export function applyEnvOverrides(config: WrapperConfig): WrapperConfig {
  const env = process.env;

  if (env['AQUAMAN_BACKEND']) {
    const b = env['AQUAMAN_BACKEND'] as WrapperConfig['credentials']['backend'];
    if (['keychain', '1password', 'vault', 'encrypted-file', 'keepassxc', 'systemd-creds', 'bitwarden'].includes(b)) {
      config.credentials.backend = b;
    }
  }

  if (env['AQUAMAN_SERVICES']) {
    config.credentials.proxiedServices = env['AQUAMAN_SERVICES'].split(',').map(s => s.trim()).filter(Boolean);
  }

  if (env['AQUAMAN_ENCRYPTION_PASSWORD']) {
    config.credentials.encryptionPassword = env['AQUAMAN_ENCRYPTION_PASSWORD'];
  }

  if (env['AQUAMAN_AUDIT_ENABLED']) {
    config.audit.enabled = env['AQUAMAN_AUDIT_ENABLED'] === 'true';
  }

  if (env['VAULT_ADDR']) {
    config.credentials.vaultAddress = env['VAULT_ADDR'];
  }

  if (env['VAULT_TOKEN']) {
    config.credentials.vaultToken = env['VAULT_TOKEN'];
  }

  if (env['VAULT_NAMESPACE']) {
    config.credentials.vaultNamespace = env['VAULT_NAMESPACE'];
  }

  if (env['AQUAMAN_BITWARDEN_FOLDER']) {
    config.credentials.bitwardenFolder = env['AQUAMAN_BITWARDEN_FOLDER'];
  }

  if (env['AQUAMAN_BITWARDEN_ORGANIZATION_ID']) {
    config.credentials.bitwardenOrganizationId = env['AQUAMAN_BITWARDEN_ORGANIZATION_ID'];
  }

  if (env['AQUAMAN_BITWARDEN_COLLECTION_ID']) {
    config.credentials.bitwardenCollectionId = env['AQUAMAN_BITWARDEN_COLLECTION_ID'];
  }

  // Credential-cache TTL override (v0.13.1+). Integer seconds; 0 disables.
  if (env['AQUAMAN_CACHE_TTL']) {
    const t = Number(env['AQUAMAN_CACHE_TTL']);
    if (Number.isInteger(t) && t >= 0) {
      config.credentials.cacheTtlSeconds = t;
    }
  }

  // Loopback listener overrides (opt-in Hermes path). Useful for CI /
  // non-interactive setup where the token is injected from the environment.
  if (env['AQUAMAN_LOOPBACK_ENABLED']) {
    config.loopback = config.loopback ?? { enabled: false, port: DEFAULT_LOOPBACK_PORT, host: '127.0.0.1' };
    config.loopback.enabled = env['AQUAMAN_LOOPBACK_ENABLED'] === 'true';
  }
  if (env['AQUAMAN_LOOPBACK_PORT']) {
    const p = Number(env['AQUAMAN_LOOPBACK_PORT']);
    if (Number.isInteger(p) && p > 0 && p < 65536) {
      config.loopback = config.loopback ?? { enabled: false, port: DEFAULT_LOOPBACK_PORT, host: '127.0.0.1' };
      config.loopback.port = p;
    }
  }
  if (env['AQUAMAN_LOOPBACK_TOKEN']) {
    config.loopback = config.loopback ?? { enabled: false, port: DEFAULT_LOOPBACK_PORT, host: '127.0.0.1' };
    config.loopback.token = env['AQUAMAN_LOOPBACK_TOKEN'];
  }

  return config;
}

function mergeConfig(
  base: WrapperConfig,
  override: Partial<WrapperConfig>
): WrapperConfig {
  // Deprecation: ignore encryptionPassword from YAML config (env-var only)
  if (override.credentials && 'encryptionPassword' in override.credentials) {
    console.warn('Warning: credentials.encryptionPassword in config.yaml is deprecated and ignored. Use AQUAMAN_ENCRYPTION_PASSWORD env var instead.');
    const { encryptionPassword: _, ...restCreds } = override.credentials;
    override = { ...override, credentials: restCreds };
  }

  return {
    credentials: {
      ...base.credentials,
      ...override.credentials,
    },
    audit: {
      ...base.audit,
      ...override.audit
    },
    services: {
      ...base.services,
      ...override.services
    },
    openclaw: {
      ...base.openclaw,
      ...override.openclaw
    },
    loopback: override.loopback !== undefined
      ? { ...base.loopback, ...override.loopback } as WrapperConfig['loopback']
      : base.loopback,
    hermes: override.hermes !== undefined
      ? { ...base.hermes, ...override.hermes } as WrapperConfig['hermes']
      : base.hermes,
    policy: override.policy !== undefined ? { ...base.policy, ...override.policy } : base.policy
  };
}

export function ensureConfigDir(): void {
  const configDir = getConfigDir();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
}

export function saveConfig(config: WrapperConfig): void {
  ensureConfigDir();
  const configPath = getConfigPath();
  // Never persist the encryption password: it is env-only (AQUAMAN_ENCRYPTION_PASSWORD)
  // and loadConfig() injects it into the in-memory config via applyEnvOverrides().
  // Without this guard, any saveConfig(loadConfig()) round-trip (e.g. a setup
  // command) would leak the password into config.yaml in plaintext.
  const { encryptionPassword: _omit, ...credsToPersist } = config.credentials;
  const sanitized: WrapperConfig = { ...config, credentials: credsToPersist };
  fs.writeFileSync(configPath, stringifyYaml(sanitized), { encoding: 'utf-8', mode: 0o600 });
}
