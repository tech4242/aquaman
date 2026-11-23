/**
 * `aquaman unlock` and `aquaman lock` end to end: the real CLI and a real
 * `aquaman daemon`, each a process of its own, in a private HOME and config
 * directory, with a private PATH that holds a stand-in `bw` and nothing else
 * (test/helpers/fake-bw.ts). The real Bitwarden CLI is never run.
 *
 * `aquaman unlock` needs a terminal, so the rows that go through with it run
 * on a pseudo-terminal: `output` is what a person would have seen on screen.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createSandbox, runCli, runCliOnTty, startCli, waitForOutput, waitForExit, findPython3, type Sandbox,
} from '../helpers/cov-cli-hosts.js';
import { freePort } from './cov-cli-core-helpers.js';
import { udsFetch } from '../helpers/uds-proxy.js';
import { FAKE_BW_SCRIPT, fakeSession } from '../helpers/fake-bw.js';

const T = 180_000;
const MASTER = 'correct horse battery staple';
const SESSION = fakeSession('e2e-first-session');
const SECOND = fakeSession('e2e-second-session');
const WRONG = fakeSession('e2e-not-accepted');
const VALUE = 'ghp_e2e_value_from_the_fake_vault_0123';
const LOOPBACK_TOKEN = 'aqm_lb_cli_unlock_e2e_0123456789abcdef';
const REF = 'aquaman://github/token';
const ENTER = '\r';

describe('aquaman unlock (e2e, fake bw)', () => {
  let sb: Sandbox;
  let bwDir: string;
  let port: number;
  let daemon: ChildProcess | undefined;
  let daemonOutput: string;

  beforeEach(async () => {
    sb = createSandbox();
    bwDir = path.join(sb.root, 'bw-state');
    fs.mkdirSync(bwDir);
    fs.writeFileSync(path.join(bwDir, 'loggedin'), '');
    fs.writeFileSync(path.join(bwDir, 'calls'), '');
    sb.fakeBin('bw', FAKE_BW_SCRIPT);
    Object.assign(sb.env, {
      FAKE_BW_DIR: bwDir,
      FAKE_BW_MASTER: MASTER,
      FAKE_BW_NEW_SESSION: SESSION,
      FAKE_BW_ITEM_VALUE: VALUE,
    });
    delete sb.env['AQUAMAN_ENCRYPTION_PASSWORD'];
    port = await freePort();
    daemon = undefined;
    daemonOutput = '';
  });

  afterEach(async () => {
    if (daemon && daemon.exitCode === null) {
      daemon.kill('SIGTERM');
      await waitForExit(daemon);
    }
    sb.cleanup();
  });

  const socket = () => path.join(sb.configDir, 'proxy.sock');
  const auditDir = () => path.join(sb.configDir, 'audit');

  function writeConfig(backend = 'bitwarden'): void {
    sb.writeConfig([
      'credentials:',
      `  backend: ${backend}`,
      // No cache, so each read reaches the stand-in and a session that ended is seen at once.
      '  cacheTtlSeconds: 0',
      '  proxiedServices:',
      '    - github',
      'broker:',
      '  allowedRefs:',
      `    - ${REF}`,
      'loopback:',
      '  enabled: true',
      `  port: ${port}`,
      `  token: ${LOOPBACK_TOKEN}`,
      'audit:',
      '  enabled: true',
      `  logDir: ${auditDir()}`,
      '  anchorIntervalSeconds: 0',
    ]);
  }

  async function startDaemon(): Promise<void> {
    daemon = startCli(sb, ['daemon']);
    daemon.stdout!.on('data', (d: Buffer) => { daemonOutput += d.toString(); });
    daemon.stderr!.on('data', (d: Buffer) => { daemonOutput += d.toString(); });
    await waitForOutput(daemon, 'Press Ctrl+C to stop');
  }

  const health = async () => JSON.parse((await udsFetch(socket(), '/_health')).body) as { vault?: string };
  const get = () => runCli(sb, ['get', REF]);
  const bwCalls = () => fs.readFileSync(path.join(bwDir, 'calls'), 'utf-8');
  const unlockOnTty = (typed: string | null, env: Record<string, string> = {}) =>
    runCliOnTty(sb, ['unlock'], typed === null ? [] : [['Master password:', `${typed}${ENTER}`]], { env, timeoutMs: 90_000 });
  /** Every file under the config directory and the home directory, as text. */
  const everythingOnDisk = (): string => {
    let all = '';
    for (const root of [sb.configDir, sb.home]) {
      for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        all += fs.readFileSync(path.join(entry.parentPath, entry.name), 'latin1') + '\n';
      }
    }
    return all;
  };

  it.skipIf(!findPython3())('a daemon that started locked is unlocked by a person at a terminal; the session is never shown, passed as an argument or written anywhere', async () => {
    writeConfig();
    await startDaemon();

    // Started and serving, with the vault locked.
    expect(daemonOutput).toContain('Vault: locked');
    expect(await health()).toMatchObject({ vault: 'locked' });
    const locked = await get();
    expect(locked.code).not.toBe(0);
    expect(locked.stdout).toBe('');
    expect(locked.stderr).toContain('vault is locked');
    expect(locked.stderr).toContain('aquaman unlock');
    const status = await runCli(sb, ['status']);
    expect(status.stdout).toContain('Vault: locked');
    expect(status.stdout).toContain('aquaman unlock');
    const doctor = await runCli(sb, ['doctor']);
    expect(doctor.code).toBe(1);
    expect(doctor.stdout).toContain('The daemon\'s vault is locked');
    expect(doctor.stdout).toContain('Run in a terminal: aquaman unlock');
    expect(doctor.stdout).not.toContain('Run: aquaman setup');

    // Without a terminal: a fix, and bw is not asked to unlock.
    const noTty = await runCli(sb, ['unlock']);
    expect(noTty.code).toBe(1);
    expect(noTty.stderr).toContain('needs a terminal');
    expect(noTty.stdout).toBe('');
    expect(bwCalls()).not.toContain('unlock');

    // A wrong master password: bw says so itself, exit 2, still locked.
    const wrong = await unlockOnTty('not the password');
    expect(wrong.code, wrong.output).toBe(2);
    expect(wrong.output).toContain('Invalid master password.');
    expect(wrong.output).toContain('the daemon stays locked');
    expect(await health()).toMatchObject({ vault: 'locked' });

    // The right one.
    const unlocked = await unlockOnTty(MASTER);
    expect(unlocked.code, unlocked.output).toBe(0);
    expect(unlocked.output).toContain('Bitwarden will ask for your master password. aquaman does not see it.');
    expect(unlocked.output).toContain('Unlocked.');
    expect(await health()).toMatchObject({ vault: 'unlocked' });

    const resolved = await get();
    expect(resolved.code, resolved.stderr).toBe(0);
    expect(resolved.stdout).toBe(VALUE);
    expect((await runCli(sb, ['status'])).stdout).toContain('Vault: unlocked');
    const healthy = await runCli(sb, ['doctor']);
    expect(healthy.stdout).toContain('The daemon\'s vault is unlocked');

    // Nothing a person or another program could look at holds the session.
    expect(unlocked.output).not.toContain(SESSION);
    expect(bwCalls()).toContain('unlock --raw');
    expect(bwCalls()).not.toContain(SESSION);
    expect(daemonOutput).not.toContain(SESSION);
    expect(everythingOnDisk()).not.toContain(SESSION);
    // The hand-over is in the audit log, as a change of state without a value.
    expect(fs.existsSync(auditDir())).toBe(true);
    expect(everythingOnDisk()).toContain('aquaman-vault');

    // Asking again: nothing to do, and no password prompt.
    const again = await unlockOnTty(null);
    expect(again.code, again.output).toBe(0);
    expect(again.output).toContain('already unlocked');
    expect(again.output).not.toContain('Master password');
  }, T);

  it('a session bw does not accept is refused, and the endpoint is refused on the loopback listener, with either a valid or a wrong session', async () => {
    writeConfig();
    await startDaemon();
    // What `bw unlock` would have produced: the stand-in accepts SESSION from here on.
    fs.writeFileSync(path.join(bwDir, 'session'), `${SESSION}\n`);
    const body = (session: string) => JSON.stringify({ session });
    const json = { 'Content-Type': 'application/json' };

    const refused = await udsFetch(socket(), '/_vault/unlock', { method: 'POST', headers: json, body: body(WRONG) });
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.body)).toMatchObject({ code: 'session_refused', fix: 'Run: aquaman unlock' });
    expect(refused.body).not.toContain(WRONG);
    expect(await health()).toMatchObject({ vault: 'locked' });

    for (const [session, headers, status] of [
      [SESSION, { 'x-aquaman-token': LOOPBACK_TOKEN }, 404],
      [WRONG, { 'x-aquaman-token': LOOPBACK_TOKEN }, 404],
      [SESSION, {}, 401],
      [SESSION, { Authorization: `Bearer ${SESSION}` }, 401],
    ] as Array<[string, Record<string, string>, number]>) {
      const res = await fetch(`http://127.0.0.1:${port}/_vault/unlock`, { method: 'POST', headers: { ...json, ...headers }, body: body(session) });
      const text = await res.text();
      expect(res.status, text).toBe(status);
      if (status === 404) expect(JSON.parse(text).code).toBe('vault_unlock_socket_only');
      expect(text).not.toContain(session);
    }
    const lock = await fetch(`http://127.0.0.1:${port}/_vault/lock`, { method: 'POST', headers: { ...json, 'x-aquaman-token': LOOPBACK_TOKEN }, body: '{}' });
    expect(lock.status).toBe(404);
    expect(await health()).toMatchObject({ vault: 'locked' });
    // The loopback health check does not say whether the vault is locked.
    expect(await (await fetch(`http://127.0.0.1:${port}/_health`)).json()).not.toHaveProperty('vault');

    // The same valid session over the socket is taken.
    const taken = await udsFetch(socket(), '/_vault/unlock', { method: 'POST', headers: json, body: body(SESSION) });
    expect(taken.status).toBe(200);
    expect(taken.body).not.toContain(SESSION);
    expect((await get()).stdout).toBe(VALUE);
    expect(daemonOutput).not.toContain(SESSION);
    expect(daemonOutput).not.toContain(WRONG);
    expect(bwCalls()).not.toContain(SESSION);
    expect(bwCalls()).not.toContain(WRONG);
  }, T);

  it.skipIf(!findPython3())('a session ended by bw lock lands in vault_locked with the same fix; aquaman unlock opens it again, and aquaman lock closes it', async () => {
    writeConfig();
    await startDaemon();
    expect((await unlockOnTty(MASTER)).code).toBe(0);
    expect((await get()).stdout).toBe(VALUE);

    // `bw lock`, run by the person in some other terminal.
    fs.writeFileSync(path.join(bwDir, 'session'), '\n');
    const stale = await get();
    expect(stale.code).not.toBe(0);
    expect(stale.stderr).toContain('vault is locked');
    expect(stale.stderr).toContain('aquaman unlock');
    expect(await health()).toMatchObject({ vault: 'locked' });

    const reopened = await unlockOnTty(MASTER, { FAKE_BW_NEW_SESSION: SECOND });
    expect(reopened.code, reopened.output).toBe(0);
    expect(reopened.output).not.toContain(SECOND);
    expect((await get()).stdout).toBe(VALUE);

    const closed = await runCli(sb, ['lock']);
    expect(closed.code, closed.stderr).toBe(0);
    expect(closed.stderr).toContain('dropped its session');
    expect(closed.stderr).toContain('bw lock');
    expect(await health()).toMatchObject({ vault: 'locked' });
    expect((await get()).code).not.toBe(0);
    // bw was not told: the key still opens the vault for whoever else holds it.
    expect(bwCalls()).not.toMatch(/^lock/m);
    expect(fs.readFileSync(path.join(bwDir, 'session'), 'utf-8').trim()).toBe(SECOND);
    expect(daemonOutput).not.toContain(SECOND);
  }, T);

  it.skipIf(!findPython3())('a shell that already holds a session bw accepts hands it over without a password prompt', async () => {
    writeConfig();
    await startDaemon();
    fs.writeFileSync(path.join(bwDir, 'session'), `${SESSION}\n`);
    const r = await unlockOnTty(null, { BW_SESSION: SESSION });
    expect(r.code, r.output).toBe(0);
    expect(r.output).toContain('already unlocked in this shell');
    expect(r.output).not.toContain('Master password');
    expect(r.output).not.toContain(SESSION);
    expect(bwCalls()).not.toContain('unlock');
    expect((await get()).stdout).toBe(VALUE);
  }, T);

  it.skipIf(!findPython3())('bw not logged in, and bw not installed: each is a person\'s step, and the daemon stays up and locked', async () => {
    fs.rmSync(path.join(bwDir, 'loggedin'));
    writeConfig();
    await startDaemon();
    expect(await health()).toMatchObject({ vault: 'locked' });
    const loggedOut = await unlockOnTty(null);
    expect(loggedOut.code, loggedOut.output).toBe(1);
    expect(loggedOut.output).toContain('not logged in');
    expect(loggedOut.output).toContain('bw login');

    fs.rmSync(path.join(sb.bin, 'bw'));
    const missing = await unlockOnTty(null);
    expect(missing.code, missing.output).toBe(1);
    expect(missing.output).toContain('was not found on the PATH');
    expect(await health()).toMatchObject({ vault: 'locked' });
  }, T);

  it('with no daemon running nobody is asked for a password: exit 3 and how to start it', async () => {
    writeConfig();
    for (const command of ['unlock', 'lock']) {
      const r = await runCli(sb, [command]);
      expect(r.code, r.all).toBe(3);
      expect(r.stderr).toContain('daemon is not running');
      expect(r.stdout).toBe('');
    }
    expect((await runCli(sb, ['unlock'])).stderr).toContain('aquaman service install');
    expect(bwCalls()).toBe('');
  }, T);

  it('with another backend configured both commands say so and exit 1', async () => {
    writeConfig('encrypted-file');
    for (const command of ['unlock', 'lock']) {
      const r = await runCli(sb, [command], { env: { AQUAMAN_ENCRYPTION_PASSWORD: 'a-long-enough-test-password' } });
      expect(r.code, r.all).toBe(1);
      expect(r.stderr).toContain(`aquaman ${command} is for the bitwarden backend`);
      expect(r.stderr).toContain('The configured backend is encrypted-file');
    }
    expect(bwCalls()).toBe('');
  }, T);
});
