/**
 * Shared harness for the cov-cli-core-* suites: the vault-level and
 * daemon-level commands of the proxy CLI, run as real child processes.
 *
 * Every child gets its own HOME and AQUAMAN_CONFIG_DIR, the encrypted-file
 * backend forced through AQUAMAN_BACKEND (so a config that says `keychain`
 * never reaches the macOS Keychain), and a PATH that holds only `node`, the
 * system directories and whatever fake binaries the test installs. The
 * machine's own `aquaman-coder`, `openclaw` and `hermes` are therefore never
 * found, let alone run.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PROXY_CLI = path.resolve('packages/proxy/src/cli/index.ts');
export const CODER_CLI = path.resolve('packages/coder/src/cli/index.ts');
export const TSX = path.resolve('node_modules/.bin/tsx');
const TSX_LOADER = pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href;

export const PASSWORD = 'cov-cli-core-vault-password';
export const T = 90_000;

/** Variables of the developer's shell that would change what a child does. */
const SCRUBBED = [
  'AQUAMAN_LOOPBACK_ENABLED', 'AQUAMAN_LOOPBACK_PORT', 'AQUAMAN_LOOPBACK_TOKEN', 'AQUAMAN_BROKER_ENABLED',
  'AQUAMAN_OPENSHELL_DRIVER', 'AQUAMAN_SERVICES', 'AQUAMAN_AUDIT_ENABLED', 'AQUAMAN_CACHE_TTL',
  'AQUAMAN_KEEPASS_PASSWORD', 'AQUAMAN_OPENCLAW_VERSION', 'VAULT_ADDR', 'VAULT_TOKEN',
  'OP_SERVICE_ACCOUNT_TOKEN', 'OP_CONNECT_HOST', 'OP_CONNECT_TOKEN', 'BW_SESSION',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'FORCE_COLOR', 'NODE_OPTIONS', 'HERMES_MANAGED_DIR',
];

export interface RunResult { code: number | null; stdout: string; stderr: string }
export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string;
  /**
   * Start `node` with the TypeScript loader in NODE_OPTIONS instead of going
   * through the tsx binary, so a process the CLI itself starts from
   * `process.execPath` (the detached daemon of `init --agent`) can load the
   * source too.
   */
  inheritLoader?: boolean;
}

export interface Sandbox {
  root: string;
  home: string;
  config: string;
  bin: string;
  project: string;
  socket: string;
  env(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv;
  run(args: string[], opts?: RunOptions): Promise<RunResult>;
  spawnCli(args: string[], opts?: RunOptions): ChildProcess;
  writeConfig(yaml: string): void;
  /** Put an executable named `name` on the child's PATH. */
  installBin(name: string, script: string, mode?: number): string;
  /** `aquaman-coder` on PATH, running the real coder CLI from source. */
  installRealCoder(): void;
  /** `aquaman-coder` on PATH that records its arguments and answers from a script. */
  installFakeCoder(body: string): void;
  coderCalls(): string[][];
  cleanup(): Promise<void>;
  track(child: ChildProcess): ChildProcess;
}

export function createSandbox(): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aqcc-')));
  const home = path.join(root, 'home');
  const config = path.join(root, 'aq');
  const bin = path.join(root, 'bin');
  const project = path.join(root, 'app');
  for (const d of [home, config, bin, project]) fs.mkdirSync(d);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const children: ChildProcess[] = [];
  const callLog = path.join(root, 'coder-calls.log');

  const env = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => {
    const base: NodeJS.ProcessEnv = { ...process.env };
    for (const k of SCRUBBED) delete base[k];
    const merged: NodeJS.ProcessEnv = {
      ...base,
      HOME: home,
      AQUAMAN_CONFIG_DIR: config,
      AQUAMAN_BACKEND: 'encrypted-file',
      AQUAMAN_ENCRYPTION_PASSWORD: PASSWORD,
      OPENCLAW_STATE_DIR: path.join(home, '.openclaw'),
      HERMES_HOME: path.join(home, '.hermes'),
      CODEX_HOME: path.join(home, '.codex'),
      PATH: `${bin}:/usr/bin:/bin`,
      NO_COLOR: '1',
      ...extra,
    };
    for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
    return merged;
  };

