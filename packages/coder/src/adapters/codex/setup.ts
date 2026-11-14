/**
 * Codex setup (v0.16.0): writes PreToolUse + PostToolUse hooks for the shell
 * tool into `$CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`).
 *
 * Verified against openai/codex main, 2026-09-23:
 *   - hooks.json is `{ "hooks": { "<Event>": [ { matcher, hooks: [handler] } ] } }`
 *     and Codex rejects unknown fields, so nothing else is written into it.
 *   - The shell tool's hook name is `Bash`; a bare word matcher is exact.
 *   - `timeout` is in seconds (default 600). Handlers must not be `async`,
 *     because async hooks cannot rewrite input.
 *   - A new or changed user hook does NOT run until trusted: Codex records
 *     `[hooks.state."<path>:<event>:<group>:<handler>"] trusted_hash` in
 *     config.toml after the user approves it in the startup hook review. We do
 *     not write that entry ourselves (the hash covers Codex's normalized form,
 *     which we would have to reproduce exactly), so setup tells the user to
 *     approve on the next launch, and doctor reports whether they have.
 *
 * Never overwrites unrelated entries. Atomic write via .tmp + rename.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { socketAllowedByEntry } from '../claude-code/setup.js';

type HookHandler = { type: 'command'; command: string; timeout?: number; [k: string]: unknown };
type HookGroup = { matcher?: string; hooks: HookHandler[] };
export interface CodexHooksFile {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

export const CODEX_HOOK_COMMAND = 'aquaman coder hook --host codex';
const HOOK_MARKS = ['aquaman coder hook', 'aquaman-coder hook'];
const EVENTS = ['PreToolUse', 'PostToolUse'] as const;

export function codexHome(): string {
  const env = process.env['CODEX_HOME'];
  return env && env.length > 0 ? env : path.join(os.homedir(), '.codex');
}

export function defaultCodexHooksPath(): string {
  return path.join(codexHome(), 'hooks.json');
}

export interface CodexSetupOptions {
  hooksPath?: string;
  hookCommand?: string;
}

export interface CodexSetupResult {
  path: string;
  changed: boolean;
  after: CodexHooksFile;
}

const isOurs = (h: HookHandler) => HOOK_MARKS.some((m) => typeof h.command === 'string' && h.command.includes(m));

function readHooksFile(hooksPath: string): CodexHooksFile | null {
  if (!fs.existsSync(hooksPath)) return null;
  const raw = fs.readFileSync(hooksPath, 'utf-8');
  try {
    return JSON.parse(raw) as CodexHooksFile;
  } catch (err) {
    throw new Error(`Existing ${hooksPath} is not valid JSON: ${(err as Error).message}`);
  }
}

function writeHooksFile(hooksPath: string, data: CodexHooksFile): void {
  const tmp = hooksPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, hooksPath);
}

export function installCodexHooks(opts: CodexSetupOptions = {}): CodexSetupResult {
  const hooksPath = opts.hooksPath ?? defaultCodexHooksPath();
  const hookCommand = opts.hookCommand ?? CODEX_HOOK_COMMAND;
  const dir = path.dirname(hooksPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const before = readHooksFile(hooksPath);
  const data: CodexHooksFile = before ? JSON.parse(JSON.stringify(before)) : {};
  data.hooks = data.hooks ?? {};

  for (const event of EVENTS) {
    const list = data.hooks[event] ?? [];
    if (list.some((g) => g.hooks?.some(isOurs))) continue;
    list.push({ matcher: 'Bash', hooks: [{ type: 'command', command: hookCommand, timeout: 30 }] });
    data.hooks[event] = list;
  }

  const changed = JSON.stringify(before) !== JSON.stringify(data);
  if (changed) writeHooksFile(hooksPath, data);
  return { path: hooksPath, changed, after: data };
}

export function uninstallCodexHooks(opts: CodexSetupOptions = {}): CodexSetupResult {
  const hooksPath = opts.hooksPath ?? defaultCodexHooksPath();
  const before = readHooksFile(hooksPath);
  if (!before) return { path: hooksPath, changed: false, after: {} };

  const data: CodexHooksFile = JSON.parse(JSON.stringify(before));
  if (data.hooks) {
    for (const event of Object.keys(data.hooks)) {
      data.hooks[event] = data.hooks[event]
        .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !isOurs(h)) }))
        .filter((g) => g.hooks.length > 0);
      if (data.hooks[event].length === 0) delete data.hooks[event];
    }
    if (Object.keys(data.hooks).length === 0) delete data.hooks;
  }

  const changed = JSON.stringify(before) !== JSON.stringify(data);
  if (changed) writeHooksFile(hooksPath, data);
  return { path: hooksPath, changed, after: data };
}

export interface CodexHookStatus {
  installed: boolean;
  /**
   * Codex has recorded a trust entry for our PreToolUse handler. `false` means
   * the hook is installed but will not run until approved in Codex's startup
   * review. A trust entry for an older version of the handler shows as
   * trusted here but as "modified" in Codex; the review prompts again then.
   */
  trusted: boolean;
}

