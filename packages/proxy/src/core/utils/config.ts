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
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { WrapperConfig } from '../types.js';

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.aquaman');
const CONFIG_FILE = 'config.yaml';

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
    if (['keychain', '1password', 'vault', 'encrypted-file', 'keepassxc'].includes(b)) {
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
    }
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
  fs.writeFileSync(configPath, stringifyYaml(config), { encoding: 'utf-8', mode: 0o600 });
}
