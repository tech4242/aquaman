/**
 * Claude Code setup — writes the hook configuration into
 * `~/.claude/settings.json` so Claude Code invokes aquaman-coder on
 * each tool call.
 *
 * On macOS it also allowlists the aquaman proxy socket for Claude Code's
 * sandbox (v0.15.0+). The sandbox denies every Unix-socket connect by default,
 * so a sandboxed `aquaman-coder exec` fails with EPERM before it can reach
 * the broker. `sandbox.network.allowUnixSockets` takes exact socket paths
 * (directories match as a prefix; globs don't work) and Claude Code merges
 * list settings across scopes. We add exactly our socket: never the directory,
 * never `allowAllUnixSockets`, never `sandbox.enabled`. On Linux/WSL2 the
 * list is ignored (seccomp can't filter by path), so setup leaves the sandbox
 * alone and doctor explains the tradeoff.
 *
 * Never overwrites unrelated keys. Atomic write via .tmp + rename.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultSocketPath } from '../../broker-client.js';

export interface ClaudeSettings {
  hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ type: 'command'; command: string }> }>>;
  apiKeyHelper?: string;
  [key: string]: unknown;
}

export function defaultSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

export interface SetupOptions {
  settingsPath?: string;
  hookCommand?: string;
  /** Proxy socket to allowlist for the sandbox. Default: defaultSocketPath(). */
  socketPath?: string;
  /** Override for tests. Default: process.platform. */
  platform?: NodeJS.Platform;
}

export interface SetupResult {
  path: string;
  changed: boolean;
  before: ClaudeSettings | null;
  after: ClaudeSettings;
  /**
   * What happened to the sandbox socket allowance: `added` / `present` on
   * macOS, `removed` / `absent` on uninstall, `unsupported-platform` on
   * Linux/WSL2 (where allowUnixSockets is ignored).
   */
  sandboxSocket: 'added' | 'present' | 'removed' | 'absent' | 'unsupported-platform';
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** realpath that tolerates a missing leaf (the socket only exists while the daemon runs). */
function realpathLoose(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
    } catch {
      return path.resolve(p);
    }
  }
}

/**
 * Does one `allowUnixSockets` entry cover `socketPath`? Mirrors the sandbox's
 * Seatbelt rule `(remote unix-socket (subpath <entry>))`: the entry matches
 * the path itself or anything beneath it, after `~` expansion and symlink
 * resolution (macOS /tmp -> /private/tmp). Globs are not patterns there, so
 * they don't count here either.
 */
export function socketAllowedByEntry(entry: string, socketPath: string): boolean {
  if (typeof entry !== 'string' || entry.length === 0 || /[*?[]/.test(entry)) return false;
  const want = realpathLoose(socketPath);
  const have = realpathLoose(expandHome(entry)).replace(/\/+$/, '');
  return want === have || want.startsWith(have + '/');
}

type SandboxNetwork = { allowUnixSockets?: unknown; allowAllUnixSockets?: unknown; [k: string]: unknown };

function sandboxNetwork(settings: ClaudeSettings): SandboxNetwork | undefined {
  const sandbox = settings.sandbox as { network?: SandboxNetwork } | undefined;
  return sandbox && typeof sandbox === 'object' ? sandbox.network : undefined;
}

export interface SandboxSocketStatus {
  /** Some settings file turns the sandbox on. */
  sandboxEnabled: boolean;
  /** Connects to the socket are permitted on this platform by the merged settings. */
  socketAllowed: boolean;
  /** Which files were read (existing ones only). */
  sources: string[];
}

/**
 * Merge the sandbox bits of several Claude Code settings files the way Claude
 * Code does for these keys (lists concatenate, booleans: any true wins for
 * `enabled` / `allowAllUnixSockets`) and decide whether the proxy socket is
 * reachable from sandboxed commands on `platform`.
 */
export function sandboxSocketStatus(
  settingsFiles: string[],
  socketPath: string = defaultSocketPath(),
  platform: NodeJS.Platform = process.platform,
): SandboxSocketStatus {
  let sandboxEnabled = false;
  let allowAll = false;
  const entries: string[] = [];
  const sources: string[] = [];
  for (const file of settingsFiles) {
    let parsed: ClaudeSettings;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as ClaudeSettings;
    } catch {
      continue;
    }
    sources.push(file);
    const sandbox = parsed.sandbox as { enabled?: unknown } | undefined;
    if (sandbox && typeof sandbox === 'object' && sandbox.enabled === true) sandboxEnabled = true;
    const net = sandboxNetwork(parsed);
    if (net?.allowAllUnixSockets === true) allowAll = true;
    if (Array.isArray(net?.allowUnixSockets)) entries.push(...(net!.allowUnixSockets as string[]));
  }
  const socketAllowed =
    allowAll || (platform === 'darwin' && entries.some((e) => socketAllowedByEntry(e, socketPath)));
  return { sandboxEnabled, socketAllowed, sources };
}

/**
 * Ensure ~/.claude/settings.json has PreToolUse + PostToolUse hooks
 * pointing at `aquaman coder hook` (the canonical unified-CLI form;
 * the `aquaman` binary's `coder` shim execs `aquaman-coder` under the hood).
 */
