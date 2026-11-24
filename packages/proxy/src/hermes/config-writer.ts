/**
 * Environment configuration generator for Hermes integration (v0.13.0+)
 *
 * Hermes is a Python agent host that builds its own HTTP client
 * internally and exposes no transport/socket hook — so the aquaman UDS proxy
 * can't be injected the way it is for OpenClaw. Instead the proxy runs an
 * opt-in loopback TCP listener and Hermes is pointed at it via the SAME
 * provider env vars it already understands (`ANTHROPIC_BASE_URL`,
 * `OPENAI_BASE_URL`) plus a placeholder api_key that equals the loopback token.
 *
 * Hermes path conventions (verified against hermes_cli/runtime_provider.py and
 * agent/anthropic_adapter.py):
 *   - Anthropic: base_url must end with `/anthropic`. Hermes special-cases that
 *     suffix into `anthropic_messages` api_mode; the Anthropic SDK then appends
 *     `/v1/messages`, yielding `/anthropic/v1/messages` at the proxy.
 *   - OpenAI: base_url ends with `/openai/v1`; the OpenAI SDK appends
 *     `/chat/completions`, yielding `/openai/v1/chat/completions`. The proxy's
 *     `openai` upstream is `https://api.openai.com` (no `/v1`), so there's no
 *     double-`/v1`.
 *
 * First cut covers LLM-provider isolation only (anthropic, openai). Channels /
 * "platforms" are deferred — they have no base_url lever and hit the same
 * can't-intercept-a-foreign-client wall.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseAquamanRef } from '../broker-scope.js';
import { isAquamanPlaceholder } from '../core/utils/config.js';

/** Matches the SAFE_SERVICE_NAME pattern from daemon.ts. */
const SAFE_SERVICE_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/** Providers Hermes can be pointed at the loopback listener today. */
export const HERMES_SUPPORTED_SERVICES = ['anthropic', 'openai'] as const;

export interface HermesEnvConfig {
  /** Loopback listener port. */
  port: number;
  /** Loopback token — becomes the placeholder api_key Hermes presents. */
  token: string;
  /** Loopback host. Defaults to 127.0.0.1. */
  host?: string;
  /** Services to wire. Only anthropic/openai are emitted today; others are ignored. */
  services: string[];
}

/**
 * Generate the env vars that point Hermes at the aquaman loopback listener.
 * For each supported provider in `services`, emits both the base URL and a
 * placeholder api_key set to the loopback token. The proxy strips the
 * placeholder and injects the real vault-stored credential.
 */
export function generateHermesEnv(config: HermesEnvConfig): Record<string, string> {
  const host = config.host || '127.0.0.1';
  const base = `http://${host}:${config.port}`;
  const env: Record<string, string> = {};

  // Always wire the loopback origin + token explicitly. The Hermes secret
  // source (aquaman-hermes plugin, Hermes >= 0.18.1) reads these to resolve
  // `aquaman://service/key` bindings via the token-gated /broker/resolve
  // endpoint — independent of which providers are proxied below.
  env['AQUAMAN_LOOPBACK_URL'] = base;
  env['AQUAMAN_LOOPBACK_TOKEN'] = config.token;

  for (const service of config.services) {
    if (!SAFE_SERVICE_NAME.test(service)) continue;

    switch (service) {
      case 'anthropic':
        env['ANTHROPIC_BASE_URL'] = `${base}/anthropic`;
        env['ANTHROPIC_API_KEY'] = config.token;
        break;
      case 'openai':
        env['OPENAI_BASE_URL'] = `${base}/openai/v1`;
        env['OPENAI_API_KEY'] = config.token;
        break;
      default:
        // Unsupported for Hermes today (channels/other providers). Skip
        // silently — the caller surfaces which services were wired.
        break;
    }
  }

  return env;
}

/** Services in the input list that this integration knows how to wire for Hermes. */
export function hermesWiredServices(services: string[]): string[] {
  return services.filter(s => (HERMES_SUPPORTED_SERVICES as readonly string[]).includes(s));
}

