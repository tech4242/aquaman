/**
 * Conformance, AWS path: an S3 copy reads the object its
 * `x-amz-copy-source` header names, so policy checks that object as a read
 * (GET), whatever the method of the request. A rule that stops reading a
 * bucket stops copying out of it, under a deny rule and under an allow list,
 * and a bucket that may only be read can still be copied from.
 *
 * Same harness as app-route-sigv4.test.ts: a real proxy in this process and
 * the stand-in that re-signs each request with @smithy/signature-v4.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { createCredentialProxy, createBrokerScope, createServiceRegistry, type CredentialProxy, type RequestInfo, type PolicyConfig } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import { CountingStore } from '../helpers/counting-store.js';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../helpers/uds-proxy.js';
import { startAwsStandIn, type AwsStandIn } from '../helpers/aws-stand-in.js';

const LOOPBACK_TOKEN = 'aqm_lb_review_b_token_0123456789abcdef';
const REAL_KEY_ID = 'AKIAVAULTKEYID000001';
const REAL_SECRET = 'vaultSecretAccessKey/0123456789+abcdefgh';

const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
const sigv4 = (accessKeyId: string, region = 'us-east-1', service = 's3') =>
  `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${today()}/${region}/${service}/aws4_request, SignedHeaders=host;x-amz-date, Signature=${'0'.repeat(64)}`;

interface Sent { status: number; body: string }

function send(address: string, opts: { method?: string; path: string; headers?: Record<string, string | string[]>; body?: string | Buffer }): Promise<Sent> {
  const [host, port] = address.split(':');
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port: Number(port), path: opts.path, method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

/** Raw bytes (latin1) to the listener; resolves with the whole answer. */
function rawBytes(address: string, text: string): Promise<string> {
  const [host, port] = address.split(':');
  return new Promise((resolve) => {
    const socket = net.connect(Number(port), host, () => socket.write(Buffer.from(text, 'latin1')));
    let data = '';
    const finish = () => { socket.destroy(); resolve(data); };
    socket.on('data', (c) => { data += c.toString('latin1'); });
    socket.on('close', finish);
    socket.on('error', finish);
    socket.setTimeout(3000, finish);
  });
}

