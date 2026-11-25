/**
 * A stand-in for the `openclaw` program, for tests of the commands that
 * change OpenClaw's config.
 *
 * It does what the commands aquaman runs were seen to do on OpenClaw
 * 2026.6.10, 2026.10.33 and 2026.11.10: `--version`,
 * `[--profile <name>] config file` and
 * `[--profile <name>] config patch --stdin`, which merges a config-shaped
 * patch into `openclaw.json` (objects merge, arrays and scalars replace,
 * `null` deletes), creates the file owner-only, refuses a secrets provider
 * that names a plugin which is not installed, and saves nothing when it
 * refuses. `OPENCLAW_CONFIG_READONLY=1` is refused from 2026.10 on, as there.
 *
 * Every invocation is appended to `<dir>/openclaw-calls.jsonl` with what it
 * read on stdin, so a test can say what was run and what the patch held.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FakeOpenClawOptions {
  version?: string;
  /** `config patch` refuses with this message and saves nothing. */
  refusePatch?: string;
}

const SOURCE = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const opts = JSON.parse(fs.readFileSync(__filename + '.json', 'utf-8'));
const argv = process.argv.slice(2);
const log = (extra) => fs.appendFileSync(
  path.join(path.dirname(__filename), 'openclaw-calls.jsonl'),
  JSON.stringify({ argv, ...extra }) + '\n',
);

let rest = argv;
let profile = null;
if (rest[0] === '--profile') { profile = rest[1]; rest = rest.slice(2); }

const home = process.env.HOME;
const stateDir = profile
  ? path.join(home, '.openclaw-' + profile)
  : (process.env.OPENCLAW_STATE_DIR || path.join(home, '.openclaw'));
const configPath = profile
  ? path.join(stateDir, 'openclaw.json')
  : (process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir, 'openclaw.json'));

if (rest[0] === '--version') {
  log({});
  console.log('OpenClaw ' + opts.version + ' (abc1234)');
  process.exit(0);
}

if (rest[0] === 'config' && rest[1] === 'file') {
  log({});
  console.log(configPath);
  process.exit(0);
}

function merge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete target[k];
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!target[k] || typeof target[k] !== 'object' || Array.isArray(target[k])) target[k] = {};
      merge(target[k], v);
    } else target[k] = v;
  }
  return target;
}

function count(patch) {
  let n = 0;
  for (const v of Object.values(patch)) n += v && typeof v === 'object' && !Array.isArray(v) ? count(v) : 1;
  return n;
}

if (rest[0] === 'config' && rest[1] === 'patch' && rest[2] === '--stdin') {
  const input = fs.readFileSync(0, 'utf-8');
  log({ stdin: input, env: { OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH || null } });
  const [, month] = opts.version.split('.').map(Number);
  if (process.env.OPENCLAW_CONFIG_READONLY === '1' && month >= 10) {
    console.error('Config is externally managed (OPENCLAW_CONFIG_READONLY=1), so OpenClaw treats openclaw.json as immutable.');
    process.exit(1);
  }
  if (opts.refusePatch) {
    console.error('Config change declined. No settings were saved.');
    console.error(opts.refusePatch);
    process.exit(1);
  }
  const patch = JSON.parse(input);
  let current = {};
  try {
    const text = fs.readFileSync(configPath, 'utf-8');
    if (text.trim() !== '') current = JSON.parse(text);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Config validation failed: ' + err.message);
      process.exit(1);
    }
  }
  const next = merge(current, patch);
  const provider = next.secrets && next.secrets.providers && next.secrets.providers.aquaman;
  const pluginId = provider && provider.pluginIntegration && provider.pluginIntegration.pluginId;
  if (pluginId && !fs.existsSync(path.join(stateDir, 'extensions', pluginId))) {
    console.error('Error: Config validation failed: plugin-managed SecretRef provider integration is invalid.');
    console.error('- secrets.providers.aquaman: plugin "' + pluginId + '" is not installed');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const existed = fs.existsSync(configPath);
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n', existed ? {} : { mode: 0o600 });
  console.log('Applied ' + count(patch) + ' config update(s). Restart the gateway to apply.');
  process.exit(0);
}

log({});
process.exit(0);
`;

/** Put the stand-in at `<dir>/openclaw`. Returns its path. */
export function installFakeOpenClaw(dir: string, options: FakeOpenClawOptions = {}): string {
  const script = path.join(dir, 'openclaw-fake.cjs');
  fs.writeFileSync(script, SOURCE);
  fs.writeFileSync(`${script}.json`, JSON.stringify({ version: '2026.11.5', ...options }));
  const bin = path.join(dir, 'openclaw');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  return bin;
}

export interface FakeOpenClawCall {
  argv: string[];
  stdin?: string;
  env?: { OPENCLAW_CONFIG_PATH: string | null };
}

/** The invocations of the stand-in, in order. */
export function fakeOpenClawCalls(dir: string): FakeOpenClawCall[] {
  try {
    return fs.readFileSync(path.join(dir, 'openclaw-calls.jsonl'), 'utf-8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line) as FakeOpenClawCall);
  } catch {
    return [];
  }
}

/** The patches the stand-in was given, parsed, in order. */
export function fakeOpenClawPatches(dir: string): Array<Record<string, any>> {
  return fakeOpenClawCalls(dir).filter((c) => c.stdin !== undefined).map((c) => JSON.parse(c.stdin!));
}

/**
 * What `openclaw config patch` does to a config, for tests that hand a
 * writer to code which would otherwise run the program.
 */
export function applyMergePatch(target: Record<string, any>, patch: Record<string, any>): Record<string, any> {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete target[k];
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!target[k] || typeof target[k] !== 'object' || Array.isArray(target[k])) target[k] = {};
      applyMergePatch(target[k], v);
    } else target[k] = v;
  }
  return target;
}
