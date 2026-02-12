/**
 * aquaman-plugin - Credential isolation plugin for OpenClaw
 *
 * This package provides an OpenClaw plugin that enables:
 * - Secure credential storage using enterprise backends (Keychain, 1Password, Vault)
 * - Proxy mode: Separate process, credentials never in Gateway memory
 * - Hash-chained tamper-evident audit logs
 * - Slash commands for credential management
 *
 * Installation:
 *   npm install aquaman-plugin
 *
 * Configuration in openclaw.json:
 *   {
 *     "plugins": {
 *       "aquaman-plugin": {
 *         "backend": "keychain",
 *         "services": ["anthropic", "openai"]
 *       }
 *     }
 *   }
 */

// Plugin
export {
  type AquamanPluginOptions,
  AquamanPlugin,
  createAquamanPlugin
} from './plugin.js';

// Config Schema
export {
  ConfigSchema,
  CredentialBackend,
  ProxiedServices,
  type PluginConfig,
  defaultConfig,
  mergeConfig
} from './config-schema.js';

// Proxy Manager
export {
  type ProxyConnectionInfo,
  type ProxyManagerOptions,
  ProxyManager,
  createProxyManager
} from './proxy-manager.js';

// Commands
export {
  type CommandContext,
  type CommandResult,
  statusCommand,
  addCommand,
  listCommand,
  logsCommand,
  verifyCommand,
  executeCommand
} from './commands.js';

// Default export for OpenClaw plugin loading
export { default } from './plugin.js';