describe('AWS path: a copy source is checked as a read', () => {
  let proxy: CredentialProxy;
  let aws: AwsStandIn;
  let store: CountingStore;
  let socketPath: string;
  let log: RequestInfo[];

  async function start(policy: PolicyConfig, sigv4Limits?: { maxBufferedBodies?: number; bodyReadTimeoutMs?: number }) {
    const registry = createServiceRegistry({ configPath: '/nonexistent/services.yaml' });
    registry.override('aws', { upstream: `http://127.0.0.1:${aws.port}` });
    const scope = createBrokerScope({ configPath: '/nonexistent/config.yaml', projectsPath: '/nonexistent/projects.yaml' });
    proxy = createCredentialProxy({
      socketPath,
      store,
      serviceRegistry: registry,
      allowedServices: [],
      broker: { ...scope, routedRefs: () => new Set(['aquaman://aws/access_key_id']) },
      loopback: { port: 0, token: LOOPBACK_TOKEN, host: '127.0.0.1' },
      policyConfig: policy,
      sigv4: sigv4Limits,
      onRequest: (info) => { log.push(info); },
    });
    await proxy.start();
  }
  const routeToken = async (): Promise<string> =>
    JSON.parse((await udsFetch(socketPath, '/broker/route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service: 'aws', key: 'access_key_id' }) })).body).token;
  const address = () => proxy.getLoopbackAddress()!;

  beforeEach(async () => {
    aws = await startAwsStandIn({ accessKeyId: REAL_KEY_ID, secretAccessKey: REAL_SECRET });
    const inner = new MemoryStore();
    await inner.set('aws', 'access_key_id', REAL_KEY_ID);
    await inner.set('aws', 'secret_access_key', REAL_SECRET);
    store = new CountingStore(inner);
    log = [];
    socketPath = tmpSocketPath();
  });

  afterEach(async () => {
    if (proxy?.isRunning()) await proxy.stop();
    await aws.stop();
    cleanupSocket(socketPath);
  });

  describe('rules about reading', () => {
    const DENY_READS: PolicyConfig = { aws: { defaultAction: 'allow', rules: [{ method: 'GET', path: '/protected-bucket/**', action: 'deny' }] } };
    const DENY_BUCKET: PolicyConfig = { aws: { defaultAction: 'allow', rules: [{ method: '*', path: '/protected-bucket/**', action: 'deny' }] } };
    const ALLOW_LIST: PolicyConfig = { aws: { defaultAction: 'deny', rules: [
      { method: 'GET', path: '/public-bucket/**', action: 'allow' },
      { method: 'PUT', path: '/scratch-bucket/**', action: 'allow' },
      { method: 'GET', path: '/scratch-bucket/**', action: 'allow' },
      { method: 'PUT', path: '/protected-bucket/**', action: 'allow' },
    ] } };

    it('control: GET of the protected object is denied by the read rule', async () => {
      await start(DENY_READS);
      const token = await routeToken();
      const res = await send(address(), { path: '/aws/protected-bucket/secret.txt', headers: { Authorization: sigv4(token) } });
      expect(res.status).toBe(403);
    });

    it('a rule that denies reading a bucket (GET) also denies copying out of it', async () => {
      await start(DENY_READS);
      const token = await routeToken();
      const res = await send(address(), { method: 'PUT', path: '/aws/other-bucket/copy.txt', headers: { Authorization: sigv4(token), 'X-Amz-Copy-Source': '/protected-bucket/secret.txt' } });
      expect(res.status).toBe(403);
      expect(aws.requests.length).toBe(0);
    });

    it('a write-only bucket in an allow list (PUT allowed, GET not) cannot be copied out of', async () => {
      await start(ALLOW_LIST);
      const token = await routeToken();
      const res = await send(address(), { method: 'PUT', path: '/aws/scratch-bucket/copy.txt', headers: { Authorization: sigv4(token), 'X-Amz-Copy-Source': '/protected-bucket/secret.txt' } });
      expect(res.status).toBe(403);
      expect(aws.requests.length).toBe(0);
    });

    it('a read-only bucket in an allow list (GET allowed, PUT not) can be copied from', async () => {
      await start(ALLOW_LIST);
      const token = await routeToken();
      const res = await send(address(), { method: 'PUT', path: '/aws/scratch-bucket/copy.txt', headers: { Authorization: sigv4(token), 'X-Amz-Copy-Source': '/public-bucket/readme.txt' } });
      expect(res.status).toBe(200);
      expect(aws.last()!.verified).toBe(true);
    });

    it.each([
      ['an encoded leading slash', '%2Fprotected-bucket%2Fsecret.txt'],
      ['an encoded letter in the bucket name', '/%70rotected-bucket/secret.txt'],
      ['an encoded letter, no leading slash', 'protected-bucke%74/secret.txt'],
      ['a plus sign for nothing', '/protected-bucket/secret.txt?versionId=1&x=/'],
      ['white space before the slash, encoded', '%20/protected-bucket/secret.txt'],
      ['two values in one header', '/third-bucket/a.txt, /protected-bucket/secret.txt'],
    ])('denied under a deny-everything rule: %s', async (_name, source) => {
      await start(DENY_BUCKET);
      const token = await routeToken();
      const res = await send(address(), { method: 'PUT', path: '/aws/other-bucket/copy.txt', headers: { Authorization: sigv4(token), 'X-Amz-Copy-Source': source } });
      expect({ status: res.status, forwarded: aws.requests.length }).toEqual({ status: 403, forwarded: 0 });
    });
  });
});
