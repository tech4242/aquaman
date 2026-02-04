/**
 * @aquaman/aquaman - Zero-trust credential isolation plugin for OpenClaw
 *
 * This package provides an OpenClaw plugin that enables:
 * - Secure credential storage using enterprise backends (Keychain, 1Password, Vault)
 * - Two operation modes:
 *   - Embedded: Direct vault access (simpler, credentials in Gateway memory)
 *   - Proxy: Separate process (stronger isolation, credentials never in Gateway)
 * - Hash-chained tamper-evident audit logs
 * - Slash commands for credential management
 *
 * Installation:
 *   npm install @aquaman/aquaman
 *
 * Configuration in openclaw.json:
 *   {
 *     "plugins": {
 *       "@aquaman/aquaman": {
 *         "mode": "embedded",
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
  PluginMode,
  CredentialBackend,
  ProxiedServices,
  type PluginConfig,
  defaultConfig,
  mergeConfig
} from './config-schema.js';

// Embedded Mode
export {
  type EmbeddedModeOptions,
  EmbeddedMode,
  createEmbeddedMode
} from './embedded.js';

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
  modeCommand,
  executeCommand
} from './commands.js';

// Default export for OpenClaw plugin loading
export { default } from './plugin.js';
