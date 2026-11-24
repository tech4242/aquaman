/**
 * A stand-in for the `hermes` program, for tests of `aquaman hermes ...`.
 *
 * It does what the commands aquaman runs do in Hermes 0.23.1, as read in its
 * source and run by hand against a real install: `--version`,
 * `[-p <profile>] config env-path` and `[-p <profile>] config set KEY VALUE`,
 * which replaces the line in the profile's `.env` or appends one, keeps
 * everything else in the file, and creates the file owner-only. Before 0.21.4
 * a name that is not a credential (`*_BASE_URL`, `AQUAMAN_LOOPBACK_URL`) goes
 * to the top of `config.yaml` instead, and so it does here.
 *
 * Every invocation is appended to `<dir>/hermes-calls.jsonl`, so a test can
 * say what was run and that nothing else was.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FakeHermesOptions {
  version?: string;
  /** `config set` of this key fails the way a managed key does. */
  refuseKey?: string;
  /** `config set` reports success and stores nothing. */
  storeNothing?: boolean;
  /** `config env-path` fails. */
  noEnvPath?: boolean;
}

const SOURCE = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const opts = JSON.parse(fs.readFileSync(__filename + '.json', 'utf-8'));
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(path.dirname(__filename), 'hermes-calls.jsonl'), JSON.stringify(argv) + '\n');

if (argv[0] === '--version') {
  console.log('Hermes Agent v' + opts.version + ' (2026.11.1) · stable');
  process.exit(0);
}

const root = process.env.HERMES_HOME || path.join(process.env.HOME, '.hermes');
let home = root;
let rest = argv;
let profile = null;
if (rest[0] === '-p' || rest[0] === '--profile') {
  profile = rest[1];
  rest = rest.slice(2);
} else {
  try {
    const active = fs.readFileSync(path.join(root, 'active_profile'), 'utf-8').trim();
    if (active && active !== 'default') profile = active;
  } catch {}
}
if (profile && profile !== 'default') {
  home = path.join(root, 'profiles', profile);
  if (!fs.existsSync(home)) {
    console.error("Error: Profile '" + profile + "' does not exist. Create it with: hermes profile create " + profile);
    process.exit(1);
  }
}
const envPath = path.join(home, '.env');

if (rest[0] === 'config' && rest[1] === 'env-path') {
  if (opts.noEnvPath) { console.error('unknown command'); process.exit(2); }
  console.log(envPath);
  process.exit(0);
}

if (rest[0] === 'config' && rest[1] === 'set' && rest.length === 4) {
  const key = rest[2];
  const value = rest[3];
  if (opts.refuseKey === key) {
    console.error('✗ Cannot set ' + key + ' to ' + value + ': it is managed by your administrator (/etc/hermes/.env) and cannot be changed.');
    process.exit(1);
  }
  if (opts.storeNothing) {
    console.log('✓ Set ' + key + ' in ' + envPath);
    process.exit(0);
  }
  const [major, minor, patch] = opts.version.split('.').map(Number);
  const byShape = major > 0 || minor > 21 || (minor === 21 && patch >= 4);
  const credential = /(_API_KEY|_TOKEN|_SECRET)$/.test(key);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (!byShape && !credential) {
    fs.appendFileSync(path.join(home, 'config.yaml'), key + ': ' + value + '\n');
    console.log("⚠ '" + key + "' is not a recognized config key — it was saved anyway, but Hermes may not read it.");
    process.exit(0);
  }
  const existed = fs.existsSync(envPath);
  const lines = existed ? fs.readFileSync(envPath, 'utf-8').split('\n') : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const defines = (line) => new RegExp('^\\s*(?:export\\s+)?' + key + '\\s*=').test(line);
  const at = lines.findIndex(defines);
  if (at === -1) lines.push(key + '=' + value);
  else lines[at] = key + '=' + value;
  fs.writeFileSync(envPath, lines.join('\n') + '\n', existed ? {} : { mode: 0o600 });
  console.log('✓ Set ' + key + ' in ' + envPath);
  process.exit(0);
}

console.error('fake hermes: unexpected arguments ' + JSON.stringify(argv));
process.exit(2);
`;

/** Put the stand-in at `<dir>/hermes`. Returns its path. */
export function installFakeHermes(dir: string, options: FakeHermesOptions = {}): string {
  const script = path.join(dir, 'hermes-fake.cjs');
  fs.writeFileSync(script, SOURCE);
  fs.writeFileSync(`${script}.json`, JSON.stringify({ version: '0.23.1', ...options }));
  const bin = path.join(dir, 'hermes');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  return bin;
}

/** The argument lists the stand-in was run with, in order. */
export function fakeHermesCalls(dir: string): string[][] {
  try {
    return fs.readFileSync(path.join(dir, 'hermes-calls.jsonl'), 'utf-8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
  } catch {
    return [];
  }
}
