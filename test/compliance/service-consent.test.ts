/**
 * Conformance: aquaman adds a login item for its daemon only after a person
 * said yes, at a terminal or in a dialog the daemon shows.
 *
 * Each row tries to get the unit written without that yes. The CLI is the
 * real one, run as a child process in its own HOME; the daemon is a real
 * proxy in this process whose person is a scripted prompter. `launchctl` and
 * `systemctl` are never run: every row ends before the command would call one,
 * and the installer's behaviour after a yes is exercised with a fake runner.
 *
 * The limit, stated in the last row: this is not a boundary against software
 * running as the same user.
 *
 * NIST SP 800-53 AC-3 (access enforcement), CM-5 (access restrictions for
 * change), AU-2 (audit events); OWASP Agentic ASI09 (human in the loop).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createCredentialProxy,
  createBrokerScope,
  type CredentialProxy,
  type CredentialPrompter,
  type PromptResult,
  type RequestInfo,
} from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import { createSandbox, T, type Sandbox } from '../e2e/cov-cli-core-helpers.js';
import { installService, unitFilePath, type ServiceDeps } from '../../packages/proxy/src/service-unit.js';
import { SERVICE_CONSENT_PATH } from '../../packages/proxy/src/service-consent.js';

const LOOPBACK_TOKEN = 'aqm_lb_service_consent_conformance_0123456789';
/** A backend `install` accepts, by name only: nothing here opens a vault. */
const KEYCHAIN = { AQUAMAN_BACKEND: 'keychain', AQUAMAN_ENCRYPTION_PASSWORD: undefined };

const supported = process.platform === 'darwin'
  || (process.platform === 'linux' && ['/usr/bin/systemctl', '/bin/systemctl'].some((p) => fs.existsSync(p)));

