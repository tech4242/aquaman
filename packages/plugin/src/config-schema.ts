/**
 * TypeBox configuration schema for the OpenClaw plugin
 *
 * Defines the structure of plugin configuration in openclaw.json
 */

import { Type, type Static } from '@sinclair/typebox';

/**
 * Credential backend type
 */
export const CredentialBackend = Type.Union([
  Type.Literal('keychain'),
  Type.Literal('1password'),
  Type.Literal('vault'),
  Type.Literal('encrypted-file'),
  Type.Literal('keepassxc')
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
  // Credential backend
  backend: Type.Optional(CredentialBackend),

  // Services to proxy
  services: Type.Optional(ProxiedServices),

  // 1Password options
  onePasswordVault: Type.Optional(Type.String()),
  onePasswordAccount: Type.Optional(Type.String()),

  // HashiCorp Vault options
  vaultAddress: Type.Optional(Type.String({ format: 'uri' })),
  vaultToken: Type.Optional(Type.String()),
  vaultNamespace: Type.Optional(Type.String()),
  vaultMountPath: Type.Optional(Type.String({ default: 'secret' })),
});

export type PluginConfig = Static<typeof ConfigSchema>;

/**
 * Default configuration values
 */
export const defaultConfig: PluginConfig = {
  backend: 'keychain',
  services: ['anthropic', 'openai'],
  vaultMountPath: 'secret',
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
