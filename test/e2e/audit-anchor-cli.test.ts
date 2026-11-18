/**
 * E2E: the audit anchor through the real CLI and real serving processes.
 *
 * `aquaman daemon`, `aquaman openclaw plugin-mode` and `aquaman openclaw
 * start` write the anchor to an encrypted-file vault in an isolated config
 * directory; `aquaman audit verify` reads it back and compares; `aquaman
 * audit accept` moves it, on a pseudo-terminal, after a typed yes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EncryptedFileStore } from '../../packages/proxy/src/core/credentials/store.js';
import { findPython3 } from '../helpers/cov-cli-hosts.js';
import { udsFetch } from '../helpers/uds-proxy.js';
import {
  createSandbox, startDaemon, stop, exited, waitFor, sleep, udsGet, fakeProxy, json,
  PASSWORD, PROXY_CLI, T, type Sandbox,
} from './cov-cli-core-helpers.js';

const TSX_CLI = path.resolve('node_modules/tsx/dist/cli.mjs');
const PTY_DRIVER = path.resolve('test/helpers/cov-cli-hosts-pty.py');
const python = findPython3();

describe('audit anchor: CLI and serving processes', () => {
  let sb: Sandbox;

  beforeEach(() => {
    sb = createSandbox();
    // One second between anchor writes, so a test can wait for one.
    sb.writeConfig('credentials:\n  backend: encrypted-file\n  proxiedServices: [anthropic]\naudit:\n  anchorIntervalSeconds: 1\n');
  });
  afterEach(async () => { await sb.cleanup(); });

  const logFile = () => path.join(sb.config, 'audit', 'current.jsonl');
  const vault = () => new EncryptedFileStore(PASSWORD, path.join(sb.config, 'credentials.enc'));
  const anchor = async (): Promise<{ v: number; seq: number; hash: string; at: string } | null> => {
    const raw = await vault().get('aquaman_internal', 'audit_anchor');
    return raw === null ? null : JSON.parse(raw);
  };
  const entries = (): Array<{ seq: number; hash: string; data: any }> =>
    fs.existsSync(logFile())
      ? fs.readFileSync(logFile(), 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
  const truncateTo = (count: number) =>
    fs.writeFileSync(logFile(), fs.readFileSync(logFile(), 'utf-8').trim().split('\n').slice(0, count).join('\n') + '\n');

  /** One audited request: a broker read of a reference nobody declared is refused and recorded. */
  const refusedRead = () =>
    udsFetch(sb.socket, '/broker/resolve', { method: 'POST', body: JSON.stringify({ service: 'github', key: 'token' }) });

  async function waitForAnchor(seq: number, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await anchor())?.seq === seq) return;
      await sleep(200);
    }
    throw new Error(`anchor never reached sequence ${seq}; it is ${JSON.stringify(await anchor())}`);
  }

  /** A daemon run that leaves `count` entries behind, anchored at shutdown. */
  async function loggedAndAnchored(count: number, endsAt = count): Promise<void> {
    const { child } = await startDaemon(sb);
    for (let i = 0; i < count; i++) await refusedRead();
    await stop(child);
    expect((await anchor())?.seq).toBe(endsAt);
  }

  /** Run the CLI with a terminal on stdin and stdout, typing each answer once its prompt shows. */
  function onTerminal(args: string[], answers: Array<[prompt: string, keys: string]>): Promise<{ output: string; code: number | null }> {
    const spec = path.join(sb.root, `pty-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(spec, JSON.stringify({ argv: [process.execPath, TSX_CLI, PROXY_CLI, ...args], answers, timeout: 60 }));
    return new Promise((resolve, reject) => {
      const proc = spawn(python!, [PTY_DRIVER, spec], { stdio: ['ignore', 'pipe', 'pipe'], env: sb.env({ TERM: 'dumb' }), cwd: sb.project });
      let out = '';
      let err = '';
      proc.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
      proc.stderr!.on('data', (d: Buffer) => { err += d.toString(); });
      proc.on('close', () => {
        try { resolve(JSON.parse(out)); } catch { reject(new Error(`pty driver failed: ${err || out}`)); }
      });
    });
  }

  describe('the daemon writes the anchor', () => {
    it('once per interval for a burst, again at shutdown, and audit verify then matches it', async () => {
      const { child, output } = await startDaemon(sb);
      expect(await anchor()).toBeNull();

      for (let i = 0; i < 5; i++) expect((await refusedRead()).status).toBe(404);
      await waitForAnchor(5);
      expect(await anchor()).toMatchObject({ v: 1, seq: 5, hash: entries()[4].hash });

      // Two more, then a graceful stop before the interval has passed.
      await refusedRead();
      await refusedRead();
      await stop(child);
      expect(await exited(child)).toBe(0);
      expect(await anchor()).toMatchObject({ seq: 7, hash: entries()[6].hash });
      expect(output()).not.toContain('AUDIT FAILURE');

      const ok = await sb.run(['audit', 'verify']);
      expect(ok.code).toBe(0);
      expect(ok.stdout).toContain('Audit log integrity verified');
      expect(ok.stdout).toContain('  Entries: 7');
      expect(ok.stdout).toContain('  Sequence: 1 to 7');
      expect(ok.stdout).toMatch(/ {2}Anchor: the anchor matches the entry at sequence 7 \(written [^)]+\); 0 entries since the last anchor, not yet anchored/);

      const asJson = await sb.run(['audit', 'verify', '--json']);
      expect(asJson.code).toBe(0);
      expect(JSON.parse(asJson.stdout)).toMatchObject({
        valid: true,
        chain: { valid: true, errors: [], entries: 7, last_seq: 7, last_hash: entries()[6].hash, verified_from: 1 },
        anchor: { status: 'matches', seq: 7, unanchored: 0 },
      });

      // The anchor is not a credential: it is not listed.
      const listed = await sb.run(['credentials', 'list']);
      expect(listed.stdout.trim()).toBe('No credentials stored.');
    }, T * 2);

    it('an idle daemon writes nothing to the vault', async () => {
      const { child } = await startDaemon(sb);
      await sleep(2500);
      await stop(child);
      expect(fs.existsSync(path.join(sb.config, 'credentials.enc'))).toBe(false);
    }, T);

    it('anchorIntervalSeconds: 0 turns it off, and audit verify says so', async () => {
      sb.writeConfig('credentials:\n  backend: encrypted-file\naudit:\n  anchorIntervalSeconds: 0\n');
      const { child } = await startDaemon(sb);
      await refusedRead();
      await sleep(1500);
      await stop(child);
      expect(fs.existsSync(path.join(sb.config, 'credentials.enc'))).toBe(false);

      const r = await sb.run(['audit', 'verify']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Audit log integrity verified');
      expect(r.stdout).toContain('Anchor: anchoring is off (audit.anchorIntervalSeconds: 0 or audit.enabled: false)');
    }, T);

    it('a log that is behind its anchor at start is reported on stderr, the daemon serves anyway, and the anchor is not lowered', async () => {
      await loggedAndAnchored(6);
      truncateTo(2);

      const { child, output } = await startDaemon(sb);
      await waitFor(child, () => output().includes('AUDIT FAILURE'), 20_000).catch(() => undefined);
      expect(output()).toContain('AUDIT FAILURE: the audit log is behind its anchor: the log is truncated: it ends at sequence 2');
      expect(output()).toContain('Run: aquaman audit verify.');
      expect(output()).toContain('stop the proxy and run: aquaman audit accept');

      expect((await udsGet(sb.socket, '/_health')).status).toBe(200);
      for (let i = 0; i < 6; i++) expect((await refusedRead()).status).toBe(404);
      await sleep(1800);
      await stop(child);
      expect(entries()).toHaveLength(8);
      // Past the anchored sequence now, and still the old anchor.
      expect((await anchor())?.seq).toBe(6);
      const r = await sb.run(['audit', 'verify']);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('- Anchor: the log was rebuilt: its entry at sequence 6 is not the one the anchor');
    }, T * 2);

    it('a vault that cannot be written is reported as AUDIT FAILURE, the daemon keeps serving, and the write is retried', async () => {
      const { child, output } = await startDaemon(sb);
      await refusedRead();
      await waitForAnchor(1);
      // The vault's directory entry cannot be replaced while the config dir is read-only.
      fs.chmodSync(sb.config, 0o500);
      try {
        // The audit directory is a separate directory and stays writable.
        expect((await refusedRead()).status).toBe(404);
        await waitFor(child, () => output().includes('AUDIT FAILURE'), 20_000).catch(() => undefined);
        expect(output()).toContain('AUDIT FAILURE: could not write the audit anchor to the credential store:');
        expect(output()).toContain('entries after sequence 1 are not anchored yet. It is tried again in 1 seconds.');
        expect((await udsGet(sb.socket, '/_health')).status).toBe(200);
        expect((await refusedRead()).status).toBe(404);
      } finally {
        fs.chmodSync(sb.config, 0o700);
      }
      await waitForAnchor(3);
      await stop(child);
    }, T * 2);
  });

  describe('OpenClaw-hosted proxies write it too', () => {
    it('plugin-mode anchors at shutdown', async () => {
      const child = sb.track(sb.spawnCli(['openclaw', 'plugin-mode']));
      await waitFor(child, (text) => text.includes('"ready":true'));
      // No credential stored: the request is refused with 401 and recorded.
      expect((await udsGet(sb.socket, '/anthropic/v1/messages')).status).toBe(401);
      await stop(child);
      expect(await anchor()).toMatchObject({ seq: 1, hash: entries()[0].hash });
    }, T);

    it('openclaw start --no-launch anchors at shutdown', async () => {
      const child = sb.track(sb.spawnCli(['openclaw', 'start', '--no-launch']));
      await waitFor(child, async (text) => {
        if (!text.includes('Press Ctrl+C')) return false;
        try { return (await udsGet(sb.socket, '/_health')).status === 200; } catch { return false; }
      });
      expect((await udsGet(sb.socket, '/anthropic/v1/messages')).status).toBe(401);
      expect((await udsGet(sb.socket, '/anthropic/v1/models')).status).toBe(401);
      await stop(child);
      expect(await anchor()).toMatchObject({ seq: 2, hash: entries()[1].hash });
    }, T);

    it('openclaw start anchors when OpenClaw exits', async () => {
      sb.installBin('openclaw', [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "openclaw 2026.9.37"; exit 0; fi',
        `/usr/bin/curl -s -o /dev/null --unix-socket "${sb.socket}" http://localhost/anthropic/v1/messages`,
        'exit 0',
        '',
      ].join('\n'));
      const r = await sb.run(['openclaw', 'start']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('OpenClaw exited with code 0');
      expect(entries()).toHaveLength(1);
      expect(await anchor()).toMatchObject({ seq: 1, hash: entries()[0].hash });
    }, T);
  });

  describe('audit verify', () => {
    it('passes as "not anchored yet" with no log and no anchor, and for a log no process has anchored', async () => {
      const none = await sb.run(['audit', 'verify']);
      expect(none.code).toBe(0);
      expect(none.stdout).toContain('Audit log integrity verified');
      expect(none.stdout).toContain('  Entries: 0');
      expect(none.stdout).toContain('Anchor: not anchored yet: the credential store holds no anchor for this log.');
      expect(none.stdout).not.toContain('Sequence:');

      const asJson = JSON.parse((await sb.run(['audit', 'verify', '--json'])).stdout);
      expect(asJson).toMatchObject({ valid: true, chain: { entries: 0, last_seq: 0, verified_from: null }, anchor: { status: 'not_anchored' } });
      expect(asJson.fix).toBeUndefined();
    }, T * 2);

    it.each([
      ['truncated', () => truncateTo(3), 'the log is truncated: it ends at sequence 3, and the anchor'],
      ['missing (emptied)', () => fs.writeFileSync(logFile(), ''), 'the log is missing or empty, and the anchor'],
      ['missing (deleted)', () => fs.rmSync(path.join(sb.config, 'audit'), { recursive: true }), 'the log is missing or empty, and the anchor'],
    ])('fails with exit 1 and names what it found: %s', async (name, tamper, text) => {
      await loggedAndAnchored(5);
      tamper();

      const r = await sb.run(['audit', 'verify']);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('Audit log integrity FAILED');
      expect(r.stdout).toContain(`  - Anchor: ${text}`);
      expect(r.stdout).toContain('records an entry at sequence 5');
      expect(r.stdout).toContain('  → If you did not change the log');
      expect(r.stdout).toContain('stop the proxy and run: aquaman audit accept');
      expect(r.stdout).not.toContain('integrity verified');

      const asJson = await sb.run(['audit', 'verify', '--json']);
      expect(asJson.code).toBe(1);
      const parsed = JSON.parse(asJson.stdout);
      expect(parsed.valid).toBe(false);
      expect(parsed.chain.valid).toBe(true);
      expect(parsed.anchor).toMatchObject({ status: name.split(' ')[0], seq: 5 });
      expect(parsed.fix).toContain('aquaman audit accept');

      // The chain alone has nothing to say about it, and says that the anchor was not looked at.
      const chainOnly = await sb.run(['audit', 'verify', '--chain-only']);
      expect(chainOnly.code).toBe(0);
      expect(chainOnly.stdout).toContain('Audit log integrity verified');
      expect(chainOnly.stdout).toContain('Anchor: the anchor was not checked (--chain-only)');
    }, T * 3);

    it('a broken chain fails with --chain-only too, and the anchor line is not listed as a failure when it matches', async () => {
      await loggedAndAnchored(3);
      fs.writeFileSync(logFile(), fs.readFileSync(logFile(), 'utf-8').replace('"github"', '"gitlab"'));
      const r = await sb.run(['audit', 'verify']);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('Audit log integrity FAILED');
      expect(r.stdout).toMatch(/ {2}- Entry 0: hash mismatch/);
      expect(r.stdout).toMatch(/\n {2}Anchor: the anchor matches the entry at sequence 3/);
      expect(r.stdout).not.toContain('→');

      const chainOnly = await sb.run(['audit', 'verify', '--chain-only', '--json']);
      expect(chainOnly.code).toBe(1);
      expect(JSON.parse(chainOnly.stdout)).toMatchObject({ valid: false, chain: { valid: false }, anchor: { status: 'not_checked' } });
    }, T * 2);

    it('reports "verified from sequence N" when earlier archives are gone', async () => {
      await loggedAndAnchored(3);
      const rotated = await sb.run(['audit', 'rotate']);
      const first = rotated.stdout.match(/Log rotated to: (.+)/)![1].trim();
      await loggedAndAnchored(5, 8);
      expect((await sb.run(['audit', 'rotate'])).code).toBe(0);
      fs.rmSync(first);

      const r = await sb.run(['audit', 'verify']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('  Entries: 0');
      expect(r.stdout).toContain('  Sequence: 4 to 8 (verified from sequence 4; earlier archives are not retained)');
      expect(r.stdout).toContain('Anchor: the anchor matches the entry at sequence 8');
    }, T * 3);

    it('a vault that cannot be read fails with exit 1, the reason and the fix; --chain-only checks the chain alone', async () => {
      await loggedAndAnchored(2);

      const noPassword = await sb.run(['audit', 'verify'], { env: { AQUAMAN_ENCRYPTION_PASSWORD: undefined } });
      expect(noPassword.code).toBe(1);
      expect(noPassword.stdout).toContain('Audit log not verified: the chain is intact, and the anchor could not be checked');
      expect(noPassword.stdout).toContain('- Anchor: the credential store could not be read, so the anchor was not checked: encryptionPassword required for encrypted-file backend');
      expect(noPassword.stdout).toContain('→ Unlock or sign in to the credential backend and run this again');
      expect(noPassword.stdout).toContain('aquaman audit verify --chain-only');
      expect(noPassword.stdout).not.toContain('integrity FAILED');

      const wrongPassword = await sb.run(['audit', 'verify', '--json'], { env: { AQUAMAN_ENCRYPTION_PASSWORD: 'not-the-password-of-this-vault-1' } });
      expect(wrongPassword.code).toBe(1);
      const parsed = JSON.parse(wrongPassword.stdout);
      expect(parsed).toMatchObject({ valid: false, chain: { valid: true }, anchor: { status: 'unreadable' } });
      expect(parsed.anchor.message).toContain('wrong password?');

      const chainOnly = await sb.run(['audit', 'verify', '--chain-only'], { env: { AQUAMAN_ENCRYPTION_PASSWORD: undefined } });
      expect(chainOnly.code).toBe(0);
      expect(chainOnly.stdout).toContain('Audit log integrity verified');
      expect(chainOnly.stdout).toContain('the anchor was not checked (--chain-only)');
    }, T * 3);
  });

  describe('audit accept', () => {
    it('refuses without a terminal and changes nothing', async () => {
      await loggedAndAnchored(4);
      truncateTo(2);
      const before = fs.readFileSync(logFile(), 'utf-8');

      const piped = await sb.run(['audit', 'accept'], { input: 'yes\n' });
      expect(piped.code).toBe(1);
      expect(piped.stderr).toContain('aquaman audit accept needs a terminal: a person has to confirm it.');
      expect(piped.stderr).toContain('Run it yourself in a terminal window: aquaman audit accept');
      expect(fs.readFileSync(logFile(), 'utf-8')).toBe(before);
      expect((await anchor())?.seq).toBe(4);
    }, T * 2);

    it.skipIf(!python)('with a terminal and a typed yes: records the reset, moves the anchor back, and verify passes again', async () => {
      await loggedAndAnchored(4);
      truncateTo(2);
      expect((await sb.run(['audit', 'verify'])).code).toBe(1);

      const r = await onTerminal(['audit', 'accept'], [['Type yes to accept: ', 'yes\r']]);
      expect(r.output).toContain('Anchor: the log is truncated: it ends at sequence 2');
      expect(r.output).toContain('The log now ends at sequence 2.');
      expect(r.output).toContain('Accepted. The anchor is at sequence 3 (was 4), and the reset is recorded in the log.');
      expect(r.code).toBe(0);

      const log = entries();
      expect(log).toHaveLength(3);
      expect(log[2]).toMatchObject({ seq: 3, data: { service: 'aquaman_internal', operation: 'rotate', success: true } });
      expect(await anchor()).toMatchObject({ seq: 3, hash: log[2].hash });

      const verified = await sb.run(['audit', 'verify']);
      expect(verified.code).toBe(0);
      expect(verified.stdout).toContain('Anchor: the anchor matches the entry at sequence 3');
      const tail = await sb.run(['audit', 'tail', '-n', '1']);
      expect(tail.stdout).toContain('aquaman_internal rotate OK (audit anchor reset by a person: was sequence 4, now sequence 3)');

      // A daemon started afterwards finds the log and the anchor in agreement and goes on anchoring.
      const { child, output } = await startDaemon(sb);
      await refusedRead();
      await stop(child);
      expect(output()).not.toContain('AUDIT FAILURE');
      expect((await anchor())?.seq).toBe(4);
    }, T * 3);

    it.skipIf(!python)('anything other than yes leaves the anchor and the log as they were', async () => {
      await loggedAndAnchored(4);
      truncateTo(2);
      const before = fs.readFileSync(logFile(), 'utf-8');
      for (const answer of ['no\r', 'y\r', '\r']) {
        const r = await onTerminal(['audit', 'accept'], [['Type yes to accept: ', answer]]);
        expect(r.code).toBe(1);
        expect(r.output).toContain('Not accepted. The anchor is unchanged.');
      }
      expect(fs.readFileSync(logFile(), 'utf-8')).toBe(before);
      expect((await anchor())?.seq).toBe(4);
    }, T * 3);

    it.skipIf(!python)('says there is nothing to accept when the anchor matches or does not exist, without asking', async () => {
      const none = await onTerminal(['audit', 'accept'], []);
      expect(none.code).toBe(0);
      expect(none.output).toContain('Nothing to accept. Anchor: not anchored yet');
      expect(none.output).not.toContain('Type yes');

      await loggedAndAnchored(2);
      const matches = await onTerminal(['audit', 'accept'], []);
      expect(matches.code).toBe(0);
      expect(matches.output).toContain('Nothing to accept. Anchor: the anchor matches the entry at sequence 2');
      expect(entries()).toHaveLength(2);
    }, T * 3);

    it.skipIf(!python)('refuses while a proxy is serving, and says to stop it', async () => {
      await loggedAndAnchored(3);
      truncateTo(1);
      const proxy = await fakeProxy(sb.socket, (_req, res) => json(res, 200, { status: 'ok' }));
      try {
        const r = await onTerminal(['audit', 'accept'], []);
        expect(r.code).toBe(1);
        expect(r.output).toContain('A proxy is running and holds the audit log open.');
        expect(r.output).toContain('Stop it first (aquaman stop, or stop the OpenClaw gateway that started it), run aquaman audit accept, then start it again.');
        expect(r.output).not.toContain('Type yes');
      } finally {
        await proxy.close();
      }
      expect((await anchor())?.seq).toBe(3);
      expect(entries()).toHaveLength(1);
    }, T * 2);

    it.skipIf(!python)('refuses a broken chain before asking, and a vault it cannot open', async () => {
      await loggedAndAnchored(3);
      truncateTo(2);
      fs.writeFileSync(logFile(), fs.readFileSync(logFile(), 'utf-8').replace('"github"', '"gitlab"'));
      const broken = await onTerminal(['audit', 'accept'], []);
      expect(broken.code).toBe(1);
      expect(broken.output).toContain('Not accepted: the chain itself is broken (Entry 0: hash mismatch');
      expect(broken.output).toContain('mv ~/.aquaman/audit ~/.aquaman/audit.broken');
      expect(broken.output).not.toContain('Type yes');
      expect((await anchor())?.seq).toBe(3);

      // Moved aside as the message says: a new log starts and the anchor goes to sequence 1.
      fs.renameSync(path.join(sb.config, 'audit'), path.join(sb.config, 'audit.broken'));
      const fresh = await onTerminal(['audit', 'accept'], [['Type yes to accept: ', 'yes\r']]);
      expect(fresh.code).toBe(0);
      expect(fresh.output).toContain('Accepted. The anchor is at sequence 1 (was 3)');
      expect((await sb.run(['audit', 'verify'])).code).toBe(0);
    }, T * 3);

    it.skipIf(!python)('stops with the reason when the vault cannot be opened or read, or holds something that is not an anchor', async () => {
      await loggedAndAnchored(3);
      truncateTo(1);
      const spec = (env: Record<string, string | undefined>) => {
        const original = sb.env;
        sb.env = (extra = {}) => original({ ...env, ...extra });
        return () => { sb.env = original; };
      };

      let restore = spec({ AQUAMAN_ENCRYPTION_PASSWORD: undefined });
      const closed = await onTerminal(['audit', 'accept'], []);
      restore();
      expect(closed.code).toBe(1);
      expect(closed.output).toContain('Credential store not available: encryptionPassword required for encrypted-file backend');
      expect(closed.output).toContain('Run: aquaman doctor');

      restore = spec({ AQUAMAN_ENCRYPTION_PASSWORD: 'not-the-password-of-this-vault-1' });
      const locked = await onTerminal(['audit', 'accept'], []);
      restore();
      expect(locked.code).toBe(1);
      expect(locked.output).toContain('Anchor: the credential store could not be read, so the anchor was not checked:');
      expect(locked.output).toContain('aquaman audit verify --chain-only');
      expect((await anchor())?.seq).toBe(3);

      // A value that is not an anchor is replaced once a person accepts.
      await vault().set('aquaman_internal', 'audit_anchor', 'tampered');
      const malformed = await onTerminal(['audit', 'accept'], [['Type yes to accept: ', 'yes\r']]);
      expect(malformed.code).toBe(0);
      expect(malformed.output).toContain('Anchor: the value stored at aquaman_internal/audit_anchor is not an audit anchor');
      expect(malformed.output).toContain('Accepted. The anchor is at sequence 2 (was unreadable)');
      expect((await anchor())?.seq).toBe(2);
    }, T * 3);
  });

  describe('the reserved service at the CLI', () => {
    it.each(['aquaman_internal', 'aquaman-internal', 'aquaman.internal'])(
      'credentials add and delete refuse %s before touching the vault, and broker allow refuses to declare it',
      async (service) => {
        await loggedAndAnchored(1);
        const before = await anchor();

        const add = await sb.run(['credentials', 'add', service, 'audit_anchor'], { input: '{"v":1,"seq":1}\n' });
        expect(add.code).toBe(1);
        expect(add.stderr).toContain(`"${service}" is reserved for aquaman's own records and cannot be used as a credential.`);
        expect(add.stderr).toContain('aquaman audit verify');
        expect(add.stdout).not.toContain('Credential stored');

        const del = await sb.run(['credentials', 'delete', service, 'audit_anchor']);
        expect(del.code).toBe(1);
        expect(del.stderr).toContain(`"${service}" is reserved`);
        expect(del.stdout).not.toContain('Credential deleted');
        expect(await anchor()).toEqual(before);

        const allow = await sb.run(['broker', 'allow', 'aquaman://github/token', `aquaman://${service}/audit_anchor`]);
        expect(allow.code).toBe(1);
        expect(allow.stderr).toContain(`Not declared: aquaman://${service}/audit_anchor. "${service}" is reserved for aquaman's own records`);
        // Nothing from the same command was declared either.
        const config = fs.readFileSync(path.join(sb.config, 'config.yaml'), 'utf-8');
        expect(config).not.toContain('allowedRefs');
      },
      T * 2,
    );

    it('doctor and status do not count the anchor as a stored credential', async () => {
      await loggedAndAnchored(1);
      expect(await vault().list()).toEqual([{ service: 'aquaman_internal', key: 'audit_anchor' }]);

      const doctor = await sb.run(['doctor']);
      expect(doctor.stdout).toContain('encrypted-file backend (0 credentials)');
      expect(doctor.stdout).not.toContain('aquaman_internal');

      const deep = await sb.run(['openclaw', 'doctor']);
      expect(deep.stdout).toContain('Stored securely: none');
      expect(deep.stdout).not.toContain('aquaman_internal');

      const status = await sb.run(['openclaw', 'status']);
      expect(status.stdout).toContain('Stored credentials: 0');
    }, T * 2);

    it('credentials list hides the anchor and shows what is beside it; get and request are refused by the daemon', async () => {
      expect((await sb.run(['credentials', 'add', 'github', 'token'], { input: 'ghp_anchor_cli_value\n' })).code).toBe(0);
      const { child } = await startDaemon(sb);
      await refusedRead();
      await waitForAnchor(1);

      const listed = await sb.run(['credentials', 'list']);
      expect(listed.stdout).toContain('  github/token');
      expect(listed.stdout).not.toContain('aquaman_internal');

      const hash = (await anchor())!.hash;
      const got = await sb.run(['get', 'aquaman://aquaman_internal/audit_anchor']);
      expect(got.code).toBe(1);
      expect(got.stdout).toBe('');
      expect(got.stderr).toContain('is reserved for aquaman\'s own records');
      expect(got.stderr).not.toContain(hash);

      const requested = await sb.run(['request', 'aquaman://aquaman_internal/audit_anchor', '--json']);
      expect(requested.code).not.toBe(0);
      expect(requested.stdout + requested.stderr).toContain('reserved');
      expect(requested.stdout + requested.stderr).not.toContain(hash);
      await stop(child);
    }, T * 2);
  });
});