export function codexHookStatus(
  hooksPath: string = defaultCodexHooksPath(),
  configPath: string = path.join(codexHome(), 'config.toml'),
): CodexHookStatus {
  let data: CodexHooksFile | null = null;
  try {
    data = readHooksFile(hooksPath);
  } catch {
    return { installed: false, trusted: false };
  }
  const groups = data?.hooks?.['PreToolUse'] ?? [];
  let key: string | null = null;
  groups.forEach((g, gi) => g.hooks?.forEach((h, hi) => {
    if (key === null && isOurs(h)) key = `${hooksPath}:pre_tool_use:${gi}:${hi}`;
  }));
  if (key === null) return { installed: false, trusted: false };

  let config = '';
  try {
    config = fs.readFileSync(configPath, 'utf-8');
  } catch { /* no config.toml: nothing trusted yet */ }
  return { installed: true, trusted: config.includes(`"${key}"`) };
}

export interface CodexSandboxStatus {
  /** The rewritten command can reach the proxy socket from Codex's sandbox. */
  ok: boolean;
  /** What in config.toml decided it, in one line. */
  detail: string;
}

/**
 * Does `$CODEX_HOME/config.toml` let a sandboxed command connect to the proxy
 * socket? Reads the file only; a `-c` override, `--permission-profile` or a
 * layered `-p` profile on the command line can still change the answer.
 *
 * Ground truth, `codex sandbox` on macOS:
 *   - 0.169.0 (2026-11-14): only a `default_permissions` profile with
 *     `network.enabled = true` reaches the socket. `enabled` alone is enough
 *     and it opens EVERY Unix socket: a `unix_sockets` entry is not consulted,
 *     not even `"deny"`. `unix_sockets` without `enabled` stays EPERM.
 *   - 0.156.1 (2026-09-23): `enabled = true` needed the socket listed too.
 *   So the snippet setup prints keeps both, and a profile that lists the
 *   socket is reported without a caveat.
 *   - Legacy `sandbox_mode` is not evaluated by `codex sandbox` on 0.169.0, so
 *     `workspace-write` + `network_access = true` (reached the socket on
 *     0.156.1) and `danger-full-access` are accepted here but say so.
 *
 * Anything this cannot read or does not recognise is `ok: false`: a doctor
 * line must not be green over a property it did not establish.
 */
export function codexSandboxStatus(
  socketPath: string,
  configPath: string = path.join(codexHome(), 'config.toml'),
): CodexSandboxStatus {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? { ok: false, detail: `${configPath} does not exist, so Codex uses its default sandbox, which blocks the proxy socket` }
      : { ok: false, detail: `cannot read ${configPath} (${(err as Error).message}), so the sandbox setting is unknown` };
  }
  let config: Record<string, unknown>;
  try {
    config = parseToml(raw) as Record<string, unknown>;
  } catch (err) {
    return { ok: false, detail: `cannot parse ${configPath} (${(err as Error).message.split('\n')[0]}), so the sandbox setting is unknown` };
  }

  const table = (v: unknown): Record<string, unknown> | undefined =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

  const profileName = config['default_permissions'];
  if (typeof profileName === 'string' && profileName.length > 0) {
    if (profileName.startsWith(':')) {
      return { ok: false, detail: `default_permissions = "${profileName}" is a built-in profile; none is known to allow the proxy socket` };
    }
    const profile = table(table(config['permissions'])?.[profileName]);
    if (!profile) {
      return { ok: false, detail: `default_permissions = "${profileName}" but [permissions.${profileName}] is not defined` };
    }
    const network = table(profile['network']);
    if (network?.['enabled'] !== true) {
      return { ok: false, detail: `[permissions.${profileName}.network] does not set enabled = true, so Unix-socket connects are denied` };
    }
    const sockets = table(network['unix_sockets']) ?? {};
    const listed = Object.entries(sockets).some(([entry, v]) => v === 'allow' && socketAllowedByEntry(entry, socketPath));
    if (listed || network['dangerously_allow_all_unix_sockets'] === true) {
      return { ok: true, detail: `permissions profile "${profileName}" enables network and allows the proxy socket` };
    }
    return {
      ok: true,
      detail: `permissions profile "${profileName}" enables network, which on Codex 0.169 allows every Unix socket; older Codex also needs the proxy socket under unix_sockets`,
    };
  }

  const mode = config['sandbox_mode'];
  if (mode === 'danger-full-access') {
    return { ok: true, detail: 'sandbox_mode = "danger-full-access": commands are not sandboxed' };
  }
  if (mode === 'workspace-write' && table(config['sandbox_workspace_write'])?.['network_access'] === true) {
    return { ok: true, detail: 'sandbox_workspace_write.network_access = true (reached the socket on Codex 0.156.1; not re-verifiable with `codex sandbox` on 0.169)' };
  }
  return { ok: false, detail: `${configPath} has no permissions profile with network enabled, so the sandbox blocks the proxy socket` };
}