export function installClaudeCodeHooks(opts: SetupOptions = {}): SetupResult {
  const settingsPath = opts.settingsPath ?? defaultSettingsPath();
  const hookCommand = opts.hookCommand ?? 'aquaman coder hook';

  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  let before: ClaudeSettings | null = null;
  let settings: ClaudeSettings = {};
  if (fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    try {
      before = JSON.parse(raw) as ClaudeSettings;
      settings = JSON.parse(raw) as ClaudeSettings;
    } catch (err) {
      throw new Error(`Existing ${settingsPath} is not valid JSON: ${(err as Error).message}`);
    }
  }

  settings.hooks = settings.hooks ?? {};

  for (const event of ['PreToolUse', 'PostToolUse']) {
    const list = settings.hooks[event] ?? [];
    // Match by substring so wrapper-script variants like
    // "/path/to/wrap aquaman coder hook --debug" still count as installed.
    // Also matches the legacy `aquaman-coder hook` form so v0.11.x installs
    // don't get a duplicate appended on upgrade.
    const alreadyInstalled = list.some((entry) =>
      entry.hooks?.some((h) =>
        h.command?.includes('aquaman coder hook') ||
        h.command?.includes('aquaman-coder hook')
      )
    );
    if (alreadyInstalled) continue;

    list.push({
      matcher: '*',
      hooks: [{ type: 'command', command: hookCommand }],
    });
    settings.hooks[event] = list;
  }

  // Sandbox socket allowance (macOS only; see the header comment).
  const platform = opts.platform ?? process.platform;
  const socketPath = opts.socketPath ?? defaultSocketPath();
  let sandboxSocket: SetupResult['sandboxSocket'] = 'unsupported-platform';
  if (platform === 'darwin') {
    const existing = sandboxNetwork(settings);
    const list = Array.isArray(existing?.allowUnixSockets) ? (existing!.allowUnixSockets as string[]) : [];
    if (existing?.allowAllUnixSockets === true || list.some((e) => socketAllowedByEntry(e, socketPath))) {
      sandboxSocket = 'present';
    } else {
      const sandbox = (settings.sandbox && typeof settings.sandbox === 'object' ? settings.sandbox : {}) as Record<string, unknown>;
      const network = (sandbox.network && typeof sandbox.network === 'object' ? sandbox.network : {}) as Record<string, unknown>;
      network.allowUnixSockets = [...list, socketPath];
      sandbox.network = network;
      settings.sandbox = sandbox;
      sandboxSocket = 'added';
    }
  }

  const after = settings;
  const changed = JSON.stringify(before) !== JSON.stringify(after);

  if (changed) {
    const tmp = settingsPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(after, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, settingsPath);
  }

  return { path: settingsPath, changed, before, after, sandboxSocket };
}

/**
 * Remove aquaman coder hooks from settings.json (matches both legacy
 * `aquaman-coder hook` and canonical `aquaman coder hook` forms).
 */
export function uninstallClaudeCodeHooks(opts: SetupOptions = {}): SetupResult {
  const settingsPath = opts.settingsPath ?? defaultSettingsPath();
  const hookCommand = opts.hookCommand ?? 'aquaman coder hook';

  if (!fs.existsSync(settingsPath)) {
    return { path: settingsPath, changed: false, before: null, after: {}, sandboxSocket: 'absent' };
  }

  const raw = fs.readFileSync(settingsPath, 'utf-8');
  const before = JSON.parse(raw) as ClaudeSettings;
  const settings = JSON.parse(raw) as ClaudeSettings;

  if (settings.hooks) {
    for (const event of Object.keys(settings.hooks)) {
      settings.hooks[event] = settings.hooks[event]
        .map((entry) => ({
          ...entry,
          hooks: entry.hooks.filter((h) =>
            !h.command?.includes(hookCommand) &&
            !h.command?.includes('aquaman coder hook') &&
            !h.command?.includes('aquaman-coder hook')
          ),
        }))
        .filter((entry) => entry.hooks.length > 0);
      if (settings.hooks[event].length === 0) {
        delete settings.hooks[event];
      }
    }
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }
  }

  // Remove only the exact socket entry setup adds; leave user-written entries
  // (directories, other sockets, allowAllUnixSockets) alone. Prune containers
  // only when this removal emptied them.
  const socketPath = opts.socketPath ?? defaultSocketPath();
  let sandboxSocket: SetupResult['sandboxSocket'] = 'absent';
  const net = sandboxNetwork(settings);
  if (Array.isArray(net?.allowUnixSockets) && (net!.allowUnixSockets as string[]).includes(socketPath)) {
    const remaining = (net!.allowUnixSockets as string[]).filter((e) => e !== socketPath);
    const sandbox = settings.sandbox as Record<string, unknown>;
    if (remaining.length > 0) {
      net!.allowUnixSockets = remaining;
    } else {
      delete net!.allowUnixSockets;
      if (Object.keys(net!).length === 0) delete sandbox.network;
      if (Object.keys(sandbox).length === 0) delete settings.sandbox;
    }
    sandboxSocket = 'removed';
  }

  const changed = JSON.stringify(before) !== JSON.stringify(settings);
  if (changed) {
    const tmp = settingsPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, settingsPath);
  }

  return { path: settingsPath, changed, before, after: settings, sandboxSocket };
}