/**
 * Where the Hermes dotenv file is when Hermes itself cannot be asked
 * (`hermes config env-path`): `~/.hermes/.env`, under `HERMES_HOME` when that
 * is set, and under `profiles/<name>` for a named profile.
 */
export function getHermesEnvPath(homeDir: string, profile?: string): string {
  const stateDir = process.env['HERMES_HOME'] || path.join(homeDir, '.hermes');
  return profile && profile !== 'default'
    ? path.join(stateDir, 'profiles', profile, '.env')
    : path.join(stateDir, '.env');
}

/**
 * `aquaman://` refs bound in the Hermes secret source (`secrets.aquaman.env`
 * in `$HERMES_HOME/config.yaml`), excluding the LLM-provider vars the source
 * refuses anyway. Read-only, for diagnostics: since v0.15.0 each of these
 * must also be declared to the daemon's broker (`aquaman broker allow`), and
 * `aquaman hermes doctor` uses this to say which ones aren't.
 */
export function hermesSecretSourceRefs(homeDir: string = os.homedir()): { path: string; refs: string[]; error?: string } {
  const configPath = path.join(process.env['HERMES_HOME'] || path.join(homeDir, '.hermes'), 'config.yaml');
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { path: configPath, refs: [] };
    return { path: configPath, refs: [], error: `cannot read ${configPath}: ${err?.message ?? err}` };
  }
  let parsed: any;
  try {
    parsed = parseYaml(raw);
  } catch (err: any) {
    return { path: configPath, refs: [], error: `cannot parse ${configPath}: ${err?.message ?? err}` };
  }
  const env = parsed?.secrets?.aquaman?.env;
  const refs = new Set<string>();
  if (env && typeof env === 'object') {
    for (const [name, ref] of Object.entries(env)) {
      if (name === 'ANTHROPIC_API_KEY' || name === 'OPENAI_API_KEY') continue;
      if (typeof ref === 'string' && parseAquamanRef(ref)) refs.add(ref);
    }
  }
  return { path: configPath, refs: [...refs].sort() };
}

/**
 * The first Hermes whose `hermes config set` stores every UPPER_SNAKE name in
 * the profile's `.env`. An earlier one stores only names it lists or that end
 * in `_API_KEY`, `_TOKEN` or `_SECRET` there and puts the rest at the top of
 * `config.yaml` (run on 0.19.0: `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` and
 * `AQUAMAN_LOOPBACK_URL` land in `config.yaml`), so for those versions the
 * settings are shown for a person to add and no command is run.
 */
export const HERMES_CONFIG_SET_ENV_MIN = '0.21.4';

/** Whether `hermes config set` of this Hermes version stores our settings in `.env`. */
export function hermesConfigSetWritesEnv(version: string | undefined): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (!m) return false;
  const have = [Number(m[1]), Number(m[2]), Number(m[3])];
  const need = HERMES_CONFIG_SET_ENV_MIN.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (have[i] !== need[i]) return have[i] > need[i];
  }
  return true;
}

/** A Hermes profile name, as Hermes itself accepts one (`PROFILE_ID_RE`), or `default`. */
export function isHermesProfileName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name);
}

/** Arguments that select a profile, placed before the subcommand. None for the profile Hermes would use anyway. */
export function hermesProfileArgs(profile: string | undefined): string[] {
  return profile ? ['-p', profile] : [];
}

/**
 * The `hermes config set` invocations that store `env`, one argument list
 * each. Hermes owns its `.env`: it writes the profile's file under its own
 * lock, keeps the file's mode and registers a provider key with its
 * credential pool, none of which an edit of the file from outside does.
 */
export function hermesConfigSetArgs(env: Record<string, string>, profile?: string): string[][] {
  return Object.entries(env).map(([k, v]) => [...hermesProfileArgs(profile), 'config', 'set', k, v]);
}

