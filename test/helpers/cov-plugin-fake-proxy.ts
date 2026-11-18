/**
 * A stand-in for the `aquaman` binary, for tests of the OpenClaw plugin's
 * process handling. It is found the way the real one is (an executable named
 * `aquaman` on PATH) and speaks the same start-up contract as
 * `aquaman openclaw plugin-mode`: a log line, then one JSON line with
 * `ready: true`, while serving `/_health` and `/_hostmap` on a Unix socket.
 *
 * It holds no credentials and reaches nothing. Behaviour is picked through
 * AQUAMAN_FAKE_* variables, which the plugin forwards (AQUAMAN_ prefix), and
 * every invocation appends `{ pid, args, env }` to AQUAMAN_FAKE_LOG.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT = `#!${process.execPath}
const http = require('http');
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const mode = process.env.AQUAMAN_FAKE_MODE || 'ok';
if (process.env.AQUAMAN_FAKE_LOG) {
  fs.appendFileSync(process.env.AQUAMAN_FAKE_LOG, JSON.stringify({ pid: process.pid, args, env: process.env }) + '\\n');
}
if (args[0] === 'openclaw' && args[1] === 'plugin-mode') {
  if (mode === 'fail') {
    console.error('boom: vault locked');
    process.exit(3);
  }
  if (mode === 'silent') {
    // Starts, never reports ready.
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
    return;
  }
  const sock = path.join(process.env.AQUAMAN_CONFIG_DIR, 'proxy.sock');
  const hostMap = process.env.AQUAMAN_FAKE_HOSTMAP ? JSON.parse(process.env.AQUAMAN_FAKE_HOSTMAP) : undefined;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/_health') return res.end(JSON.stringify({ status: 'ok', version: process.env.AQUAMAN_FAKE_VERSION || '0.0.1' }));
    if (req.url === '/_hostmap') return res.end(JSON.stringify(hostMap || {}));
    res.statusCode = 404;
    res.end('{}');
  });
  process.on('SIGTERM', () => {
    if (mode === 'stubborn') return; // ignores a polite stop
    try { fs.unlinkSync(sock); } catch {}
    process.exit(0);
  });
  server.listen(sock, () => {
    // Same order as the real command: a human log line first, the JSON after.
    console.log('Credential proxy listening on ' + sock);
    console.error('fake proxy: a line on stderr');
    console.log('{ this line looks like JSON and is not');
    console.log(JSON.stringify({ ready: false, note: 'not yet' }));
    console.log(JSON.stringify({ ready: true, socketPath: sock, services: ['anthropic', 'openai'], backend: process.env.AQUAMAN_BACKEND || 'none', hostMap }));
  });
} else {
  if (mode === 'hang') {
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
    return;
  }
  if (mode !== 'quiet') {
    process.stdout.write('ran: ' + args.join(' ') + '\\n');
    if (process.env.AQUAMAN_FAKE_STDERR) process.stderr.write(process.env.AQUAMAN_FAKE_STDERR + '\\n');
  }
  process.exit(Number(process.env.AQUAMAN_FAKE_EXIT || 0));
}
`;

export interface FakeProxy {
  /** Root of everything this fixture created. */
  base: string;
  /** Directory holding the fake `aquaman`; put it on PATH. */
  binDir: string;
  binary: string;
  /** A directory with no `aquaman` in it, for "not installed". */
  emptyDir: string;
  /** A PATH directory whose `aquaman` is a directory: passes the X_OK check, cannot be started. */
  brokenDir: string;
  /** Where the fake proxy binds its socket (AQUAMAN_CONFIG_DIR). */
  configDir: string;
  socketPath: string;
  logPath: string;
  /** One entry per invocation of the fake binary. */
  calls(): Array<{ pid: number; args: string[]; env: Record<string, string> }>;
  /** Resolves once every process the fake binary started has gone. */
  waitForExit(timeoutMs?: number): Promise<void>;
  cleanup(): void;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function createFakeProxy(): FakeProxy {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aqp-')));
  const binDir = path.join(base, 'bin');
  const emptyDir = path.join(base, 'empty');
  const brokenDir = path.join(base, 'broken');
  const configDir = path.join(base, 'cfg');
  for (const d of [binDir, emptyDir, configDir, path.join(brokenDir, 'aquaman')]) fs.mkdirSync(d, { recursive: true });
  const binary = path.join(binDir, 'aquaman');
  fs.writeFileSync(binary, SCRIPT, { mode: 0o755 });
  const logPath = path.join(base, 'calls.log');

  const calls = () =>
    fs.existsSync(logPath)
      ? fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];

  return {
    base, binDir, binary, emptyDir, brokenDir, configDir, logPath,
    socketPath: path.join(configDir, 'proxy.sock'),
    calls,
    async waitForExit(timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (calls().some((c) => isAlive(c.pid))) {
        if (Date.now() > deadline) {
          // Never leave a stray process behind a failed test.
          for (const c of calls()) if (isAlive(c.pid)) process.kill(c.pid, 'SIGKILL');
          throw new Error('fake proxy process still running');
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    cleanup() {
      for (const c of calls()) if (isAlive(c.pid)) process.kill(c.pid, 'SIGKILL');
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

/** Snapshot process.env; the returned function puts it back exactly. */
export function snapshotEnv(): () => void {
  const saved = { ...process.env };
  return () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) process.env[key] = value;
  };
}
