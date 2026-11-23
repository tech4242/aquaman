/**
 * E2E: a program that answers one line at a time and then waits runs under
 * `aquaman-coder exec`, which is how an agent host talks to a stdio MCP server.
 *
 * The host writes a request and reads until the reply's newline; it writes
 * nothing more until it has it. So each reply has to be written when the
 * server produces it, with the injected value still redacted, and the server
 * has to stop when the host stops the wrapper.
 *
 * The broker is a small HTTP server on the config dir's proxy.sock, in this
 * process; the "server" is a Node script written into the test directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { stringify as toYaml } from 'yaml';

const CLI_PATH = path.resolve('packages/coder/src/cli/index.ts');
const TSX = path.resolve('node_modules/tsx/dist/cli.mjs');
const T = 120_000;
const VALUE = 'stdio-server-value-with-no-known-shape-5512';

/** Replies to each JSON line on stdin with one JSON line, like an MCP server over stdio. */
const SERVER = `
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], String(process.pid));
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    const key = ['-----BEGIN PRIVATE KEY-----', 'TUlJRXZRSUJBREFOQmdrcWhraUc5dzBCQVFFRkFBU0NCS2N3Z2dTakFnRUFBb0lCQVFD', 'bm90IGEgcmVhbCBrZXksIG9ubHkgdGhlIHNoYXBlIG9mIG9uZQ==', '-----END PRIVATE KEY-----'].join('\\n');
    const result = msg.method === 'leak' ? { token: process.env.GITHUB_TOKEN }
      : msg.method === 'mention' ? { text: 'the file starts with -----BEGIN PRIVATE KEY----- but is cut off' }
      : msg.method === 'header' ? { text: '-----BEGIN PRIVATE KEY-----' }
      : msg.method === 'names' ? { text: 'set the header Authorization and the variable aws_secret_access_key' }
      : msg.method === 'key' ? { text: key }
      : { echo: msg.method, has: Boolean(process.env.GITHUB_TOKEN) };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  }
});
process.stdin.on('end', () => process.exit(0));
`;

describe('aquaman-coder exec around a stdio server', () => {
  let base: string;
  let cfg: string;
  let proj: string;
  let broker: http.Server;
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeEach(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aqx-')));
    cfg = path.join(base, 'a');
    proj = path.join(base, 'proj');
    for (const d of [path.join(base, 'h'), cfg, proj]) fs.mkdirSync(d);
    fs.writeFileSync(path.join(proj, 'server.cjs'), SERVER);
    fs.writeFileSync(path.join(cfg, 'projects.yaml'), toYaml({
      version: 1,
      projects: { app: { paths: [proj], env: { GITHUB_TOKEN: 'aquaman://github/token' } } },
    }));
    broker = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url === '/broker/resolve') res.end(JSON.stringify({ value: VALUE, expires_at: new Date(Date.now() + 60_000).toISOString() }));
        else res.end(JSON.stringify({ status: 'ok', version: '9.9.9' }));
      });
    });
    await new Promise<void>((r) => broker.listen(path.join(cfg, 'proxy.sock'), r));
  });

  afterEach(async () => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    child = null;
    await new Promise<void>((r) => broker.close(() => r()));
    fs.rmSync(base, { recursive: true, force: true });
  });

  function start(): { next: (within?: number) => Promise<string>; send: (msg: object) => void; exited: Promise<number | null> } {
    child = spawn(process.execPath, [TSX, CLI_PATH, 'exec', '--', process.execPath, path.join(proj, 'server.cjs'), path.join(base, 'server.pid')], {
      cwd: proj,
      env: { ...process.env, HOME: path.join(base, 'h'), AQUAMAN_CONFIG_DIR: cfg, PATH: '/usr/bin:/bin', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    let out = '';
    let waiting: (() => void) | null = null;
    child.stdout.on('data', (d) => { out += d; waiting?.(); });
    const exited = new Promise<number | null>((r) => child!.on('close', (code) => r(code)));
    /** The next complete line, or a rejection naming what had arrived when time ran out. */
    const next = (within = 30_000) => new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { waiting = null; reject(new Error(`no complete line within ${within} ms; received so far: ${JSON.stringify(out)}`)); }, within);
      const check = () => {
        const i = out.indexOf('\n');
        if (i < 0) return;
        clearTimeout(timer);
        waiting = null;
        const line = out.slice(0, i);
        out = out.slice(i + 1);
        resolve(line);
      };
      waiting = check;
      check();
    });
    return { next, send: (msg) => child!.stdin.write(JSON.stringify(msg) + '\n'), exited };
  }

  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it('each reply arrives whole while the server waits for the next request', async () => {
    const s = start();
    s.send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(JSON.parse(await s.next())).toEqual({ jsonrpc: '2.0', id: 1, result: { echo: 'initialize', has: true } });
    // Nothing else has been written to the server: the first reply did not need a second one to push it out.
    s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(JSON.parse(await s.next())).toEqual({ jsonrpc: '2.0', id: 2, result: { echo: 'tools/list', has: true } });
    child!.stdin.end();
    expect(await s.exited).toBe(0);
  }, T);

  it('a reply that contains the injected value is still redacted', async () => {
    const s = start();
    s.send({ jsonrpc: '2.0', id: 1, method: 'leak' });
    const line = await s.next();
    expect(line).not.toContain(VALUE);
    expect(JSON.parse(line)).toEqual({ jsonrpc: '2.0', id: 1, result: { token: '[REDACTED:injected-value]' } });
    child!.stdin.end();
    await s.exited;
  }, T);

  it('a reply that mentions a BEGIN line, or the name of a header or variable a secret follows, arrives when it is written, and so do the replies after it', async () => {
    const s = start();
    // Each reply is read before the next request is written, as a host does:
    // one that was held for more output would never come.
    s.send({ jsonrpc: '2.0', id: 1, method: 'mention' });
    expect(JSON.parse(await s.next())).toEqual({ jsonrpc: '2.0', id: 1, result: { text: 'the file starts with -----BEGIN PRIVATE KEY----- but is cut off' } });
    s.send({ jsonrpc: '2.0', id: 2, method: 'header' });
    expect(JSON.parse(await s.next())).toEqual({ jsonrpc: '2.0', id: 2, result: { text: '-----BEGIN PRIVATE KEY-----' } });
    s.send({ jsonrpc: '2.0', id: 3, method: 'names' });
    expect(JSON.parse(await s.next())).toEqual({ jsonrpc: '2.0', id: 3, result: { text: 'set the header Authorization and the variable aws_secret_access_key' } });
    s.send({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
    expect(JSON.parse(await s.next())).toEqual({ jsonrpc: '2.0', id: 4, result: { echo: 'tools/list', has: true } });
    child!.stdin.end();
    expect(await s.exited).toBe(0);
  }, T);

  it('a reply that carries a whole private key arrives when it is written, with the key redacted', async () => {
    const s = start();
    s.send({ jsonrpc: '2.0', id: 1, method: 'key' });
    const line = await s.next();
    expect(line).not.toContain('TUlJRXZRSUJBREFOQmdr');
    expect(JSON.parse(line)).toEqual({ jsonrpc: '2.0', id: 1, result: { text: '[REDACTED:private-key]' } });
    child!.stdin.end();
    await s.exited;
  }, T);

  it('stopping the wrapper stops the server', async () => {
    const s = start();
    s.send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    await s.next();
    const pid = Number(fs.readFileSync(path.join(base, 'server.pid'), 'utf-8'));
    expect(alive(pid)).toBe(true);
    child!.kill('SIGTERM');
    await s.exited;
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(false);
  }, T);
});
