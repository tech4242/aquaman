/**
 * Conformance, AWS path: three things the main table in
 * app-route-sigv4.test.ts does not cover. Same harness: a real proxy in this
 * process and the stand-in that re-signs each request it receives with
 * @smithy/signature-v4 and the stored secret.
 *
 * - A path rule on a bucket also covers an object named in
 *   `x-amz-copy-source`, which S3's CopyObject and UploadPartCopy read.
 * - What the proxy sends verifies under the SDK's own signer, whatever white
 *   space a header value carries.
 * - Bodies waiting to be hashed are bounded in number and in time, before
 *   any credential is read.
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

describe('AWS path: copy sources, header white space, held bodies', () => {
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

  describe('policy and a path named in a header AWS acts on', () => {
    // Every method is denied on the protected bucket.
    const DENY_BUCKET: PolicyConfig = { aws: { defaultAction: 'allow', rules: [{ method: '*', path: '/protected-bucket/**', action: 'deny' }] } };

    it('control: reading the protected object directly is denied', async () => {
      await start(DENY_BUCKET);
      const token = await routeToken();
      const res = await send(address(), { path: '/aws/protected-bucket/secret.txt', headers: { Authorization: sigv4(token) } });
      expect(res.status).toBe(403);
      expect(aws.requests.length).toBe(0);
    });

    it.each([
      ['CopyObject', '/aws/other-bucket/copy.txt', '/protected-bucket/secret.txt'],
      ['UploadPartCopy', '/aws/other-bucket/copy.txt?partNumber=1&uploadId=abc', '/protected-bucket/secret.txt'],
      ['a source without the leading slash', '/aws/other-bucket/copy.txt', 'protected-bucket/secret.txt'],
      ['a source with a version', '/aws/other-bucket/copy.txt', '/protected-bucket/secret.txt?versionId=3HL4kqtJ'],
      ['a source with an encoded slash', '/aws/other-bucket/copy.txt', '/protected-bucket%2Fsecret.txt'],
      ['a source in another case', '/aws/other-bucket/copy.txt', '/Protected-Bucket/secret.txt'],
      ['a source through dot segments', '/aws/other-bucket/copy.txt', '/other-bucket/../protected-bucket/secret.txt'],
      ['a source named by access point ARN', '/aws/other-bucket/copy.txt', 'arn:aws:s3:us-east-1:123456789012:accesspoint/ap/object/secret.txt'],
      ['an encoded access point ARN', '/aws/other-bucket/copy.txt', 'arn%3Aaws%3As3:us-east-1:123456789012:accesspoint/ap/object/secret.txt'],
    ])('denied: %s whose x-amz-copy-source is under the denied bucket', async (_name, path, source) => {
      await start(DENY_BUCKET);
      const token = await routeToken();
      const res = await send(address(), { method: 'PUT', path, headers: { Authorization: sigv4(token), 'X-Amz-Copy-Source': source } });
      expect(res.status).toBe(403);
      expect(aws.requests.length).toBe(0);
      expect(log.at(-1)).toMatchObject({ statusCode: 403 });
    });

    it('allowed: a copy between two buckets no rule denies, with the source header signed', async () => {
      await start(DENY_BUCKET);
      const token = await routeToken();
      const res = await send(address(), { method: 'PUT', path: '/aws/other-bucket/copy.txt', headers: { Authorization: sigv4(token), 'X-Amz-Copy-Source': '/third-bucket/a.txt' } });
      expect(res.status).toBe(200);
      expect(aws.last()!.verified).toBe(true);
      expect(aws.last()!.signedHeaders).toContain('x-amz-copy-source');
    });

    it.fails('limit: a multi-object delete (POST /bucket?delete) names its keys in the body, which a DELETE rule on the bucket does not see', async () => {
      await start({ aws: { defaultAction: 'allow', rules: [{ method: 'DELETE', path: '/protected-bucket/**', action: 'deny' }] } });
      const token = await routeToken();
      const res = await send(address(), { method: 'POST', path: '/aws/protected-bucket?delete', headers: { Authorization: sigv4(token) }, body: '<Delete><Object><Key>secret.txt</Key></Object></Delete>' });
      expect(res.status).toBe(403);
    });
  });

  describe('what leaves verifies under the SDK\'s signer', () => {
    const ALLOW: PolicyConfig = { aws: { defaultAction: 'allow', rules: [] } };

    it.each([
      ['a tab inside an x-amz header value', (t: string, a: string) => [
        'GET /aws/my-bucket/key HTTP/1.1', `Host: ${a}`, `Authorization: ${sigv4(t)}`, 'X-Amz-Meta-Note: a\t\tb', 'Connection: close', '', '',
      ]],
    ] as Array<[string, (t: string, a: string) => string[]]>)('%s', async (_name, lines) => {
      await start(ALLOW);
      const token = await routeToken();
      const answer = await rawBytes(address(), lines(token, address()).join('\r\n'));
      expect(answer.split('\r\n')[0]).toContain('200');
      expect(aws.requests.length).toBe(1);
      expect(aws.requests[0].problems).toEqual([]);
    });
  });

  describe('bodies that never finish', () => {
    const ALLOW: PolicyConfig = { aws: { defaultAction: 'allow', rules: [] } };
    /** A request that sends part of a chunked body and then stops. */
    const stalled = (token: string): Promise<{ req: http.ClientRequest; answer: Promise<Sent> }> => new Promise((resolve) => {
      const [host, port] = address().split(':');
      let settle!: (s: Sent) => void;
      const answer = new Promise<Sent>((r) => { settle = r; });
      const req = http.request({ host, port: Number(port), path: '/aws/', method: 'POST', headers: { Authorization: sigv4(token, 'us-east-1', 'dynamodb'), 'Transfer-Encoding': 'chunked' } }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => settle({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', () => settle({ status: 0, body: '' }));
      req.write(Buffer.alloc(64 * 1024, 1), () => resolve({ req, answer }));
    });

    it('no more than the limit are held at once: the next one is refused with sigv4_busy, before any vault read', async () => {
      await start(ALLOW, { maxBufferedBodies: 2, bodyReadTimeoutMs: 30_000 });
      const token = await routeToken();
      const gets = store.gets;
      const held = [await stalled(token), await stalled(token)];
      await new Promise((r) => setTimeout(r, 100));
      const third = await send(address(), { method: 'POST', path: '/aws/', headers: { Authorization: sigv4(token, 'us-east-1', 'dynamodb') }, body: '{}' });
      expect(third.status).toBe(503);
      expect(JSON.parse(third.body)).toMatchObject({ code: 'sigv4_busy' });
      expect(store.gets).toBe(gets);
      expect(aws.requests.length).toBe(0);
      // A held body that goes away frees its place.
      held[0].req.destroy();
      await new Promise((r) => setTimeout(r, 200));
      const next = await send(address(), { method: 'POST', path: '/aws/', headers: { Authorization: sigv4(token, 'us-east-1', 'dynamodb') }, body: '{}' });
      expect(next.status).toBe(200);
      expect(log.some((r) => String(r.error ?? '').startsWith('sigv4_body_aborted'))).toBe(true);
      held[1].req.destroy();
    }, 30_000);

    it('a body that does not arrive in time is answered sigv4_body_timeout and its place is freed', async () => {
      await start(ALLOW, { maxBufferedBodies: 1, bodyReadTimeoutMs: 300 });
      const token = await routeToken();
      const slow = await stalled(token);
      const answer = await slow.answer;
      expect(answer.status).toBe(408);
      expect(JSON.parse(answer.body)).toMatchObject({ code: 'sigv4_body_timeout' });
      expect(aws.requests.length).toBe(0);
      const next = await send(address(), { method: 'POST', path: '/aws/', headers: { Authorization: sigv4(token, 'us-east-1', 'dynamodb') }, body: '{}' });
      expect(next.status).toBe(200);
      slow.req.destroy();
    }, 30_000);
  });
});
