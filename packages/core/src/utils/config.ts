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
      proxyPort: 8081,
      proxiedServices: ['anthropic', 'openai', 'slack', 'discord', 'github'],
      tls: {
        enabled: true,
        autoGenerate: true,
        certPath: path.join(getConfigDir(), 'certs', 'proxy.crt'),
        keyPath: path.join(getConfigDir(), 'certs', 'proxy.key')
      },
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

  if (env['AQUAMAN_PORT']) {
    const port = parseInt(env['AQUAMAN_PORT'], 10);
    if (!isNaN(port)) config.credentials.proxyPort = port;
  }

  if (env['AQUAMAN_BACKEND']) {
    const b = env['AQUAMAN_BACKEND'] as WrapperConfig['credentials']['backend'];
    if (['keychain', '1password', 'vault', 'encrypted-file'].includes(b)) {
      config.credentials.backend = b;
    }
  }

  if (env['AQUAMAN_SERVICES']) {
    config.credentials.proxiedServices = env['AQUAMAN_SERVICES'].split(',').map(s => s.trim()).filter(Boolean);
  }

  if (env['AQUAMAN_BIND_ADDRESS']) {
    config.credentials.bindAddress = env['AQUAMAN_BIND_ADDRESS'];
  }

  if (env['AQUAMAN_ENCRYPTION_PASSWORD']) {
    config.credentials.encryptionPassword = env['AQUAMAN_ENCRYPTION_PASSWORD'];
  }

  if (env['AQUAMAN_TLS_ENABLED']) {
    if (!config.credentials.tls) {
      config.credentials.tls = { enabled: false };
    }
    config.credentials.tls.enabled = env['AQUAMAN_TLS_ENABLED'] === 'true';
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
  // Merge TLS config, ensuring enabled has a value
  const baseTls = base.credentials.tls;
  const overrideTls = override.credentials?.tls;
  const mergedTls = baseTls || overrideTls ? {
    enabled: overrideTls?.enabled ?? baseTls?.enabled ?? true,
    certPath: overrideTls?.certPath ?? baseTls?.certPath,
    keyPath: overrideTls?.keyPath ?? baseTls?.keyPath,
    autoGenerate: overrideTls?.autoGenerate ?? baseTls?.autoGenerate
  } : undefined;

  return {
    credentials: {
      ...base.credentials,
      ...override.credentials,
      tls: mergedTls
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
    fs.mkdirSync(configDir, { recursive: true });
  }
}

export function saveConfig(config: WrapperConfig): void {
  ensureConfigDir();
  const configPath = getConfigPath();
  fs.writeFileSync(configPath, stringifyYaml(config), 'utf-8');
}
