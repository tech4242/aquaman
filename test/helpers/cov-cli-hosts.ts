/**
 * Sandbox for tests of the host namespaces of the aquaman CLI
 * (`aquaman openclaw|hermes|openshell ...` and the vault wizard).
 *
 * The CLI finds host programs by running `which openclaw`, `openclaw --version`,
 * `hermes --version`, `op`, `bw`, `keeper` and so on. None of the real ones may
 * run, so every process started here gets a PATH that holds exactly one private
 * directory: a link to `node`, a link to `which`, and whatever fake scripts the
 * test puts there. HOME, the aquaman config dir, the OpenClaw state dir and the
 * Hermes home all live under one short temp directory.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const CLI_PATH = path.resolve('packages/proxy/src/cli/index.ts');
const TSX_CLI = path.resolve('node_modules/tsx/dist/cli.mjs');

export const TEST_PASSWORD = 'test-password';

export interface Sandbox {
  root: string;
  home: string;
  configDir: string;
  openclawDir: string;
  hermesHome: string;
  managedDir: string;
  bin: string;
  env: Record<string, string>;
  /** Put an executable `#!/bin/sh` script on the sandbox PATH. */
  fakeBin(name: string, body: string): string;
  /** Write `config.yaml` (YAML text or lines). */
  writeConfig(lines: string[]): void;
  readConfig(): string;
  /** Write `openclaw.json` into the OpenClaw state dir (created if missing). */
  writeOpenClawJson(value: unknown): string;
  readOpenClawJson(): any;
  cleanup(): void;
}

/** Variables that would change what the CLI does if they leaked in from the developer's shell. */
const LEAKY = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'VAULT_ADDR', 'VAULT_TOKEN', 'VAULT_NAMESPACE', 'BW_SESSION',
  'OP_SERVICE_ACCOUNT_TOKEN', 'OP_CONNECT_HOST', 'OP_CONNECT_TOKEN', 'OPENCLAW_BIN', 'OPENCLAW_HOME',
  'HERMES_HOME', 'HERMES_MANAGED_DIR', 'FORCE_COLOR',
];

export function createSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aqh-'));
  const home = path.join(root, 'h');
  const configDir = path.join(root, 'c');
  const openclawDir = path.join(root, 'oc');
  const hermesHome = path.join(root, 'hm');
  const managedDir = path.join(root, 'managed');
  const bin = path.join(root, 'bin');
  for (const d of [home, configDir, bin]) fs.mkdirSync(d, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.symlinkSync('/usr/bin/which', path.join(bin, 'which'));

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (LEAKY.includes(k)) continue;
    if (k.startsWith('AQUAMAN_') && k !== 'AQUAMAN_CHILD_COVERAGE_DIR') continue;
    env[k] = v;
  }
  Object.assign(env, {
    HOME: home,
    PATH: bin,
    AQUAMAN_CONFIG_DIR: configDir,
    OPENCLAW_STATE_DIR: openclawDir,
    HERMES_HOME: hermesHome,
    HERMES_MANAGED_DIR: managedDir,
    AQUAMAN_ENCRYPTION_PASSWORD: TEST_PASSWORD,
    NO_COLOR: '1',
  });

  return {
    root, home, configDir, openclawDir, hermesHome, managedDir, bin, env,
    fakeBin(name, body) {
      const p = path.join(bin, name);
      fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return p;
    },
    writeConfig(lines) {
      fs.writeFileSync(path.join(configDir, 'config.yaml'), lines.join('\n') + '\n', { mode: 0o600 });
    },
    readConfig() {
      return fs.readFileSync(path.join(configDir, 'config.yaml'), 'utf-8');
    },
    writeOpenClawJson(value) {
      fs.mkdirSync(openclawDir, { recursive: true });
      const p = path.join(openclawDir, 'openclaw.json');
      fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
      return p;
    },
    readOpenClawJson() {
      return JSON.parse(fs.readFileSync(path.join(openclawDir, 'openclaw.json'), 'utf-8'));
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The usual config: encrypted-file backend, anthropic + openai proxied, audit under the config dir. */
export function baseConfig(sb: Sandbox, extra: string[] = []): string[] {
  return [
    'credentials:',
    '  backend: encrypted-file',
    '  proxiedServices:',
    '    - anthropic',
    '    - openai',
    'audit:',
    '  enabled: true',
    `  logDir: ${path.join(sb.configDir, 'audit')}`,
    ...extra,
  ];
}

export interface RunResult {
  stdout: string;
  stderr: string;
  /** stdout followed by stderr. */
  all: string;
  code: number | null;
}

export interface RunOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** Written to stdin in one piece, then stdin is closed. */
  input?: string;
  /**
   * Answers to prompts, in order: each is written when its prompt text has
   * appeared on stdout. Several readline interfaces read the same pipe one
   * after another, so the answers cannot all be written up front.
   */
  answers?: Array<[prompt: string, answer: string]>;
  timeoutMs?: number;
}

export function startCli(sb: Sandbox, args: string[], opts: RunOptions = {}): ChildProcess {
  const env: Record<string, string> = { ...sb.env };
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return spawn(process.execPath, [TSX_CLI, CLI_PATH, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    cwd: opts.cwd ?? process.cwd(),
  });
}

/** Run the CLI to completion. */
export function runCli(sb: Sandbox, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = startCli(sb, args, opts);
    let stdout = '';
    let stderr = '';
    const pending = [...(opts.answers ?? [])];
    let seenUpTo = 0;
    const feed = () => {
      while (pending.length > 0) {
        const at = stdout.indexOf(pending[0][0], seenUpTo);
        if (at === -1) return;
        seenUpTo = at + pending[0][0].length;
        proc.stdin!.write(pending[0][1] + '\n');
        pending.shift();
      }
      if (opts.answers) proc.stdin!.end();
    };
    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); if (opts.answers) feed(); });
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.stdin!.on('error', () => { /* child exited before reading */ });
    if (!opts.answers) proc.stdin!.end(opts.input ?? '');
    const timer = setTimeout(() => { proc.kill('SIGKILL'); }, opts.timeoutMs ?? 60_000);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, all: stdout + stderr, code });
    });
  });
}

