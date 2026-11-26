/**
 * OpenClaw's config file: where it is, and how aquaman changes it.
 *
 * OpenClaw owns `openclaw.json`. Its own writers validate the whole config
 * before saving, keep backups, respect `$include` files and a read-only
 * deployment, and hand the write to a running Gateway so that the Gateway
 * stays the only writer. aquaman therefore never writes the file: it works
 * out what it wants changed as a merge patch and gives that to
 * `openclaw config patch --stdin`. Where that cannot be done (no `openclaw`
 * program, a read-only config, a config with `$include`), the patch is saved
 * for the person to apply and nothing is changed.
 *
 * Run against OpenClaw 2026.6.10, 2026.10.33 and 2026.11.10: one patch with
 * the plugin entry, the secrets provider, a provider's `baseUrl` and `apiKey`
 * reference and a channel's `apiRoot` and `botToken` reference is accepted
 * and written owner-only; an invalid patch exits 1 and saves nothing; a
 * `null` deletes its path; the plugin has to be installed and enabled for the
 * secrets provider to validate.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

export interface OpenClawPaths {
  stateDir: string;
  configPath: string;
}

/** A profile name aquaman passes to `openclaw --profile`. Letters, digits, `-` and `_`. */
export function isOpenClawProfileName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name);
}

/** `--profile <name>` before the subcommand, or nothing for the default profile. */
export function openclawProfileArgs(profile: string | undefined): string[] {
  return profile ? ['--profile', profile] : [];
}

/**
 * The state directory and config file of an OpenClaw profile. A named profile
 * lives under `~/.openclaw-<name>` whatever the environment says, as
 * `openclaw --profile` has it; otherwise `OPENCLAW_STATE_DIR` and
 * `OPENCLAW_CONFIG_PATH` are honoured.
 */
export function openclawPaths(
  profile?: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): OpenClawPaths {
  if (profile) {
    const stateDir = path.join(homeDir, `.openclaw-${profile}`);
    return { stateDir, configPath: path.join(stateDir, 'openclaw.json') };
  }
  const stateDir = env['OPENCLAW_STATE_DIR'] || path.join(homeDir, '.openclaw');
  return { stateDir, configPath: env['OPENCLAW_CONFIG_PATH'] || path.join(stateDir, 'openclaw.json') };
}

/**
 * The variable that makes OpenClaw treat its config as immutable, when one is
 * set. OpenClaw before 2026.10 knows only the Nix one, so aquaman checks both
 * itself and does not rely on the program refusing.
 */
export function openclawConfigReadOnly(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env['OPENCLAW_CONFIG_READONLY'] === '1') return 'OPENCLAW_CONFIG_READONLY';
  if (env['OPENCLAW_NIX_MODE'] === '1') return 'OPENCLAW_NIX_MODE';
  return null;
}

/** Whether a parsed config pulls settings in from other files. aquaman sees only the root file. */
export function configHasIncludes(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(configHasIncludes);
  if (value === null || typeof value !== 'object') return false;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === '$include' || configHasIncludes(v)) return true;
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The merge patch that turns `before` into `after`, in the form
 * `openclaw config patch` takes: objects are merged key by key, an array or a
 * scalar replaces what is there, and `null` deletes a key. `undefined` when
 * nothing differs.
 */
export function configMergePatch(before: unknown, after: unknown): Record<string, unknown> | undefined {
  const b = isPlainObject(before) ? before : {};
  const a = isPlainObject(after) ? after : {};
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(b)) {
    if (!(key in a) || a[key] === undefined) patch[key] = null;
  }
  for (const [key, value] of Object.entries(a)) {
    if (value === undefined) continue;
    const old = b[key];
    if (isPlainObject(value) && isPlainObject(old)) {
      const sub = configMergePatch(old, value);
      if (sub) patch[key] = sub;
    } else if (!(key in b) || !sameValue(old, value)) {
      patch[key] = value;
    }
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/**
 * Whether a config holds everything a merge patch asked for: each value the
 * patch set is there, and each key it deleted is gone. Keys the patch did not
 * name are OpenClaw's business and are not looked at.
 */
export function patchIsApplied(config: unknown, patch: Record<string, unknown>): boolean {
  const c = isPlainObject(config) ? config : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      if (key in c) return false;
    } else if (isPlainObject(value)) {
      if (!isPlainObject(c[key]) || !patchIsApplied(c[key], value)) return false;
    } else if (!sameValue(c[key], value)) {
      return false;
    }
  }
  return true;
}

