/**
 * Conformance: a credential value is not handed out unless its audit entry
 * was written, and a log that cannot be written does not take the daemon
 * down.
 *
 * Three places hand a value out: `POST /broker/resolve` (which `aquaman get`
 * and `aquaman-coder exec` call), the OpenShell driver's Resolve, and the
 * response to a forwarded request. Each is tried with an audit sink that
 * fails, in process and against a real `aquaman daemon` whose audit directory
 * has been made read-only.
 *
 * NIST SP 800-53 AU-2 (event logging), AU-5 (response to audit logging
 * process failures); OWASP ASVS 5.0 V16.5.3 (no fail-open on errors).
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import {
  createCredentialProxy,
  createBrokerScope,
  createServiceRegistry,
  type CredentialProxy,
  type RequestInfo,
} from 'aquaman-proxy';
import { AuditLogger, MemoryStore } from 'aquaman-core';
import { createOpenShellDriverCore, type DriverAccessEvent } from '../../packages/proxy/src/openshell/credential-driver.js';
import { auditDriverAccess } from '../../packages/proxy/src/openshell/integration.js';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../helpers/uds-proxy.js';
import { createSandbox, startDaemon, udsGet, T, type Sandbox } from '../e2e/cov-cli-core-helpers.js';

const SECRET = 'ghp_real_vault_value_0123456789abcdef';

describe('audit failure: in process', () => {
  let proxy: CredentialProxy | undefined;
  let socketPath = '';
  let upstream: http.Server | undefined;
  let upstreamHits = 0;
  let failing = true;
  let recorded: RequestInfo[] = [];

  beforeEach(() => {
    failing = true;
    recorded = [];
    upstreamHits = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (proxy?.isRunning()) await proxy.stop();
    proxy = undefined;
    if (socketPath) cleanupSocket(socketPath);
    if (upstream) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
    upstream = undefined;
  });

  /** How the audit sink fails: the way a full disk does (a rejected promise), or by throwing. */
  type Failure = 'rejects' | 'throws';

  async function start(failure: Failure): Promise<void> {
    upstream = http.createServer((req, res) => {
      upstreamHits++;
      res.setHeader('x-upstream', 'yes');
      res.end(`upstream body for ${req.url}`);
    });
    const port = await new Promise<number>((resolve) => {
      upstream!.listen(0, '127.0.0.1', () => resolve((upstream!.address() as net.AddressInfo).port));
    });
    const registry = createServiceRegistry();
    registry.override('github', { upstream: `http://127.0.0.1:${port}` });
    const store = new MemoryStore();
    await store.set('github', 'token', SECRET);
    const scope = createBrokerScope({ configPath: '/nonexistent/config.yaml', projectsPath: '/nonexistent/projects.yaml' });
    socketPath = tmpSocketPath();
    proxy = createCredentialProxy({
      socketPath,
      store,
      serviceRegistry: registry,
      allowedServices: ['github'],
      broker: { ...scope, check: (service, key, caller) => (service === 'github' && key === 'token' ? ({ allowed: true } as const) : scope.check(service, key, caller)) },
      policyConfig: { github: { defaultAction: 'allow', rules: [{ method: 'DELETE', path: '/**', action: 'deny' }] } },
      onRequest: (info) => {
        if (!failing) { recorded.push(info); return undefined; }
        const err = Object.assign(new Error("EACCES: permission denied, open 'current.jsonl'"), { code: 'EACCES' });
        if (failure === 'throws') throw err;
        return Promise.reject(err);
      },
    });
    await proxy.start();
  }

  const resolveRef = () =>
    udsFetch(socketPath, '/broker/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service: 'github', key: 'token' }) });

  for (const failure of ['rejects', 'throws'] as Failure[]) {
    describe(`the audit sink ${failure}`, () => {
      it('/broker/resolve returns an error with a fix and no value', async () => {
        await start(failure);
        const res = await resolveRef();
        expect(res.status).toBe(500);
        expect(res.body).not.toContain(SECRET);
        const body = JSON.parse(res.body);
        expect(body).toEqual({
          error: 'The audit log could not be written, so github/token was not handed out',
          fix: 'Check that the audit directory (~/.aquaman/audit by default) is writable and the disk is not full. Run: aquaman doctor',
          code: 'audit_unavailable',
        });
        expect(body).not.toHaveProperty('value');
      });

      it('a forwarded request gets an error, not the upstream response', async () => {
        await start(failure);
        const res = await udsFetch(socketPath, '/github/user');
        expect(res.status).toBe(500);
        expect(JSON.parse(res.body)).toEqual({
          error: 'The audit log could not be written, so the response was withheld',
          fix: 'Check that the audit directory (~/.aquaman/audit by default) is writable and the disk is not full. Run: aquaman doctor',
          code: 'audit_unavailable',
        });
        expect(res.body).not.toContain('upstream body');
        expect(res.headers['x-upstream']).toBeUndefined();
        // The request had already gone upstream: that is the stated limit of this path.
        expect(upstreamHits).toBe(1);
      });

      it('refusals still answer as refusals, and the proxy keeps serving', async () => {
        await start(failure);
        expect((await udsFetch(socketPath, '/github/repos/x', { method: 'DELETE' })).status).toBe(403);
        const undeclared = await udsFetch(socketPath, '/broker/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service: 'github', key: 'other' }) });
        expect(undeclared.status).toBe(404);
        expect((await resolveRef()).status).toBe(500);
        expect((await udsFetch(socketPath, '/_health')).status).toBe(200);
        expect(upstreamHits).toBe(0);
      });

      it('once the log can be written again, the same calls succeed and are recorded', async () => {
        await start(failure);
        expect((await resolveRef()).status).toBe(500);
        failing = false;
        const res = await resolveRef();
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body).value).toBe(SECRET);
        const forwarded = await udsFetch(socketPath, '/github/user');
        expect(forwarded.status).toBe(200);
        expect(forwarded.body).toBe('upstream body for /user');
        expect(recorded.map((r) => `${r.method} ${r.statusCode}`)).toEqual(['BROKER 200', 'GET 200']);
      });

      it('the failure is reported on stderr, naming what could not be recorded', async () => {
        await start(failure);
        await resolveRef();
        expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^AUDIT FAILURE: could not record BROKER github \(\/broker\/resolve\): EACCES/));
      });
    });
  }

  it('the value is written to the response only after the audit entry: a slow sink delays the answer', async () => {
    const order: string[] = [];
    const store = new MemoryStore();
    await store.set('github', 'token', SECRET);
    const scope = createBrokerScope({ configPath: '/nonexistent/config.yaml', projectsPath: '/nonexistent/projects.yaml' });
    socketPath = tmpSocketPath();
    proxy = createCredentialProxy({
      socketPath,
      store,
      allowedServices: [],
      broker: { ...scope, check: () => ({ allowed: true } as const) },
      onRequest: async () => {
        await new Promise((r) => setTimeout(r, 150));
        order.push('audit written');
      },
    });
    await proxy.start();
    const res = await resolveRef();
    order.push('response received');
    expect(res.status).toBe(200);
    expect(order).toEqual(['audit written', 'response received']);
  });
});

