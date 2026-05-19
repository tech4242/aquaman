/**
 * aquaman-coder
 *
 * Vault adapter for AI coding agents (Claude Code, Codex, OpenCode, Cursor).
 *
 * This package is the user-facing layer for the v0.12.0 coding-agent pivot.
 * It depends on `aquaman-proxy` (the canonical core daemon) for vault access
 * via the `/broker/resolve` UDS endpoint, and ships per-agent hook adapters
 * + setup commands.
 *
 * See docs/PACKAGES.md for the package boundary policy.
 */

export const VERSION = '0.12.0';

export {
  type ProjectConfig,
  type ProjectsFile,
  defaultProjectsPath,
  loadProjects,
  saveProjects,
  findProjectForCwd,
  parseRef,
} from './projects.js';

export {
  type BrokerResolveOptions,
  type BrokerResolveResult,
  type BrokerClientOptions,
  BrokerClient,
  defaultSocketPath,
} from './broker-client.js';

export {
  type HookEvent,
  type HookDecision,
  type HookContext,
  handlePreToolUse,
  handlePostToolUse,
  runHookFromStdin,
} from './adapters/claude-code/hook.js';

export {
  type ClaudeSettings,
  type SetupOptions,
  type SetupResult,
  defaultSettingsPath,
  installClaudeCodeHooks,
  uninstallClaudeCodeHooks,
} from './adapters/claude-code/setup.js';
