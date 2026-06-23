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

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Single source of truth for the version: read package.json at load. Resolves
// relative to this module (works in dev via tsx from src/ and built from dist/,
// both one level under the package root). Mirrors aquaman-proxy's daemon.ts.
const __pkgDir = path.dirname(fileURLToPath(import.meta.url));
const pkgJson = JSON.parse(fs.readFileSync(path.resolve(__pkgDir, '../package.json'), 'utf-8'));
export const VERSION: string = pkgJson.version;

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
