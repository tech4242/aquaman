/**
 * E2E: the two places the proxy CLI behaves differently at a terminal.
 * `credentials add` reads the value without echoing it, and `get` refuses to
 * print a credential to a terminal unless told to.
 *
 * The terminal is a pseudo-terminal from the system's `script` command, so
 * `process.stdin.isTTY` and `process.stdout.isTTY` are true in the child.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EncryptedFileStore } from '../../packages/proxy/src/core/credentials/store.js';
import { createSandbox, fakeProxy, json, sleep, PROXY_CLI, TSX, PASSWORD, T, type FakeProxy, type Sandbox } from './cov-cli-core-helpers.js';

const SCRIPT = '/usr/bin/script';
// `script` wants a real pipe or a terminal on its stdin, so it is fed through `cat` by a shell.
const SCRIPT_CALL = process.platform === 'darwin'
  ? `cat | ${SCRIPT} -q /dev/null "$@"`
  : `cat | ${SCRIPT} -qec "$1" /dev/null`;
const hasScript = fs.existsSync(SCRIPT) && (process.platform === 'darwin' || process.platform === 'linux')
  && spawnSync('/bin/sh', ['-c', SCRIPT_CALL, 'sh', '/usr/bin/true'], { input: '', stdio: ['pipe', 'ignore', 'ignore'] }).status === 0;

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

describe.skipIf(!hasScript)('cli-core: at a terminal', () => {
  let sb: Sandbox;
  let proxy: FakeProxy | undefined;
  beforeEach(() => { sb = createSandbox(); proxy = undefined; });
  afterEach(async () => {
    await proxy?.close();
    await sb.cleanup();
  });

  /**
   * Runs the CLI on a pseudo-terminal. `typed` is sent once `after` has
   * appeared in the output, the way a person answers a prompt.
   */
  function runAtTerminal(args: string[], typed?: { after: string; keys: string }): Promise<{ code: number | null; output: string }> {
    const command = [TSX, PROXY_CLI, ...args];
    const scriptArgs = process.platform === 'darwin' ? command : [command.map(shellQuote).join(' ')];
    return new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', SCRIPT_CALL, 'sh', ...scriptArgs], { cwd: sb.project, env: sb.env(), stdio: ['pipe', 'pipe', 'pipe'] });
      if (!typed) child.stdin.end();
      let output = '';
      let sent = false;
      const onData = (d: Buffer) => {
        output += d.toString();
        if (typed && !sent && output.includes(typed.after)) {
          sent = true;
          // Raw mode is switched on right after the prompt is printed.
          void sleep(400).then(() => child.stdin.end(typed.keys));
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, output }));
    });
  }

  const vault = () => new EncryptedFileStore(PASSWORD, path.join(sb.config, 'credentials.enc'));

  it('credentials add reads a typed value without echoing it, and honours backspace', async () => {
    // "x", backspace, then the rest: the stored value has no "x".
    const r = await runAtTerminal(['credentials', 'add', 'github', 'token'], { after: 'input hidden', keys: 'ghp_ttx\x7fy_typed_value\r' });
    expect(r.output).toContain('Enter value for github/token (input hidden):');
    expect(r.output).toContain('Credential stored: github/token');
    expect(r.code).toBe(0);
    expect(r.output).not.toContain('ghp_tt');
    expect(r.output).not.toContain('typed_value');
    expect(await vault().get('github', 'token')).toBe('ghp_tty_typed_value');
  }, T);

  it('credentials add stops at Ctrl-C with exit 130 and stores nothing', async () => {
    const r = await runAtTerminal(['credentials', 'add', 'github', 'token'], { after: 'input hidden', keys: 'ghp_half\x03' });
    expect(r.code).toBe(130);
    expect(r.output).not.toContain('Credential stored');
    expect(await vault().list()).toEqual([]);
  }, T);

  it('credentials add rejects a bare Enter', async () => {
    const r = await runAtTerminal(['credentials', 'add', 'github', 'token'], { after: 'input hidden', keys: '\r' });
    expect(r.code).toBe(1);
    expect(r.output).toContain('Empty credential value rejected');
    expect(await vault().list()).toEqual([]);
  }, T);

  it('get refuses to print to a terminal without spending a read, and prints with a newline under --show', async () => {
    proxy = await fakeProxy(sb.socket, (_req, res) => json(res, 200, { value: 'ghp_shown_on_purpose_0123' }));

    const refused = await runAtTerminal(['get', 'aquaman://github/token']);
    expect(refused.code).toBe(1);
    expect(refused.output).toContain('Refusing to print a credential to a terminal.');
    expect(refused.output).toContain('To print it anyway, pass --show.');
    expect(refused.output).not.toContain('ghp_shown_on_purpose');
    expect(proxy.requests).toEqual([]);

    const shown = await runAtTerminal(['get', 'aquaman://github/token', '--show']);
    expect(shown.code).toBe(0);
    expect(shown.output).toMatch(/ghp_shown_on_purpose_0123\r?\n/);
    expect(proxy.requests).toHaveLength(1);
  }, T * 2);
});
