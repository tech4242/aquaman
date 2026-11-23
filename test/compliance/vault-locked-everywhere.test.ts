/**
 * Conformance: while the vault is locked, every path that needs it says so
 * with the same code and the same fix, and goes back to work once a person
 * has unlocked it.
 *
 * `vault-unlock.test.ts` covers the hand-over of the session. This file is
 * about the paths that read the vault for a reason of their own before, or
 * in place of, the credential: the ask-first marks, which are an item in the
 * vault, and the AWS path, which reads two or three keys to sign a request.
 * A caller told "backend error, run doctor" or "Proxy error" for a locked
 * vault has no way to know that one command by a person ends it.
 *
 * A real proxy on a temporary socket and a loopback port over a store that
 * refuses every read while locked, as the Bitwarden backend does.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createCredentialProxy,
  createBrokerScope,
  type CredentialProxy,
  type CredentialPrompter,
  type RequestInfo,
} from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import { VaultLockedError } from '../../packages/proxy/src/core/credentials/vault-lock.js';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../helpers/uds-proxy.js';

const SECRET = 'ghp_locked_everywhere_value_0123456789';
const TOKEN = 'aqm_lb_locked_everywhere_token_0123456789';
const LOCKED = { code: 'vault_locked', fix: 'Run: aquaman unlock' };

/** A store that refuses every read and write while `locked`, the way a session-backed vault does. */
class LockableStore extends MemoryStore {
  locked = false;
  private check(): void {
    if (this.locked) throw new VaultLockedError('The vault is locked, so the proxy cannot read credentials. Run: aquaman unlock');
  }
  override async get(service: string, key: string): Promise<string | null> { this.check(); return super.get(service, key); }
  override async set(service: string, key: string, value: string): Promise<void> { this.check(); return super.set(service, key, value); }
  override async exists(service: string, key: string): Promise<boolean> { this.check(); return super.exists(service, key); }
}

describe('a locked vault is reported as locked on every path that reads it', () => {
  let dir: string;
  let store: LockableStore;
  let proxy: CredentialProxy;
  let socketPath = '';
  let asked: number;
  let log: RequestInfo[];

  const prompter: CredentialPrompter = {
    async askValue() { return { outcome: 'declined' }; },
    async askApproval() { asked++; return { outcome: 'approved' }; },
    async askLoginItem() { return { outcome: 'declined' }; },
  };

  const post = async (pathname: string, body: unknown) => {
    const res = await udsFetch(socketPath, pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: JSON.parse(res.body) as Record<string, unknown> };
  };

  async function startProxy(): Promise<void> {
    socketPath = tmpSocketPath();
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    });
    proxy = createCredentialProxy({
      socketPath,
      store,
      allowedServices: ['aws'],
      broker: createBrokerScope({ configPath: path.join(dir, 'config.yaml'), projectsPath: path.join(dir, 'projects.yaml') }),
      credentialRequests: { prompter, declare: () => {} },
      loopback: { port, token: TOKEN },
      onRequest: (info) => { log.push(info); },
    });
    await proxy.start();
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-locked-'));
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'broker:\n  allowedRefs: ["aquaman://github/token"]\n');
    fs.writeFileSync(path.join(dir, 'projects.yaml'), 'projects: {}\n');
    store = new LockableStore();
    await store.set('github', 'token', SECRET);
    await store.set('aws', 'access_key_id', 'AKIDEXAMPLE');
    await store.set('aws', 'secret_access_key', 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY');
    asked = 0;
    log = [];
    await startProxy();
  });

  afterEach(async () => {
    await proxy.stop();
    cleanupSocket(socketPath);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolve: the marks cannot be read, and the answer is vault_locked, not a backend error', async () => {
    store.locked = true;
    const res = await post('/broker/resolve', { service: 'github', key: 'token' });
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject(LOCKED);
    expect(asked).toBe(0);
    expect(log.at(-1)).toMatchObject({ statusCode: 503, error: 'vault_locked: github/token' });
  });

  it('available: nothing resolves, and the answer says it is because the vault is locked', async () => {
    store.locked = true;
    const res = await post('/broker/available', { refs: [{ service: 'github', key: 'token' }] });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ available: [false], locked: true, ...LOCKED });
  });

  it.each([
    ['listing the marks', { list: true }],
    ['setting a mark', { service: 'github', key: 'token', ask: true }],
    ['removing a mark', { service: 'github', key: 'token', ask: false }],
  ])('ask-first endpoint, %s: vault_locked with the unlock fix', async (_name, body) => {
    store.locked = true;
    const res = await post('/broker/ask-first', body);
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject(LOCKED);
    expect(asked).toBe(0);
  });

  it('an AWS request: vault_locked as JSON, nothing signed and nothing sent', async () => {
    store.locked = true;
    const res = await udsFetch(socketPath, '/aws/', {
      method: 'POST',
      headers: {
        authorization: 'AWS4-HMAC-SHA256 Credential=placeholder/20261123/us-east-1/dynamodb/aws4_request, SignedHeaders=host;x-amz-date, Signature=' + '0'.repeat(64),
        'x-amz-date': '20261123T000000Z',
        'content-type': 'application/x-amz-json-1.0',
      },
      body: '{}',
    });
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject(LOCKED);
    expect(log.at(-1)).toMatchObject({ statusCode: 503, error: 'vault_locked: aws/access_key_id' });
  });

  it('after the unlock a marked reference is asked about: a locked spell does not leave the marks read as "none"', async () => {
    expect((await post('/broker/ask-first', { service: 'github', key: 'token', ask: true })).status).toBe(200);
    // A proxy started over a locked vault is what a login is: nothing remembered, nothing readable.
    await proxy.stop();
    cleanupSocket(socketPath);
    store.locked = true;
    await startProxy();
    expect((await post('/broker/resolve', { service: 'github', key: 'token' })).status).toBe(503);
    expect((await post('/broker/available', { refs: [{ service: 'github', key: 'token' }] })).json.locked).toBe(true);

    store.locked = false;
    const res = await post('/broker/resolve', { service: 'github', key: 'token' });
    expect(res.status).toBe(200);
    expect(res.json.value).toBe(SECRET);
    expect(asked).toBe(1);
  });
});