describe.skipIf(!supported)('no login item without a person\'s yes', () => {
  let sb: Sandbox;
  let proxy: CredentialProxy | undefined;
  let asked: number;
  let log: RequestInfo[];

  beforeEach(() => { sb = createSandbox(); proxy = undefined; asked = 0; log = []; });
  afterEach(async () => {
    // The pid file names this process while the in-process daemon runs; it must be gone before the sandbox cleans up.
    fs.rmSync(path.join(sb.config, 'daemon.pid'), { force: true });
    if (proxy?.isRunning()) await proxy.stop();
    await sb.cleanup();
  });

  /** A real proxy on the sandbox's socket. The person answers `answer`; it is never a yes in a row that runs the CLI. */
  async function daemon(answer: PromptResult, opts: { loopback?: boolean } = {}): Promise<void> {
    const prompter: CredentialPrompter = {
      askValue: async () => ({ outcome: 'declined' }),
      askApproval: async () => ({ outcome: 'declined' }),
      askLoginItem: async () => { asked++; return answer; },
    };
    proxy = createCredentialProxy({
      socketPath: sb.socket,
      store: new MemoryStore(),
      allowedServices: [],
      broker: createBrokerScope({ configPath: '/nonexistent/config.yaml', projectsPath: '/nonexistent/projects.yaml' }),
      credentialRequests: { prompter, declare: () => {} },
      loopback: opts.loopback ? { port: 0, token: LOOPBACK_TOKEN, host: '127.0.0.1' } : undefined,
      onRequest: (info) => { log.push(info); },
    });
    await proxy.start();
    // What a daemon started by hand leaves: a pid file naming the process on the socket.
    fs.writeFileSync(path.join(sb.config, 'daemon.pid'), String(process.pid));
  }

  const unit = () => unitFilePath(process.platform, sb.home)!;
  const homeFiles = () => fs.readdirSync(sb.home, { recursive: true }).map(String).sort();
  const install = (args: string[] = [], env: Record<string, string | undefined> = {}, input?: string) =>
    sb.run(['service', 'install', '--json', ...args], { env: { ...KEYCHAIN, ...env }, input });

  it('no terminal and no daemon: nothing is written, and the answer is a step for a person', async () => {
    const r = await install();
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'pending', fix: 'Run in a terminal: aquaman service install' });
    expect(homeFiles()).toEqual([]);
  }, T);

  it.each([
    ['no dialog can be shown', { outcome: 'unavailable', reason: 'the daemon has no desktop session' } as PromptResult, 3, 'pending'],
    ['nobody answers the dialog', { outcome: 'timeout' } as PromptResult, 3, 'pending'],
    ['the person says no', { outcome: 'declined' } as PromptResult, 2, 'declined'],
    ['the dialog returns something that is not an approval', { outcome: 'entered', value: 'yes' } as PromptResult, 3, 'pending'],
  ])('no terminal, %s: nothing is written', async (_name, answer, code, status) => {
    await daemon(answer);
    const r = await install();
    expect(r.code, r.stdout + r.stderr).toBe(code);
    const out = JSON.parse(r.stdout);
    expect(out.status).toBe(status);
    if (status === 'declined') expect(out.fix).toBeUndefined();
    // The person was asked, by the daemon, exactly once.
    expect(asked).toBe(1);
    expect(homeFiles()).toEqual([]);
    expect(fs.existsSync(unit())).toBe(false);
    // The daemon that was running still is, and the outcome is in its audit trail.
    expect(proxy!.isRunning()).toBe(true);
    expect(log.filter((e) => e.path === SERVICE_CONSENT_PATH).map((e) => e.error)).toEqual([`${status}: login item`]);
  }, T);

  it('after a no, asking again does not reach the person, whoever asks', async () => {
    await daemon({ outcome: 'declined' });
    expect((await install()).code).toBe(2);
    expect((await install()).code).toBe(2);
    const patient = await sb.run(['service', 'install', '--json', '--timeout', '600'], { env: KEYCHAIN });
    expect(patient.code).toBe(2);
    expect(asked).toBe(1);
    expect(homeFiles()).toEqual([]);
  }, T * 2);

  // Each row starts the CLI with something that looks as if it might answer for the person.
  const ENV_SWITCHES: Record<string, string> = {
    AQUAMAN_YES: '1', AQUAMAN_ASSUME_YES: '1', AQUAMAN_AUTO_APPROVE: '1', AQUAMAN_APPROVE: 'true',
    AQUAMAN_SERVICE_CONSENT: 'approved', AQUAMAN_SERVICE_INSTALL: 'yes', AQUAMAN_CONSENT: 'approved',
    AQUAMAN_NON_INTERACTIVE: '1', AQUAMAN_NONINTERACTIVE: '1', AQUAMAN_SKIP_PROMPT: '1', AQUAMAN_NO_PROMPT: '1',
    AQUAMAN_PROMPTER: 'approve', AQUAMAN_PROMPT_ANSWER: 'approved', AQUAMAN_DIALOG: 'off', AQUAMAN_FORCE: '1',
    AQUAMAN_TEST: '1', AQUAMAN_E2E: '1', NODE_ENV: 'test', CI: 'true', DEBIAN_FRONTEND: 'noninteractive',
    YES: '1', FORCE: '1', ASSUME_YES: '1', NONINTERACTIVE: '1',
  };

  it('no environment variable answers for the person: with every likely one set and no daemon, nothing is written', async () => {
    const r = await install([], ENV_SWITCHES, 'y\nyes\n');
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stdout).status).toBe('pending');
    expect(homeFiles()).toEqual([]);
  }, T);

  it('no environment variable answers for the person: with every likely one set, the dialog is still what decides', async () => {
    await daemon({ outcome: 'declined' });
    const r = await install([], ENV_SWITCHES, 'y\nyes\n');
    expect(r.code).toBe(2);
    expect(asked).toBe(1);
    expect(homeFiles()).toEqual([]);
  }, T);

  it('the daemon takes no answer from its own environment either: the variables are set where it runs, and the prompter is still asked', async () => {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(ENV_SWITCHES)) { saved[k] = process.env[k]; process.env[k] = v; }
    try {
      await daemon({ outcome: 'declined' });
      const r = await install([], ENV_SWITCHES);
      expect(r.code).toBe(2);
      expect(asked).toBe(1);
      expect(homeFiles()).toEqual([]);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  }, T);

  it.each([
    ['--yes'], ['-y'], ['--force'], ['--assume-yes'], ['--non-interactive'], ['--no-prompt'], ['--approve'], ['--consent=approved'],
  ])('no flag answers for the person: %s is not an option, and nothing is written', async (flag) => {
    const r = await install([flag]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('unknown option');
    expect(homeFiles()).toEqual([]);
  }, T);

  it('a "y" on a stdin that is not a terminal answers nothing', async () => {
    const r = await install([], {}, 'y\n');
    expect(r.code).toBe(3);
    expect(homeFiles()).toEqual([]);
  }, T);

  describe('the consent endpoint cannot be reached from the loopback listener', () => {
    it.each([
      ['no token', {} as Record<string, string>],
      ['the agent hosts\' loopback token', { 'x-aquaman-token': LOOPBACK_TOKEN }],
      ['the loopback token as a bearer', { Authorization: `Bearer ${LOOPBACK_TOKEN}` }],
      ['the loopback token as an API key', { 'x-api-key': LOOPBACK_TOKEN }],
      ['a made-up route token', { Authorization: 'Bearer aqm_rt_000000000000000000000000000000000000000000000000' }],
      ['a Host header that claims to be local', { 'x-aquaman-token': LOOPBACK_TOKEN, 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': 'localhost' }],
    ])('%s: refused, and the person is never asked', async (_name, headers) => {
      await daemon({ outcome: 'approved' }, { loopback: true });
      const origin = `http://${proxy!.getLoopbackAddress()}`;
      for (const url of [SERVICE_CONSENT_PATH, `${SERVICE_CONSENT_PATH}/`, `${SERVICE_CONSENT_PATH}?x=1`, '/_service/../_service/consent', '/%5Fservice/consent']) {
        const res = await fetch(`${origin}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
        expect(res.status, url).toBeGreaterThanOrEqual(400);
        // An error body, never an answer to the question.
        expect(await res.text(), url).not.toContain('"status"');
      }
      expect(asked).toBe(0);
      expect(log.filter((e) => e.path === SERVICE_CONSENT_PATH)).toEqual([]);
    });
  });

  it('a proxy that shows no dialogs (OpenClaw-hosted) gives no approval: exit 4, nothing written', async () => {
    proxy = createCredentialProxy({ socketPath: sb.socket, store: new MemoryStore(), allowedServices: [] });
    await proxy.start();
    fs.writeFileSync(path.join(sb.config, 'daemon.pid'), String(process.pid));
    const r = await install();
    expect(r.code).toBe(4);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'error', code: 'broker_disabled' });
    expect(homeFiles()).toEqual([]);
  }, T);

  // The limit. The installer takes the yes from whatever answers on the
  // daemon's socket, and a program running as the user can bind that socket
  // (or write the unit file itself). Shown at the installer, with a runner
  // that only records: the row would need the real service manager otherwise.
  it.fails('LIMIT: a program running as the same user that answers on the daemon\'s socket gets the unit installed; this is not a boundary against same-user software', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aqsvc-limit-')));
    try {
      const home = path.join(root, 'home');
      fs.mkdirSync(home);
      const deps: ServiceDeps = {
        platform: 'darwin', uid: 501, username: 'ada', home, root, configDir: path.join(root, 'aq'), env: {},
        nodePath: '/opt/node/bin/node', cliPath: '/opt/aquaman/dist/cli/index.js', backends: ['keychain', 'keychain'],
        run: async () => ({ code: 0, stdout: '', stderr: '' }),
        sleep: async () => {},
        daemon: { health: async () => ({ reachable: false, pid: null }), pidFile: () => null, isRunning: () => false, stop: () => {}, cleanup: () => {} },
        // No person: an impostor on the socket said "approved".
        consent: async () => ({ outcome: 'approved' }),
      };
      await installService(deps);
      expect(fs.existsSync(unitFilePath('darwin', home)!)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