describe('audit failure: the OpenShell driver', () => {
  const handle = { driver: 'aquaman', handle: 'aquaman://github/token' };

  async function driver(onAccess: (event: DriverAccessEvent) => unknown) {
    const store = new MemoryStore();
    await store.set('github', 'token', SECRET);
    const scope = createBrokerScope({ configPath: '/nonexistent/config.yaml', projectsPath: '/nonexistent/projects.yaml' });
    return createOpenShellDriverCore({
      store,
      scope: { ...scope, check: () => ({ allowed: true } as const) },
      version: 'test',
      onAccess,
    });
  }

  it('Resolve returns no value when the audit entry cannot be written, and says how to fix it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const onAccess of [() => Promise.reject(new Error('ENOSPC: no space left on device')), () => { throw new Error('ENOSPC: no space left on device'); }]) {
        const core = await driver(onAccess);
        const attempt = core.resolve([{ request_id: 'r1', handle }]);
        await expect(attempt).rejects.toMatchObject({
          code: 'internal',
          message: 'aquaman: the audit log could not be written, so aquaman://github/token was not resolved. Fix: check that the audit directory (~/.aquaman/audit by default) is writable and the disk is not full, then run: aquaman doctor',
        });
      }
    } finally {
      errors.mockRestore();
    }
  });

  it('Resolve returns the value once the entry is written, with a real audit log behind it', async () => {
    const sb = createSandbox();
    try {
      const logDir = path.join(sb.root, 'audit');
      const audit = new AuditLogger({ logDir });
      await audit.initialize();
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const core = await driver((event) => auditDriverAccess(audit, event));

      expect(await core.resolve([{ request_id: 'r1', handle }])).toEqual([{ request_id: 'r1', value: SECRET }]);
      expect(fs.readFileSync(path.join(logDir, 'current.jsonl'), 'utf-8').trim().split('\n')).toHaveLength(1);

      // The same driver, the same log, now read-only.
      fs.chmodSync(path.join(logDir, 'current.jsonl'), 0o400);
      fs.chmodSync(path.join(logDir, 'current.wal'), 0o400);
      fs.chmodSync(logDir, 0o500);
      try {
        await expect(core.resolve([{ request_id: 'r2', handle }])).rejects.toThrow(/audit log could not be written/);
      } finally {
        fs.chmodSync(logDir, 0o700);
        errors.mockRestore();
      }
      expect(fs.readFileSync(path.join(logDir, 'current.jsonl'), 'utf-8').trim().split('\n')).toHaveLength(1);
    } finally {
      await sb.cleanup();
    }
  });
});