/** The same invocations as lines a person can paste into a shell. */
export function formatHermesConfigSetCommands(env: Record<string, string>, profile?: string): string {
  const quote = (v: string) => (/^[A-Za-z0-9_./:@%+=-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);
  return hermesConfigSetArgs(env, profile)
    .map((args) => `  hermes ${args.map(quote).join(' ')}`)
    .join('\n');
}

/**
 * The assignments in a dotenv file, last one winning: `KEY=value`,
 * `export KEY=value`, `KEY = value`, with one pair of surrounding quotes
 * removed. `null` when the file cannot be read.
 */
export function readEnvAssignments(filePath: string): Record<string, string> | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

/** Which of the settings in `expected` the dotenv file lacks, and which it holds with another value. */
export function hermesEnvWiring(
  filePath: string,
  expected: Record<string, string>,
): { readable: boolean; missing: string[]; differing: string[] } {
  const have = readEnvAssignments(filePath);
  if (have === null) return { readable: false, missing: Object.keys(expected), differing: [] };
  const missing: string[] = [];
  const differing: string[] = [];
  for (const [k, v] of Object.entries(expected)) {
    if (!(k in have)) missing.push(k);
    else if (have[k] !== v) differing.push(k);
  }
  return { readable: true, missing, differing };
}

/**
 * Whether anyone but the owner can read the dotenv file. Hermes creates the
 * file owner-only and keeps the mode of one that already exists, and the file
 * holds the loopback token once setup has run.
 */
export function hermesEnvOpenToOthers(filePath: string): boolean {
  try {
    return (fs.statSync(filePath).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}

/**
 * Provider key variables in the dotenv file that hold something other than an
 * aquaman placeholder. `hermes config set` replaces the line, so a real key
 * there would be gone from the file: setup stops and says so unless told to
 * replace it.
 */
export function hermesRealKeysInEnv(filePath: string, env: Record<string, string>): string[] {
  const have = readEnvAssignments(filePath) ?? {};
  return Object.keys(env).filter((k) => {
    if (!k.endsWith('_API_KEY')) return false;
    const current = have[k];
    return typeof current === 'string' && current !== '' && !isAquamanPlaceholder(current);
  });
}

/**
 * Hermes >= 0.17 "managed scope": a root-owned /etc/hermes/.env is loaded LAST
 * with override=true, beating both ~/.hermes/.env and shell exports. If an
 * admin pins any of the env vars aquaman manages, the proxy is silently
 * bypassed for those keys. Returns the managed keys that file shadows (empty
 * when the file is absent/unreadable). `managedEnvPath` is parameterized for
 * tests; production callers use the default.
 */
export const HERMES_MANAGED_ENV_PATH = '/etc/hermes/.env';

/**
 * The managed-scope .env Hermes actually loads. Hermes 0.21 lets the
 * deployment relocate the scope with `HERMES_MANAGED_DIR` (non-empty wins over
 * /etc/hermes; hermes_cli/managed_scope.py `get_managed_dir()`), so checking
 * only /etc/hermes would miss a relocated policy.
 */
export function hermesManagedEnvPath(): string {
  const override = (process.env['HERMES_MANAGED_DIR'] ?? '').trim();
  return override ? path.join(override, '.env') : HERMES_MANAGED_ENV_PATH;
}

export function managedScopeShadowedKeys(
  ourEnv: Record<string, string>,
  managedEnvPath: string = hermesManagedEnvPath()
): string[] {
  let content: string;
  try {
    content = fs.readFileSync(managedEnvPath, 'utf-8');
  } catch {
    return []; // absent or unreadable (non-root) — nothing to warn about
  }
  const pinned = new Set<string>();
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) pinned.add(m[1]);
  }
  return Object.keys(ourEnv).filter((k) => pinned.has(k));
}

/** Format env vars for display (dry-run / export output). */
export function formatHermesEnvForDisplay(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `  ${k}=${v}`)
    .join('\n');
}