/** Store a credential in the sandbox's encrypted-file vault through the CLI. */
export async function addCredential(sb: Sandbox, service: string, key: string, value: string): Promise<void> {
  const r = await runCli(sb, ['credentials', 'add', service, key, '--backend', 'encrypted-file'], { input: value });
  if (r.code !== 0) throw new Error(`credentials add ${service}/${key} failed: ${r.all}`);
}

/** Wait until `text` shows up in what a started process has written, or fail. */
export function waitForOutput(proc: ChildProcess, text: string, timeoutMs = 45_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${text}"; got: ${buf}`)), timeoutMs);
    const onData = (d: Buffer) => {
      buf += d.toString();
      if (buf.includes(text)) { clearTimeout(timer); resolve(buf); }
    };
    proc.stdout!.on('data', onData);
    proc.stderr!.on('data', onData);
    proc.on('close', () => { clearTimeout(timer); if (!buf.includes(text)) reject(new Error(`exited before "${text}"; got: ${buf}`)); });
  });
}

export function waitForExit(proc: ChildProcess, timeoutMs = 30_000): Promise<number | null> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve(proc.exitCode);
    const timer = setTimeout(() => { proc.kill('SIGKILL'); }, timeoutMs);
    proc.on('close', (code) => { clearTimeout(timer); resolve(code); });
  });
}

const PTY_DRIVER = path.resolve('test/helpers/cov-cli-hosts-pty.py');

/** Where a Python 3 that can drive a pseudo-terminal lives, or null. Looked up on the real PATH, not the sandbox's. */
export function findPython3(): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, 'python3');
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* next */ }
  }
  return null;
}

/**
 * Run the CLI with a terminal on stdin and stdout, typing `answers` key by key
 * as their prompts appear. `output` is what the terminal showed, which is what
 * a person looking at the screen would have seen.
 */
export function runCliOnTty(
  sb: Sandbox,
  args: string[],
  answers: Array<[prompt: string, keys: string]>,
  opts: { env?: Record<string, string | undefined>; timeoutMs?: number } = {}
): Promise<{ output: string; code: number | null }> {
  const python = findPython3();
  if (!python) throw new Error('python3 not found');
  const spec = path.join(sb.root, `pty-spec-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(spec, JSON.stringify({
    argv: [process.execPath, TSX_CLI, CLI_PATH, ...args],
    answers,
    timeout: (opts.timeoutMs ?? 60_000) / 1000,
  }));
  const env: Record<string, string> = { ...sb.env, TERM: 'dumb' };
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return new Promise((resolve, reject) => {
    const proc = spawn(python, [PTY_DRIVER, spec], { stdio: ['ignore', 'pipe', 'pipe'], env });
    let out = '';
    let err = '';
    proc.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr!.on('data', (d: Buffer) => { err += d.toString(); });
    proc.on('close', () => {
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error(`pty driver failed: ${err || out}`));
      }
    });
  });
}
