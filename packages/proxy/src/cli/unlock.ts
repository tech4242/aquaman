/**
 * `aquaman unlock` and `aquaman lock`. The logic is in vault-unlock.ts; this
 * file connects it to the real terminal, the real `bw` and the daemon's
 * socket, and sets the exit code.
 */

import type { Command } from 'commander';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { getConfigDir, loadConfig } from '../core/index.js';
import { runLock, runUnlock, type BwStatus, type ProxyReply, type UnlockDeps } from '../vault-unlock.js';

type ProxyPost = (socketPath: string, urlPath: string, body: Record<string, unknown>, timeoutMs: number) => Promise<ProxyReply>;

/** Longer than a `bw status` takes on a slow machine: the daemon checks the session before it answers. */
const POST_TIMEOUT_MS = 60_000;
/** A session is 88 characters; anything much longer is not one and is not kept. */
const STDOUT_MAX = 4096;

/** The first `bw` on the PATH, found without starting anything. */
function findBw(): string | null {
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'bw');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* next */ }
  }
  return null;
}

/** The environment for a `bw` this command starts: the session only where it is meant to go. */
function bwEnv(session: string | undefined, interactive: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['BW_SESSION'];
  delete env['BW_NOINTERACTION'];
  if (session) env['BW_SESSION'] = session;
  if (!interactive) env['BW_NOINTERACTION'] = 'true';
  return env;
}

function proxyVault(socketPath: string): Promise<{ reachable: boolean; vault?: string }> {
  return new Promise((resolve) => {
    const req = http.request({ socketPath, path: '/_health', method: 'GET', timeout: 3000 }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        try {
          const vault = JSON.parse(text).vault;
          resolve({ reachable: res.statusCode === 200, ...(typeof vault === 'string' ? { vault } : {}) });
        } catch {
          resolve({ reachable: false });
        }
      });
    });
    req.on('error', () => resolve({ reachable: false }));
    req.on('timeout', () => { req.destroy(); resolve({ reachable: false }); });
    req.end();
  });
}

function buildDeps(proxyPost: ProxyPost): UnlockDeps {
  const socketPath = path.join(getConfigDir(), 'proxy.sock');
  let bw: string | null | undefined;
  const bwPath = () => (bw === undefined ? (bw = findBw()) : bw);
  return {
    backend: loadConfig().credentials.backend,
    // `bw` reads the master password from stdin and asks for it on stderr.
    isTerminal: process.stdin.isTTY === true && process.stderr.isTTY === true,
    shellSession: process.env['BW_SESSION'] || undefined,
    bwInstalled: () => bwPath() !== null,
    bwStatus(session): BwStatus | null {
      const result = spawnSync(bwPath()!, ['status'], {
        encoding: 'utf-8',
        env: bwEnv(session, false),
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (result.status !== 0) return null;
      try {
        const status = JSON.parse(result.stdout).status;
        return status === 'unauthenticated' || status === 'locked' || status === 'unlocked' ? status : null;
      } catch {
        return null;
      }
    },
    bwUnlock() {
      return new Promise((resolve) => {
        // stdin and stderr are the terminal, so `bw` asks the person itself.
        // stdout is a pipe: the session is read here and never reaches the screen.
        const child = spawn(bwPath()!, ['unlock', '--raw'], {
          stdio: ['inherit', 'pipe', 'inherit'],
          env: bwEnv(undefined, true),
        });
        let stdout = '';
        child.stdout!.on('data', (chunk: Buffer) => {
          if (stdout.length < STDOUT_MAX) stdout += chunk.toString('utf-8');
        });
        child.on('error', () => resolve({ code: null, stdout: '' }));
        child.on('close', (code) => resolve({ code, stdout: stdout.length < STDOUT_MAX ? stdout : '' }));
      });
    },
    daemon: {
      health: () => proxyVault(socketPath),
      post: (urlPath, body) => proxyPost(socketPath, urlPath, body, POST_TIMEOUT_MS),
    },
    say: (line) => console.error(line),
  };
}

export function registerUnlockCommands(program: Command, proxyPost: ProxyPost): void {
  program
    .command('unlock')
    .description('Bitwarden backend: unlock the running daemon. Bitwarden asks for the master password in this terminal; the daemon keeps the session in memory')
    .addHelpText('after', `
For a person at a terminal, after logging in to the machine. Bitwarden's own
CLI (\`bw unlock\`) asks for the master password, so aquaman never sees it.
aquaman passes the session that comes out of it to the running daemon over
its Unix socket. The session is not printed, not put into any command's
arguments and not written to disk, the keychain or the login item.

Exit codes:
  0  the daemon's vault is unlocked (now, or it already was)
  1  cannot run here: another backend is configured, no terminal, bw is not installed or not logged in
  2  Bitwarden did not unlock the vault (wrong master password, cancelled)
  3  the daemon is not running; nobody was asked for a password
  4  the daemon refused the session`)
    .action(async () => {
      process.exit((await runUnlock(buildDeps(proxyPost))).exitCode);
    });

  program
    .command('lock')
    .description('Bitwarden backend: make the running daemon drop its session and its cached credential values')
    .addHelpText('after', `
The daemon forgets the session it was given and every credential value it had
cached; requests that need the vault answer vault_locked until the next
\`aquaman unlock\`. Bitwarden's CLI is not run: the session key stays valid for
anything else that holds a copy. To end it everywhere, run: bw lock

Exit codes:
  0  the daemon is locked
  1  another backend is configured
  3  the daemon is not running
  4  the daemon did not lock`)
    .action(async () => {
      process.exit((await runLock(buildDeps(proxyPost))).exitCode);
    });
}