describe('audit failure: a real daemon whose audit directory is read-only', () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = createSandbox();
    sb.writeConfig('credentials:\n  backend: encrypted-file\n  proxiedServices: [anthropic, github]\n');
  });
  afterEach(async () => {
    // Writable again, or the sandbox cannot be removed.
    const dir = path.join(sb.config, 'audit');
    if (fs.existsSync(dir)) {
      fs.chmodSync(dir, 0o700);
      for (const f of ['current.jsonl', 'current.wal']) {
        if (fs.existsSync(path.join(dir, f))) fs.chmodSync(path.join(dir, f), 0o600);
      }
    }
    await sb.cleanup();
  });

  function resolveRef(): Promise<{ status: number; body: string }> {
    const payload = JSON.stringify({ service: 'github', key: 'token' });
    return new Promise((resolve, reject) => {
      const req = http.request(
        { socketPath: sb.socket, path: '/broker/resolve', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
        (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }

  it('resolve and `aquaman get` are refused with a fix, nothing is logged or leaked, and the daemon survives', async () => {
    expect((await sb.run(['credentials', 'add', 'github', 'token', '--backend', 'encrypted-file'], { input: `${SECRET}\n` })).code).toBe(0);
    expect((await sb.run(['broker', 'allow', 'aquaman://github/token'])).code).toBe(0);
    const { child, output } = await startDaemon(sb);

    // The pid file is for its owner only.
    expect(fs.statSync(path.join(sb.config, 'daemon.pid')).mode & 0o777).toBe(0o600);

    const auditDir = path.join(sb.config, 'audit');
    const logFile = path.join(auditDir, 'current.jsonl');
    const entries = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean).length : 0);

    // While the log is writable: the value, and one more entry.
    const before = entries();
    const ok = await resolveRef();
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).value).toBe(SECRET);
    expect(entries()).toBe(before + 1);

    // Read-only, as after a permissions mistake; a full disk fails the same write.
    fs.chmodSync(logFile, 0o400);
    if (fs.existsSync(path.join(auditDir, 'current.wal'))) fs.chmodSync(path.join(auditDir, 'current.wal'), 0o400);
    fs.chmodSync(auditDir, 0o500);

    const refused = await resolveRef();
    expect(refused.status).toBe(500);
    expect(refused.body).not.toContain(SECRET);
    expect(JSON.parse(refused.body)).toMatchObject({ code: 'audit_unavailable', fix: expect.stringContaining('aquaman doctor') });

    const got = await sb.run(['get', 'aquaman://github/token']);
    expect(got.code).not.toBe(0);
    expect(got.stdout).not.toContain(SECRET);
    expect(got.stderr).toContain('Error: The audit log could not be written, so github/token was not handed out');
    expect(got.stderr).toContain('Fix: Check that the audit directory');

    expect(entries()).toBe(before + 1);

    // Still running, still answering, and it said so loudly.
    expect(child.exitCode).toBeNull();
    expect((await udsGet(sb.socket, '/_health')).status).toBe(200);
    expect(output()).toContain('AUDIT FAILURE: could not record BROKER github');

    // Writable again: the next read is served and recorded.
    fs.chmodSync(auditDir, 0o700);
    fs.chmodSync(logFile, 0o600);
    if (fs.existsSync(path.join(auditDir, 'current.wal'))) fs.chmodSync(path.join(auditDir, 'current.wal'), 0o600);
    const again = await resolveRef();
    expect(again.status).toBe(200);
    expect(JSON.parse(again.body).value).toBe(SECRET);
    expect(entries()).toBeGreaterThan(before + 1);
    expect(child.exitCode).toBeNull();
  }, T * 3);
});