/**
 * What became of a change to OpenClaw's config.
 *
 * `unchanged`: there was nothing to change.
 * `applied`: `openclaw config patch` accepted it; `note` is what OpenClaw said
 * about restarting.
 * `manual`: nothing was run. The patch is in `patchPath` and `command` applies it.
 * `failed`: OpenClaw refused the patch and saved nothing; `detail` is what it said.
 */
export type OpenClawWriteResult =
  | { status: 'unchanged' }
  | { status: 'applied'; note: string }
  | { status: 'manual'; reason: 'no_cli' | 'read_only' | 'includes'; patchPath: string; command: string; variable?: string }
  | { status: 'failed'; detail: string; patchPath: string; command: string };

export interface OpenClawWriteOptions {
  /** Directory the patch is saved in when it is not applied: aquaman's config directory. */
  patchDir: string;
  profile?: string;
  /** The `openclaw` program, or `null` when there is none to run. */
  binary: string | null;
  /** The config as read, to see whether it uses `$include`. */
  current?: unknown;
  /**
   * The config file. When given, it is read after OpenClaw reports success,
   * and the change counts as applied only if the file holds it.
   */
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

function runWithStdin(
  binary: string, args: string[], input: string, env: NodeJS.ProcessEnv, timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const proc = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    const timer = setTimeout(() => {
      stderr += `timed out after ${timeoutMs / 1000}s`;
      proc.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => { stderr += err.message; finish(null); });
    proc.on('close', (code) => finish(code));
    proc.stdin?.on('error', () => { /* the program went away before reading; its exit says why */ });
    proc.stdin?.end(input);
  });
}

/** Lines OpenClaw printed that are about this change, without its startup warnings. */
function relevantLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !/SECURITY WARNING/.test(l));
}

/**
 * Give a merge patch to OpenClaw. The patch holds no secret: credentials are
 * references to aquaman's secrets provider, so it can be saved and shown.
 */
export async function applyOpenClawPatch(
  patch: Record<string, unknown> | undefined,
  options: OpenClawWriteOptions,
): Promise<OpenClawWriteResult> {
  if (!patch) return { status: 'unchanged' };
  const env = options.env ?? process.env;
  const profileArgs = openclawProfileArgs(options.profile);

  const savePatch = (): { patchPath: string; command: string } => {
    fs.mkdirSync(options.patchDir, { recursive: true, mode: 0o700 });
    const patchPath = path.join(options.patchDir, 'openclaw-setup.patch.json');
    const tmp = `${patchPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(patch, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, patchPath);
    const quoted = /^[A-Za-z0-9_./:@%+=-]+$/.test(patchPath) ? patchPath : `'${patchPath.replace(/'/g, `'\\''`)}'`;
    return { patchPath, command: `openclaw ${[...profileArgs, 'config', 'patch', '--file', quoted].join(' ')}` };
  };

  const variable = openclawConfigReadOnly(env);
  if (variable) return { status: 'manual', reason: 'read_only', variable, ...savePatch() };
  if (configHasIncludes(options.current)) return { status: 'manual', reason: 'includes', ...savePatch() };
  if (!options.binary) return { status: 'manual', reason: 'no_cli', ...savePatch() };

  const r = await runWithStdin(
    options.binary, [...profileArgs, 'config', 'patch', '--stdin'], JSON.stringify(patch), env, options.timeoutMs ?? 120_000,
  );
  if (r.code === 0) {
    if (options.configPath) {
      let held = false;
      try {
        held = patchIsApplied(JSON.parse(fs.readFileSync(options.configPath, 'utf-8')), patch);
      } catch { /* missing or unreadable: not held */ }
      if (!held) {
        return {
          status: 'failed',
          detail: `OpenClaw reported success, but ${options.configPath} does not hold the change`,
          ...savePatch(),
        };
      }
    }
    const lines = relevantLines(r.stdout);
    return { status: 'applied', note: lines[lines.length - 1] ?? '' };
  }
  const said = relevantLines(`${r.stderr}\n${r.stdout}`).slice(-4).join(' ').slice(0, 600);
  return {
    status: 'failed',
    detail: said || (r.code === null ? 'the openclaw program could not be run' : `exit ${r.code}`),
    ...savePatch(),
  };
}