  const spawnCli = (args: string[], opts: RunOptions = {}): ChildProcess => {
    const childEnv = env(opts.env);
    const stdin = opts.input === undefined ? 'ignore' : 'pipe';
    const child = opts.inheritLoader
      ? spawn(process.execPath, [PROXY_CLI, ...args], {
          cwd: opts.cwd ?? project,
          stdio: [stdin, 'pipe', 'pipe'],
          env: { ...childEnv, NODE_OPTIONS: `--import=${TSX_LOADER}` },
        })
      : spawn(TSX, [PROXY_CLI, ...args], { cwd: opts.cwd ?? project, stdio: [stdin, 'pipe', 'pipe'], env: childEnv });
    if (opts.input !== undefined) child.stdin!.end(opts.input);
    return child;
  };

  const run = (args: string[], opts: RunOptions = {}): Promise<RunResult> =>
    new Promise((resolve, reject) => {
      const child = spawnCli(args, opts);
      let stdout = '';
      let stderr = '';
      child.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

  const installBin = (name: string, script: string, mode = 0o755): string => {
    const file = path.join(bin, name);
    fs.writeFileSync(file, script, { mode });
    fs.chmodSync(file, mode);
    return file;
  };

  return {
    root, home, config, bin, project,
    socket: path.join(config, 'proxy.sock'),
    env, run, spawnCli, installBin,
    writeConfig(yaml: string) { fs.writeFileSync(path.join(config, 'config.yaml'), yaml, { mode: 0o600 }); },
    installRealCoder() {
      installBin('aquaman-coder', `#!/bin/sh\nexec "${TSX}" "${CODER_CLI}" "$@"\n`);
    },
    installFakeCoder(body: string) {
      // One line per call: the arguments, tab-separated.
      installBin('aquaman-coder', `#!/bin/sh\n( IFS='\t'; printf '%s\\n' "$*" ) >> "${callLog}"\n${body}\n`);
    },
    coderCalls() {
      if (!fs.existsSync(callLog)) return [];
      return fs.readFileSync(callLog, 'utf-8').split('\n').filter(Boolean).map((l) => l.split('\t'));
    },
    track(child: ChildProcess) { children.push(child); return child; },
    async cleanup() {
      for (const child of children) await stop(child);
      // A daemon the CLI started detached is known only by its pid file.
      const pidFile = path.join(config, 'daemon.pid');
      if (fs.existsSync(pidFile)) {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf-8'), 10);
        if (Number.isInteger(pid) && pid > 1) await stopPid(pid);
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** SIGTERM (so the process writes its coverage), then wait for it to go. */
export async function stopPid(pid: number): Promise<void> {
  if (!alive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  for (let i = 0; i < 100 && alive(pid); i++) await sleep(100);
  if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

export async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 10_000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    child.kill('SIGTERM');
  });
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function udsGet(socketPath: string, urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: urlPath, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Collects a child's output and waits until `ready` says it is up. */
export async function waitFor(
  child: ChildProcess,
  ready: (output: string) => boolean | Promise<boolean>,
  timeoutMs = 45_000,
): Promise<() => string> {
  let output = '';
  child.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
  child.stderr?.on('data', (d: Buffer) => { output += d.toString(); });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ready(output)) return () => output;
    if (child.exitCode !== null) throw new Error(`process exited early (${child.exitCode}):\n${output}`);
    await sleep(150);
  }
  throw new Error(`process never became ready:\n${output}`);
}

/** Starts `aquaman daemon` in the sandbox and waits for its socket. */
export async function startDaemon(sb: Sandbox, opts: RunOptions = {}): Promise<{ child: ChildProcess; output: () => string }> {
  const child = sb.track(sb.spawnCli(['daemon'], opts));
  const output = await waitFor(child, async (text) => {
    if (!text.includes('Press Ctrl+C')) return false;
    try { return (await udsGet(sb.socket, '/_health')).status === 200; } catch { return false; }
  });
  return { child, output };
}

export function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export interface FakeProxy {
  requests: Array<{ method: string; url: string; body: any }>;
  close(): Promise<void>;
}

/**
 * Something on the proxy's socket that is not the proxy: the test decides
 * what each path answers. Used for replies the real daemon only gives after a
 * person has answered a dialog, and for proxies that misbehave.
 */
export function fakeProxy(
  socketPath: string,
  handler: (req: { method: string; url: string; body: any }, res: http.ServerResponse) => void,
): Promise<FakeProxy> {
  const requests: FakeProxy['requests'] = [];
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (c) => { text += c; });
    req.on('end', () => {
      let body: any = text;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      const seen = { method: req.method ?? '', url: req.url ?? '', body };
      requests.push(seen);
      handler(seen, res);
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(socketPath, () => {
      resolve({
        requests,
        close: () => new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => { try { fs.unlinkSync(socketPath); } catch { /* gone */ } done(); });
        }),
      });
    });
  });
}

export const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
