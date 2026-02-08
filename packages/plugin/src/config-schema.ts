/**
 * TypeBox configuration schema for the OpenClaw plugin
 *
 * Defines the structure of plugin configuration in openclaw.json
 */

import { Type, type Static } from '@sinclair/typebox';

/**
 * Plugin operation mode
 * - embedded: Direct vault access within OpenClaw process (simpler, less isolation)
 * - proxy: Separate proxy process (stronger isolation, credentials never in Gateway)
 */
export const PluginMode = Type.Union([
  Type.Literal('embedded'),
  Type.Literal('proxy')
], { default: 'embedded' });

/**
 * Credential backend type
 */
export const CredentialBackend = Type.Union([
  Type.Literal('keychain'),
  Type.Literal('1password'),
  Type.Literal('vault'),
  Type.Literal('encrypted-file')
], { default: 'keychain' });

/**
 * Services to proxy
 */
export const ProxiedServices = Type.Array(Type.String(), {
  default: ['anthropic', 'openai']
});

/**
 * Complete plugin configuration schema
 */
export const ConfigSchema = Type.Object({
  // Mode selection
  mode: Type.Optional(PluginMode),

  // Credential backend
  backend: Type.Optional(CredentialBackend),

  // Services to proxy
  services: Type.Optional(ProxiedServices),

  // Proxy mode options
  proxyPort: Type.Optional(Type.Number({ default: 8081, minimum: 1024, maximum: 65535 })),
  proxyAutoStart: Type.Optional(Type.Boolean({ default: true })),

  // 1Password options
  onePasswordVault: Type.Optional(Type.String()),
  onePasswordAccount: Type.Optional(Type.String()),

  // HashiCorp Vault options
  vaultAddress: Type.Optional(Type.String({ format: 'uri' })),
  vaultToken: Type.Optional(Type.String()),
  vaultNamespace: Type.Optional(Type.String()),
  vaultMountPath: Type.Optional(Type.String({ default: 'secret' })),

  // TLS options
  tlsEnabled: Type.Optional(Type.Boolean({ default: true })),
  tlsCertPath: Type.Optional(Type.String()),
  tlsKeyPath: Type.Optional(Type.String()),

  // Audit options
  auditEnabled: Type.Optional(Type.Boolean({ default: true })),
  auditLogDir: Type.Optional(Type.String())
});

export type PluginConfig = Static<typeof ConfigSchema>;

/**
 * Default configuration values
 */
export const defaultConfig: PluginConfig = {
  mode: 'embedded',
  backend: 'keychain',
  services: ['anthropic', 'openai'],
  proxyPort: 8081,
  proxyAutoStart: true,
  vaultMountPath: 'secret',
  tlsEnabled: true,
  auditEnabled: true
};

/**
 * Merge user config with defaults
 */
export function mergeConfig(userConfig: Partial<PluginConfig>): PluginConfig {
  return {
    ...defaultConfig,
    ...userConfig,
    services: userConfig.services || defaultConfig.services
  };
}
