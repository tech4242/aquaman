/**
 * Conformance: a program can be routed through the proxy to AWS. The program
 * signs with a route token as its access key id and a placeholder secret; the
 * proxy reads the region and the signing name from that signature, drops it,
 * and signs the request it sends with the keys from the vault.
 *
 * A real proxy runs in this process. A local server stands in for AWS and
 * checks every signature it receives with the stored secret, using the AWS
 * SDK's own signer and not the proxy's (test/helpers/aws-stand-in.ts). Each
 * row attacks one part: where the request goes, what reaches AWS besides the
 * request, who may have a request signed, what the signature covers, what the
 * proxy refuses to half-sign, and request policy.
 *
 * MITRE ATLAS AML.T0055 (unsecured credentials); NIST SP 800-53 AC-3 (access
 * enforcement), AC-6 (least privilege), IA-5 (authenticator management),
 * SI-10 (input validation).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { createCredentialProxy, createBrokerScope, createServiceRegistry, type CredentialProxy, type RequestInfo, type PolicyConfig } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import { CountingStore } from '../helpers/counting-store.js';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../helpers/uds-proxy.js';
import { startAwsStandIn, type AwsStandIn } from '../helpers/aws-stand-in.js';
import { SIGV4_PLACEHOLDER_SECRET, SIGV4_MAX_BUFFERED_BODY } from '../../packages/proxy/src/sigv4.js';

/** The agent hosts' token. A routed program is never given this one. */
const LOOPBACK_TOKEN = 'aqm_lb_sigv4_route_test_token_0123456789';
const REAL_KEY_ID = 'AKIAVAULTKEYID000001';
const REAL_SECRET = 'vaultSecretAccessKey/0123456789+abcdefgh';
const REAL_SESSION = 'FwoGZXIvYXdzEvaultSessionToken//0123456789==';
const CLIENT_SESSION = 'client-side-session-token-never-forwarded';

const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
/**
 * The header a client pointed at the proxy sends. The signature is zeros:
 * the proxy never checks it, because the client never held a key to make a
 * meaningful one with.
 */
const sigv4 = (accessKeyId: string, region = 'us-east-1', service = 's3') =>
  `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${today()}/${region}/${service}/aws4_request, SignedHeaders=host;x-amz-date, Signature=${'0'.repeat(64)}`;

interface Sent { status: number; body: string; headers: http.IncomingHttpHeaders }

/** Sends header values and the request target exactly as given. */
function send(address: string, opts: { method?: string; path: string; headers?: Record<string, string | string[]>; body?: string | Buffer }): Promise<Sent> {
  const [host, port] = address.split(':');
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port: Number(port), path: opts.path, method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

/** Writes bytes to the listener and returns the status line of the answer, or '' when the connection was closed without one. */
function rawBytes(address: string, text: string): Promise<string> {
  const [host, port] = address.split(':');
  return new Promise((resolve) => {
    const socket = net.connect(Number(port), host, () => socket.write(text));
    let data = '';
    const finish = () => { socket.destroy(); resolve(data.split('\r\n')[0] ?? ''); };
    socket.on('data', (c) => { data += c.toString('latin1'); if (data.includes('\r\n\r\n')) finish(); });
    socket.on('close', finish);
    socket.on('error', finish);
    socket.setTimeout(3000, finish);
  });
}

describe('routing a program through the proxy to AWS (sigv4)', () => {
  let proxy: CredentialProxy;
  let aws: AwsStandIn;
  let store: CountingStore;
  let socketPath: string;
  let declared: Set<string>;
  let routed: Set<string>;
  let log: RequestInfo[];

  async function start(opts: { allowed?: string[]; policy?: PolicyConfig } = {}) {
    if (proxy?.isRunning()) {
      // A second proxy gets its own socket: a client connection kept alive to the first must not be reused.
      await proxy.stop();
      cleanupSocket(socketPath);
      socketPath = tmpSocketPath();
    }
    const registry = createServiceRegistry({ configPath: '/nonexistent/services.yaml' });
    // Test only: the connection goes to the stand-in. The Host header and
    // the signature still name the AWS host the proxy chose.
    registry.override('aws', { upstream: `http://127.0.0.1:${aws.port}` });
    registry.override('stripe', { upstream: `http://127.0.0.1:${aws.port}` });
    const scope = createBrokerScope({ configPath: '/nonexistent/config.yaml', projectsPath: '/nonexistent/projects.yaml' });
    proxy = createCredentialProxy({
      socketPath,
      store,
      serviceRegistry: registry,
      allowedServices: opts.allowed ?? [],
      broker: {
        ...scope,
        check: (service, key, caller) => (declared.has(`${service}/${key}`) ? ({ allowed: true } as const) : scope.check(service, key, caller)),
        routedRefs: () => new Set([...routed].map((r) => `aquaman://${r}`)),
      },
      loopback: { port: 0, token: LOOPBACK_TOKEN, host: '127.0.0.1' },
      policyConfig: opts.policy ?? {
        aws: { defaultAction: 'allow', rules: [{ method: 'DELETE', path: '/protected-bucket/**', action: 'deny' }] },
      },
      onRequest: (info) => { log.push(info); },
    });
    await proxy.start();
  }

  const route = (service = 'aws', key = 'access_key_id') =>
    udsFetch(socketPath, '/broker/route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service, key }) });
  const routeToken = async (): Promise<string> => JSON.parse((await route()).body).token;
  const address = () => proxy.getLoopbackAddress()!;
  /** Everything AWS was sent in headers and the request line, with base64 runs decoded as well. */
  const upstreamText = () => aws.requests.map((r) => {
    const lines = [r.url, ...Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`)];
    const decoded = lines.flatMap((v) => (v.match(/[A-Za-z0-9+/_-]{16,}={0,2}/g) ?? []).map((m) => Buffer.from(m, 'base64').toString('latin1')));
    return [...lines, ...decoded].join('\n');
  }).join('\n');

  beforeEach(async () => {
    aws = await startAwsStandIn({ accessKeyId: REAL_KEY_ID, secretAccessKey: REAL_SECRET });
    const inner = new MemoryStore();
    await inner.set('aws', 'access_key_id', REAL_KEY_ID);
    await inner.set('aws', 'secret_access_key', REAL_SECRET);
    store = new CountingStore(inner);
    declared = new Set();
    routed = new Set(['aws/access_key_id']);
    log = [];
    socketPath = tmpSocketPath();
    await start();
  });

  afterEach(async () => {
    // Whatever a row did, nothing reached the stand-in that AWS would not
    // have accepted from the stored keys, and nothing left for another host.
    for (const r of aws.requests) {
      expect(r.problems, `${r.method} ${r.url}`).toEqual([]);
      expect(r.host).toMatch(/^[a-z0-9-]+(\.[a-z]{2}(-[a-z]+){1,2}-\d)?\.amazonaws\.com$/);
    }
    if (proxy?.isRunning()) await proxy.stop();
    await aws.stop();
    cleanupSocket(socketPath);
  });

  describe('POST /broker/route', () => {
    it('answers with the proxy URL, the route token and a placeholder secret, and never with a stored value', async () => {
      const res = await route();
      expect(res.status).toBe(200);
      const url = `http://${address()}/aws`;
      expect(JSON.parse(res.body)).toEqual({
        url,
        token: expect.stringMatching(/^aqm_rt_[0-9a-f]{48}$/),
        env: {
          AWS_SECRET_ACCESS_KEY: SIGV4_PLACEHOLDER_SECRET,
          AWS_ENDPOINT_URL_IAM: `${url}/_global`,
          AWS_ENDPOINT_URL_BEDROCK_RUNTIME: `${url}/_host/bedrock-runtime`,
        },
      });
      expect(res.body).not.toContain(REAL_SECRET);
      expect(res.body).not.toContain(REAL_KEY_ID);
      expect(log.some((r) => r.method === 'BROKER_ROUTE' && r.statusCode === 200)).toBe(true);
    });

    it('a route for a header service carries no extra variables', async () => {
      routed.add('stripe/secret_key');
      await store.set('stripe', 'secret_key', 'sk_live_real');
      expect(Object.keys(JSON.parse((await route('stripe', 'secret_key')).body))).toEqual(['url', 'token']);
    });

    it.each([
      ['the secret access key', 'secret_access_key'],
      ['the session token', 'session_token'],
    ])('refuses to route by %s, without reading the vault', async (_name, key) => {
      routed.add(`aws/${key}`);
      const before = store.gets;
      const res = await route('aws', key);
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toMatchObject({ code: 'route_key_mismatch', fix: 'Use aquaman://aws/access_key_id' });
      expect(res.body).not.toMatch(/aqm_/);
      expect(store.gets).toBe(before);
    });

    it.each([
      ['the access key id', 'access_key_id'],
      ['the secret access key', 'secret_access_key'],
    ])('refuses when %s is not stored, and names the one to add', async (_name, missing) => {
      await store.delete('aws', missing);
      const res = await route();
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toMatchObject({ code: 'credential_not_found', fix: `Run: aquaman credentials add aws ${missing}` });
      expect(res.body).not.toMatch(/aqm_/);
    });

    it('does not need a session token', async () => {
      expect(await store.get('aws', 'session_token')).toBeNull();
      expect((await route()).status).toBe(200);
    });

    it('is not answered over the loopback listener', async () => {
      const res = await fetch(`http://${address()}/broker/route`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-aquaman-token': LOOPBACK_TOKEN },
        body: JSON.stringify({ service: 'aws', key: 'access_key_id' }),
      });
      expect(res.status).toBe(404);
      expect(await res.text()).not.toMatch(/aqm_rt_/);
    });
  });

  describe('a request for a reference that is not routed', () => {
    it('gets no route, before the vault is read', async () => {
      routed.clear();
      const before = store.gets;
      const res = await route();
      expect(JSON.parse(res.body).code).toBe('route_not_recorded');
      expect(store.gets).toBe(before);
    });

    it('is not forwarded, whatever token it is signed with', async () => {
      const token = await routeToken();
      routed.clear();
      for (const headers of [
        { Authorization: sigv4(token) },
        { Authorization: sigv4(token), 'x-aquaman-token': token },
        { Authorization: sigv4(LOOPBACK_TOKEN) },
      ]) {
        expect((await send(address(), { path: '/aws/my-bucket/key', headers })).status).toBe(401);
      }
      // The agent hosts' token is a valid token, and aws is not a service they are forwarded.
      expect((await send(address(), { path: '/aws/my-bucket/key', headers: { Authorization: sigv4(token), 'x-aquaman-token': LOOPBACK_TOKEN } })).status).toBe(404);
      expect((await udsFetch(socketPath, '/aws/my-bucket/key', { headers: { Authorization: sigv4(token) } })).status).toBe(404);
      expect(aws.requests.length).toBe(0);
    });

    it('a routed aws key is not materializable, and neither is the secret it signs with', async () => {
      for (const key of ['access_key_id', 'secret_access_key', 'session_token']) {
        const overSocket = await udsFetch(socketPath, '/broker/resolve', { method: 'POST', body: JSON.stringify({ service: 'aws', key }) });
        expect(overSocket.status, key).toBe(404);
        expect(overSocket.body).not.toContain(REAL_SECRET);
        expect(overSocket.body).not.toContain(REAL_KEY_ID);
        const overLoopback = await fetch(`http://${address()}/broker/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-aquaman-token': LOOPBACK_TOKEN },
          body: JSON.stringify({ service: 'aws', key }),
        });
        expect(overLoopback.status, key).toBe(404);
        const text = await overLoopback.text();
        expect(text).not.toContain(REAL_SECRET);
        expect(text).not.toContain(REAL_KEY_ID);
      }
    });
  });

  describe('who may have a request signed', () => {
    it('the route token as the access key id of the credential scope', async () => {
      const token = await routeToken();
      const res = await send(address(), { path: '/aws/my-bucket/key.txt', headers: { Authorization: sigv4(token, 'eu-central-1', 's3') } });
      expect(res.status).toBe(200);
      const seen = aws.last()!;
      expect(seen.verified).toBe(true);
      expect(seen.host).toBe('s3.eu-central-1.amazonaws.com');
      expect(seen.url).toBe('/my-bucket/key.txt');
      expect(seen.accessKeyId).toBe(REAL_KEY_ID);
      expect(seen.region).toBe('eu-central-1');
      expect(seen.service).toBe('s3');
    });

    it.each([
      ['in the credential scope', (t: string) => ({ Authorization: sigv4(t) })],
      ['as a bearer token', (t: string) => ({ Authorization: `Bearer ${t}` })],
      ['in x-aquaman-token', (t: string) => ({ 'x-aquaman-token': t })],
      ['in x-api-key', (t: string) => ({ 'x-api-key': t })],
    ])('the route token %s reads nothing through a broker endpoint', async (_name, headers) => {
      const token = await routeToken();
      declared.add('aws/access_key_id');
      const before = store.gets;
      for (const endpoint of ['/broker/resolve', '/broker/available', '/broker/route', '/broker/request']) {
        const res = await fetch(`http://${address()}${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers(token) },
          body: JSON.stringify({ service: 'aws', key: 'secret_access_key', refs: [{ service: 'aws', key: 'secret_access_key' }] }),
        });
        const text = await res.text();
        expect(res.status, endpoint).toBe(401);
        expect(text).not.toContain(REAL_SECRET);
      }
      expect(store.gets).toBe(before);
    });

    it.each([
      ['aws is only routed', []],
      ['aws is also forwarded for agent hosts', ['aws']],
    ])('the agent hosts\' token in the credential scope is refused when %s', async (_name, allowed) => {
      await start({ allowed });
      const before = store.gets;
      const res = await send(address(), { path: '/aws/my-bucket/key', headers: { Authorization: sigv4(LOOPBACK_TOKEN) } });
      expect(res.status).toBe(401);
      expect(aws.requests.length).toBe(0);
      expect(store.gets).toBe(before);
    });

    it.each([
      ['a wrong token', (t: string) => sigv4(t.replace(/.$/, (c) => (c === '0' ? '1' : '0')))],
      ['the token cut short', (t: string) => sigv4(t.slice(0, -1))],
      ['the token with a character after it', (t: string) => sigv4(`${t}0`)],
      ['the token with a character before it', (t: string) => sigv4(`x${t}`)],
      ['the token in a second credential', (t: string) => sigv4(`AKIDEXAMPLE/${today()}/us-east-1/s3/aws4_request, Credential=${t}`)],
      ['the token after the signature', (t: string) => `${sigv4('AKIDEXAMPLE')} ${t}`],
      ['the token in the SignedHeaders list', (t: string) => sigv4('AKIDEXAMPLE').replace('host;x-amz-date', `host;${t}`)],
      ['a lower-case algorithm', (t: string) => sigv4(t).replace('AWS4-HMAC-SHA256', 'aws4-hmac-sha256')],
      ['two spaces after the algorithm', (t: string) => sigv4(t).replace('SHA256 ', 'SHA256  ')],
      ['a scope with a fifth field', (t: string) => sigv4(t).replace('/s3/', '/s3/x/')],
      ['SigV4A with a region in its scope', (t: string) => `AWS4-ECDSA-P256-SHA256 Credential=${t}/${today()}/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-region-set, Signature=${'0'.repeat(64)}`],
      ['SigV4A with text after the signature', (t: string) => `AWS4-ECDSA-P256-SHA256 Credential=${t}/${today()}/s3/aws4_request, SignedHeaders=host;x-amz-region-set, Signature=${'0'.repeat(64)} x`],
      ['the token as a Basic user name', (t: string) => `Basic ${Buffer.from(`${t}:x`).toString('base64')}`],
    ])('%s is refused before the vault is read', async (_name, header) => {
      const token = await routeToken();
      const before = store.gets;
      const res = await send(address(), { path: '/aws/my-bucket/key', headers: { Authorization: header(token) } });
      expect(res.status).toBe(401);
      expect(res.body).not.toContain(REAL_SECRET);
      expect(aws.requests.length).toBe(0);
      expect(store.gets).toBe(before);
    });

    it('the route token without a SigV4 header names nowhere to send the request', async () => {
      const token = await routeToken();
      const before = store.gets;
      const bearer = await send(address(), { path: '/aws/my-bucket/key', headers: { Authorization: `Bearer ${token}` } });
      expect(bearer.status).toBe(400);
      expect(JSON.parse(bearer.body)).toMatchObject({ code: 'sigv4_authorization_malformed', fix: expect.stringContaining('AWS_ENDPOINT_URL') });
      const none = await send(address(), { path: '/aws/my-bucket/key', headers: { 'x-aquaman-token': token } });
      expect(none.status).toBe(401);
      expect(JSON.parse(none.body)).toMatchObject({ code: 'sigv4_authorization_missing', fix: expect.stringContaining('AWS_ENDPOINT_URL') });
      expect(aws.requests.length).toBe(0);
      expect(store.gets).toBe(before);
    });

    it('the Unix socket and the agent hosts\' token forward to aws only when it is a forwarded service', async () => {
      expect((await udsFetch(socketPath, '/aws/my-bucket/key', { headers: { Authorization: sigv4('AKIDEXAMPLE') } })).status).toBe(404);
      expect((await send(address(), { path: '/aws/my-bucket/key', headers: { Authorization: sigv4('AKIDEXAMPLE'), 'x-aquaman-token': LOOPBACK_TOKEN } })).status).toBe(404);
      expect(aws.requests.length).toBe(0);

      await start({ allowed: ['aws'] });
      expect((await udsFetch(socketPath, '/aws/my-bucket/key', { headers: { Authorization: sigv4('AKIDEXAMPLE') } })).status).toBe(200);
      expect((await send(address(), { path: '/aws/my-bucket/key', headers: { Authorization: sigv4('AKIDEXAMPLE'), 'x-aquaman-token': LOOPBACK_TOKEN } })).status).toBe(200);
      expect(aws.requests.map((r) => r.verified)).toEqual([true, true]);
      expect(upstreamText()).not.toContain(LOOPBACK_TOKEN);
    });

    it('SigV4A is refused with its own reason, for a routed program and over the socket, before the vault is read', async () => {
      const token = await routeToken();
      const sigv4a = (id: string) => `AWS4-ECDSA-P256-SHA256 Credential=${id}/${today()}/s3/aws4_request, SignedHeaders=host;x-amz-region-set, Signature=${'0'.repeat(140)}`;
      const before = store.gets;
      const routedProgram = await send(address(), { path: '/aws/my-bucket/key', headers: { Authorization: sigv4a(token) } });
      expect(routedProgram.status).toBe(400);
      expect(JSON.parse(routedProgram.body)).toMatchObject({ code: 'sigv4a_unsupported', fix: expect.any(String) });
      // The agent hosts' token is not accepted in that position either.
      expect((await send(address(), { path: '/aws/my-bucket/key', headers: { Authorization: sigv4a(LOOPBACK_TOKEN) } })).status).toBe(401);
      expect(store.gets).toBe(before);

      await start({ allowed: ['aws'] });
      const res = await udsFetch(socketPath, '/aws/my-bucket/key', { headers: { Authorization: sigv4a('AKIDEXAMPLE') } });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ code: 'sigv4a_unsupported', fix: expect.any(String) });
      expect(aws.requests.length).toBe(0);
    });

    it('a presigned URL fetched on its own carries the token in no header, and is refused like any request without one', async () => {
      const token = await routeToken();
      const before = store.gets;
      const query = `X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${token}%2F${today()}%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=${today()}T000000Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host&X-Amz-Signature=${'0'.repeat(64)}`;
      const res = await send(address(), { path: `/aws/my-bucket/key?${query}` });
      expect(res.status).toBe(401);
      expect(aws.requests.length).toBe(0);
      expect(store.gets).toBe(before);
    });
  });

  describe('where the request goes', () => {
    it.each([
      ['the default: signing name and region', '/aws/my-bucket/key', 'eu-west-1', 's3', 's3.eu-west-1.amazonaws.com', 'eu-west-1', '/my-bucket/key'],
      ['an endpoint prefix that is not the signing name', '/aws/_host/bedrock-runtime/model/m/invoke', 'us-west-2', 'bedrock', 'bedrock-runtime.us-west-2.amazonaws.com', 'us-west-2', '/model/m/invoke'],
      ['a global endpoint, signed for us-east-1 whatever the client signed for', '/aws/_global/', 'eu-west-1', 'iam', 'iam.amazonaws.com', 'us-east-1', '/'],
      ['a GovCloud region', '/aws/', 'us-gov-west-1', 'sts', 'sts.us-gov-west-1.amazonaws.com', 'us-gov-west-1', '/'],
      ['a trailing slash, which is part of the path AWS routes on', '/aws/2015-03-31/functions/', 'us-east-1', 'lambda', 'lambda.us-east-1.amazonaws.com', 'us-east-1', '/2015-03-31/functions/'],
      ['a first segment that looks like a host', '/aws/evil.example/x', 'us-east-1', 's3', 's3.us-east-1.amazonaws.com', 'us-east-1', '/evil.example/x'],
      ['an at sign, which stays in the path', '/aws/@evil.example/x', 'us-east-1', 's3', 's3.us-east-1.amazonaws.com', 'us-east-1', '/%40evil.example/x'],
      ['a colon and a port, which stay in the path', '/aws/evil.example:443/x', 'us-east-1', 's3', 's3.us-east-1.amazonaws.com', 'us-east-1', '/evil.example%3A443/x'],
      ['an at sign for a service other than S3', '/aws/@evil.example/x', 'us-east-1', 'execute-api', 'execute-api.us-east-1.amazonaws.com', 'us-east-1', '/@evil.example/x'],
      ['_host later in the path, which is a key and not a selector', '/aws/my-bucket/_host/evil', 'us-east-1', 's3', 's3.us-east-1.amazonaws.com', 'us-east-1', '/my-bucket/_host/evil'],
    ])('%s', async (_name, path, region, service, host, signedRegion, upstreamPath) => {
      const token = await routeToken();
      const res = await send(address(), { path, headers: { Authorization: sigv4(token, region, service) } });
      expect(res.status).toBe(200);
      const seen = aws.last()!;
      expect(seen.verified).toBe(true);
      expect(seen.host).toBe(host);
      expect(seen.region).toBe(signedRegion);
      expect(seen.service).toBe(service);
      expect(seen.url).toBe(upstreamPath);
    });

    it.each([
      ['a region with a dot', { region: 'us-east-1.evil.example' }],
      ['a region that is one label of an attacker name', { region: 'evil' }],
      ['a region shaped like an EC2 host name', { region: 'compute-1' }],
      ['a region with an encoded dot', { region: 'us-east-1%2eevil' }],
      ['a region with a slash', { region: 'us-east-1/evil.example' }],
      ['a region of another partition', { region: 'cn-north-1' }],
      ['a service with a dot', { service: 's3.evil.example' }],
      ['a service with a slash', { service: 'evil.example/s3' }],
      ['a service with an at sign', { service: 'x@evil.example' }],
      ['a service with a colon', { service: 'evil.example:443' }],
      ['a service that is a hyphen', { service: '-' }],
      ['an upper-case service', { service: 'S3' }],
      ['_host with a name of several labels', { path: '/aws/_host/evil.example/x' }],
      ['_host with a trailing dot', { path: '/aws/_host/evil.example./x' }],
      ['_host with a port', { path: '/aws/_host/evil.example:443/x' }],
      ['_host with user info', { path: '/aws/_host/s3@evil.example/x' }],
      ['_host with an encoded slash', { path: '/aws/_host/evil.example%2Fx/y' }],
      ['_host with an encoded dot', { path: '/aws/_host/evil%2Eexample/x' }],
      ['_host with a double-encoded dot', { path: '/aws/_host/evil%252Eexample/x' }],
      ['_host with an upper-case name', { path: '/aws/_host/EVIL/x' }],
      ['_host with an underscore', { path: '/aws/_host/evil_host/x' }],
      ['_host with an encoded NUL', { path: '/aws/_host/evil%00/x' }],
      ['_host with nothing after it', { path: '/aws/_host' }],
      ['_host naming a bucket by its virtual-hosted name', { path: '/aws/_host/attacker-bucket.s3/key' }],
      ['a scheme-relative path', { path: '/aws//evil.example/x' }],
      ['a backslash before a host', { path: '/aws/\\evil.example/x' }],
      ['dot segments', { path: '/aws/../evil.example/x' }],
      ['encoded dot segments', { path: '/aws/%2e%2e/evil.example/x' }],
      ['an absolute-form request target', { path: 'http://evil.example/aws/x' }],
      ['an absolute-form target for an AWS host', { path: 'https://s3.us-east-1.amazonaws.com/aws/x' }],
      ['a doubled slash inside the path', { path: '/aws/my-bucket//key' }],
      ['a Host header naming another host', { headers: { Host: 'evil.example' } }],
      ['a Host header naming an AWS host', { headers: { Host: 's3.us-east-1.amazonaws.com' } }],
    ] as Array<[string, { region?: string; service?: string; path?: string; headers?: Record<string, string> }]>)('refuses %s, and nothing is sent', async (_name, attack) => {
      const token = await routeToken();
      const before = store.gets;
      const res = await send(address(), {
        path: attack.path ?? '/aws/my-bucket/key',
        headers: { Authorization: sigv4(token, attack.region ?? 'us-east-1', attack.service ?? 's3'), ...attack.headers },
      });
      expect([400, 401, 403]).toContain(res.status);
      expect(res.body).not.toContain(REAL_SECRET);
      expect(aws.requests.length).toBe(0);
      expect(store.gets).toBe(before);
    });

    it.each([
      ['X-Forwarded-Host', { 'X-Forwarded-Host': 'evil.example' }],
      ['Forwarded', { Forwarded: 'host=evil.example;proto=https' }],
      ['X-Host', { 'X-Host': 'evil.example' }],
      ['X-Original-URL with another host', { 'X-Original-URL': 'https://evil.example/my-bucket/key' }],
      ['an x-amz header that looks like an endpoint', { 'X-Amz-Endpoint': 'evil.example' }],
    ])('a %s header does not change the host that is addressed and signed', async (_name, headers) => {
      const token = await routeToken();
      const res = await send(address(), { path: '/aws/my-bucket/key', headers: { Authorization: sigv4(token), ...headers } });
      expect(res.status).toBe(200);
      expect(aws.last()!.host).toBe('s3.us-east-1.amazonaws.com');
      expect(aws.last()!.verified).toBe(true);
    });

    it('a redirect from AWS is handed to the client, not followed', async () => {
      const token = await routeToken();
      aws.respond(() => ({ status: 301, headers: { Location: 'https://evil.example/my-bucket/key' } }));
      const res = await send(address(), { path: '/aws/my-bucket/key', headers: { Authorization: sigv4(token) } });
      expect(res.status).toBe(301);
      expect(res.headers.location).toBe('https://evil.example/my-bucket/key');
      expect(aws.requests.length).toBe(1);
    });
  });

  describe('what reaches AWS besides the request', () => {
    it.each([
      ['the client signature itself', (t: string) => ({ Authorization: sigv4(t) })],
      ['the bare token in another header', (t: string) => ({ Authorization: sigv4(t), 'X-Debug-Key': t })],
      ['the token wrapped in another header', (t: string) => ({ Authorization: sigv4(t), 'X-Debug': `key=${t};` })],
      ['the client signature repeated in Proxy-Authorization', (t: string) => ({ Authorization: sigv4(t), 'Proxy-Authorization': sigv4(t) })],
      ['the client signature repeated in a forwarding header', (t: string) => ({ Authorization: sigv4(t), 'X-Forwarded-Authorization': sigv4(t) })],
      ['the client signature repeated in an x-amz header', (t: string) => ({ Authorization: sigv4(t), 'X-Amz-Meta-Auth': sigv4(t) })],
      ['the token in a cookie', (t: string) => ({ Authorization: sigv4(t), Cookie: `session=${t}` })],
      ['the token in x-aquaman-token and x-api-key', (t: string) => ({ Authorization: sigv4(t), 'x-aquaman-token': t, 'x-api-key': t })],
      ['the token in a Basic value in another header', (t: string) => ({ Authorization: sigv4(t), 'X-Auth': `Basic ${Buffer.from(`u:${t}`).toString('base64')}` })],
      ['the agent hosts\' token in another header', (t: string) => ({ Authorization: sigv4(t), 'X-Auth': LOOPBACK_TOKEN })],
      ['the placeholder secret in a header', (t: string) => ({ Authorization: sigv4(t), 'X-Amz-Meta-Secret': SIGV4_PLACEHOLDER_SECRET })],
      ['the client session token', (t: string) => ({ Authorization: sigv4(t), 'X-Amz-Security-Token': CLIENT_SESSION })],
    ])('never %s', async (_name, headers) => {
      const token = await routeToken();
      const res = await send(address(), { path: '/aws/my-bucket/key', headers: { ...headers(token), 'X-Kept': 'kept-value' } });
      expect(res.status).toBe(200);
      const seen = aws.last()!;
      expect(seen.verified).toBe(true);
      expect(seen.headers['x-kept']).toBe('kept-value');
      expect(seen.headers['x-amz-security-token']).toBeUndefined();
      const text = upstreamText();
      expect(text).not.toContain(token);
      expect(text).not.toContain(LOOPBACK_TOKEN);
      expect(text).not.toContain(SIGV4_PLACEHOLDER_SECRET);
      expect(text).not.toContain(CLIENT_SESSION);
      expect(text).not.toContain('0'.repeat(64));
    });

    it.each([
      ['the route token in the query string', (t: string) => `/aws/my-bucket/key?marker=${t}`],
      ['the route token in the path', (t: string) => `/aws/my-bucket/${t}`],
      ['the route token percent-encoded in the path', (t: string) => `/aws/my-bucket/${t.replace('_', '%5F')}`],
      ['the agent hosts\' token in the query string', () => `/aws/my-bucket/key?x=${LOOPBACK_TOKEN}`],
      ['the placeholder secret in the query string', () => `/aws/my-bucket/key?x=${SIGV4_PLACEHOLDER_SECRET}`],
    ])('refuses a request with %s', async (_name, path) => {
      const token = await routeToken();
      const before = store.gets;
      const res = await send(address(), { path: path(token), headers: { Authorization: sigv4(token) } });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ code: 'sigv4_local_token_in_url', fix: expect.any(String) });
      expect(aws.requests.length).toBe(0);
      expect(store.gets).toBe(before);
    });

    it('the stored session token is sent and signed when there is one, and the client\'s never is', async () => {
      await store.set('aws', 'session_token', REAL_SESSION);
      aws.setCredentials({ accessKeyId: REAL_KEY_ID, secretAccessKey: REAL_SECRET, sessionToken: REAL_SESSION });
      const token = await routeToken();
      const res = await send(address(), { path: '/aws/my-bucket/key', headers: { Authorization: sigv4(token), 'X-Amz-Security-Token': CLIENT_SESSION } });
      expect(res.status).toBe(200);
      const seen = aws.last()!;
      expect(seen.verified).toBe(true);
      expect(seen.headers['x-amz-security-token']).toBe(REAL_SESSION);
      expect(seen.signedHeaders).toContain('x-amz-security-token');
    });

    it('a header that only mentions AWS4-HMAC-SHA256 is forwarded unchanged', async () => {
      const token = await routeToken();
      await send(address(), { path: '/aws/my-bucket/key', headers: { Authorization: sigv4(token), 'X-Note': 'signed with AWS4-HMAC-SHA256 by the proxy' } });
      expect(aws.last()!.headers['x-note']).toBe('signed with AWS4-HMAC-SHA256 by the proxy');
    });

    // The proxy looks for its tokens as they are and inside a Basic value. It
    // does not search header values for the token under other encodings.
    it.fails('limit: the route token base64-encoded in a header without the Basic scheme is forwarded', async () => {
      const token = await routeToken();
      await send(address(), { path: '/aws/my-bucket/key', headers: { Authorization: sigv4(token), 'X-Blob': Buffer.from(`u:${token}`).toString('base64') } });
      expect(aws.requests.length).toBe(1);
      expect(upstreamText()).not.toContain(token);
    });

    // The body is hashed, not read for content.
    it.fails('limit: a local token written into the request body is forwarded with the body', async () => {
      const token = await routeToken();
      await send(address(), { method: 'PUT', path: '/aws/my-bucket/key', headers: { Authorization: sigv4(token) }, body: `token=${token}` });
      expect(aws.requests.length).toBe(1);
      expect(aws.last()!.body.toString()).not.toContain(token);
    });

    it('the request log and the audit callback never hold a token or a stored value', async () => {
      const token = await routeToken();
      await send(address(), { path: '/aws/my-bucket/key', headers: { Authorization: sigv4(token) } });
      await send(address(), { path: '/aws/_host/evil.example/x', headers: { Authorization: sigv4(token) } });
      const text = JSON.stringify(log);
      expect(text).not.toContain(token);
      expect(text).not.toContain(REAL_SECRET);
      expect(text).not.toContain(REAL_KEY_ID);
    });
  });

  describe('what the signature covers', () => {
    const jsonHeaders = (t: string, extra: Record<string, string | string[]> = {}) => ({
      Authorization: sigv4(t, 'us-east-1', 'dynamodb'),
      'Content-Type': 'application/x-amz-json-1.0',
      'X-Amz-Target': 'DynamoDB_20120810.GetItem',
      ...extra,
    });
    const BODY = JSON.stringify({ TableName: 'orders', Key: { id: { S: '42' } } });

    it('the body that is sent, the content type and every x-amz header', async () => {
      const token = await routeToken();
      const res = await send(address(), { method: 'POST', path: '/aws/', headers: jsonHeaders(token), body: BODY });
      expect(res.status).toBe(200);
      const seen = aws.last()!;
      expect(seen.verified).toBe(true);
      expect(seen.host).toBe('dynamodb.us-east-1.amazonaws.com');
      expect(seen.body.toString()).toBe(BODY);
      expect(seen.signedHeaders).toEqual(['content-type', 'host', 'x-amz-content-sha256', 'x-amz-date', 'x-amz-target']);
    });

    it.each([
      ['a date in the future', { 'X-Amz-Date': '20990101T000000Z' }],
      ['a date in the past', { 'X-Amz-Date': '20150830T123600Z' }],
      ['the date sent twice', { 'X-Amz-Date': ['20990101T000000Z', '20150830T123600Z'] }],
      ['the hash of another body', { 'X-Amz-Content-Sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }],
      ['an unsigned payload, to a service that is not S3', { 'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD' }],
      ['a session token of its own', { 'X-Amz-Security-Token': CLIENT_SESSION }],
      ['an x-amz header with runs of spaces', { 'X-Amz-Meta-Note': 'a   b    c  ' }],
      ['an x-amz header sent twice', { 'X-Amz-Meta-Tag': ['one', 'two'] }],
      ['an x-amz header in UTF-8', { 'X-Amz-Meta-Owner': Buffer.from('Jürgen Müller', 'utf8').toString('latin1') }],
      ['a body sent in chunks', { 'Transfer-Encoding': 'chunked' }],
      ['an Expect header', { Expect: '100-continue' }],
    ] as Array<[string, Record<string, string | string[]>]>)('the proxy signs its own reading when the client sends %s', async (_name, extra) => {
      const token = await routeToken();
      const res = await send(address(), { method: 'POST', path: '/aws/', headers: jsonHeaders(token, extra), body: BODY });
      expect(res.status).toBe(200);
      const seen = aws.last()!;
      // The stand-in refuses a date that is not now, a hash that is not the
      // body's, an unsigned x-amz header and a session token nobody stored.
      expect(seen.problems).toEqual([]);
      expect(seen.body.toString()).toBe(BODY);
      expect(seen.headers['x-amz-date']).toMatch(new RegExp(`^${today()}T\\d{6}Z$`));
    });

    it('an empty body is signed as the empty hash, and a GET carries no content-length', async () => {
      const token = await routeToken();
      await send(address(), { path: '/aws/my-bucket/key', headers: { Authorization: sigv4(token) } });
      const seen = aws.last()!;
      expect(seen.headers['x-amz-content-sha256']).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
      expect(seen.headers['content-length']).toBeUndefined();
    });

    it.each([
      ['a query string out of order', '/aws/my-bucket?prefix=a%2Fb&list-type=2&delimiter=%2F'],
      ['a parameter without a value', '/aws/my-bucket?acl'],
      ['a repeated parameter', '/aws/my-bucket?tag=b&tag=a'],
      ['an S3 key with spaces, quotes and brackets', "/aws/my-bucket/a%20b/it's%20(1)*.txt"],
      ['an S3 key with an encoded slash and a plus', '/aws/my-bucket/a%2Fb/c%2Bd'],
      ['an S3 key in UTF-8', '/aws/my-bucket/%C3%BCber/%E2%9C%93.txt'],
    ])('S3: %s verifies', async (_name, path) => {
      const token = await routeToken();
      const res = await send(address(), { path, headers: { Authorization: sigv4(token) } });
      expect(res.status).toBe(200);
      expect(aws.last()!.problems).toEqual([]);
    });

    it.each([
      ['a model id with a colon', '/aws/_host/bedrock-runtime/model/anthropic.claude-3%3A0/invoke', 'bedrock'],
      ['an ARN in the path', '/aws/2015-03-31/functions/arn%3Aaws%3Alambda%3Aus-east-1%3A123456789012%3Afunction%3Afn/invocations', 'lambda'],
      ['a path with a query', '/aws/v1/items/a%20b?limit=5&next=x%3D%3D', 'execute-api'],
    ])('other services: %s verifies', async (_name, path, service) => {
      const token = await routeToken();
      const res = await send(address(), { method: 'POST', path, headers: { Authorization: sigv4(token, 'us-east-1', service) }, body: '{}' });
      expect(res.status).toBe(200);
      expect(aws.last()!.problems).toEqual([]);
    });

    it('S3 with an unsigned payload is streamed through and signed as unsigned', async () => {
      const token = await routeToken();
      const body = Buffer.alloc(256 * 1024, 7);
      const res = await send(address(), {
        method: 'PUT', path: '/aws/my-bucket/big.bin',
        headers: { Authorization: sigv4(token), 'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD', 'Content-Length': String(body.length) },
        body,
      });
      expect(res.status).toBe(200);
      const seen = aws.last()!;
      expect(seen.problems).toEqual([]);
      expect(seen.headers['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD');
      expect(seen.body.equals(body)).toBe(true);
    });
  });

  describe('header smuggling', () => {
    const smuggle = async (lines: string[]) => {
      const token = await routeToken();
      return rawBytes(address(), [
        'GET /aws/my-bucket/key HTTP/1.1',
        `Host: ${address()}`,
        `Authorization: ${sigv4(token)}`,
        ...lines,
        'Connection: close',
        '', '',
      ].join('\r\n'));
    };

    it.each([
      ['a second Host header', ['Host: evil.example']],
      ['a second Authorization header for another region', [`Authorization: ${sigv4('AKIDEXAMPLE', 'eu-west-1', 'iam')}`]],
      ['a header continued onto the next line', ['X-Note: one', ' Host: evil.example']],
      ['a bare line feed inside a header', ['X-Note: one\nHost: evil.example']],
      ['a carriage return inside a header', ['X-Note: one\rHost: evil.example']],
      ['an x-amz-date continued with a second value', ['X-Amz-Date: 20990101T000000Z', ' 20150830T123600Z']],
      ['a NUL inside a header', ['X-Note: a\u0000b']],
      ['a space before the colon of Host', ['Host : evil.example']],
      ['Transfer-Encoding and Content-Length together', ['Content-Length: 4', 'Transfer-Encoding: chunked']],
    ])('%s is refused, or forwarded with the host and the signature the proxy chose', async (_name, lines) => {
      const status = await smuggle(lines);
      // Either Node's parser refused the bytes, or one request went out. The
      // check after each test holds every forwarded request to the AWS host
      // and a valid signature.
      expect(status === '' || /^HTTP\/1\.1 (200|400|401|403) /.test(status)).toBe(true);
      expect(aws.requests.length).toBeLessThanOrEqual(1);
      for (const r of aws.requests) {
        expect(r.host).toBe('s3.us-east-1.amazonaws.com');
        expect(r.region).toBe('us-east-1');
        expect(r.service).toBe('s3');
      }
    });

    it('the rows above reach the proxy: a plain request sent the same way is forwarded', async () => {
      expect(await smuggle([])).toBe('HTTP/1.1 200 OK');
      expect(aws.requests.length).toBe(1);
    });
  });

  describe('what the proxy does not sign', () => {
    it.each([
      ['chunk signatures', { 'X-Amz-Content-Sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD' }, '/aws/my-bucket/key', 'sigv4_streaming_unsupported'],
      ['chunk signatures with a trailer', { 'X-Amz-Content-Sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER' }, '/aws/my-bucket/key', 'sigv4_streaming_unsupported'],
      ['a presigned URL', {}, `/aws/my-bucket/key?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKID%2F20150830%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Signature=${'0'.repeat(64)}`, 'sigv4_presigned_unsupported'],
      ['a session token in the query string', {}, '/aws/my-bucket/key?X-Amz-Security-Token=abc', 'sigv4_presigned_unsupported'],
      ['a plus sign in the query string', {}, '/aws/my-bucket?prefix=a+b', 'sigv4_query_ambiguous'],
    ] as Array<[string, Record<string, string>, string, string]>)('%s: refused with a fix, before the vault is read', async (_name, headers, path, code) => {
      const token = await routeToken();
      const before = store.gets;
      const res = await send(address(), { method: 'PUT', path, headers: { Authorization: sigv4(token), ...headers }, body: 'x' });
      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code).toBe(code);
      expect(body.fix).toEqual(expect.any(String));
      expect(body.fix).not.toBe('');
      expect(aws.requests.length).toBe(0);
      expect(store.gets).toBe(before);
      expect(log.some((r) => r.service === 'aws' && r.statusCode === 400 && (r.error ?? '').startsWith(code))).toBe(true);
    });

    it('an unsigned trailer upload is forwarded to S3 only', async () => {
      const token = await routeToken();
      const res = await send(address(), {
        method: 'PUT', path: '/aws/vaults/v/archives',
        headers: { Authorization: sigv4(token, 'us-east-1', 'glacier'), 'X-Amz-Content-Sha256': 'STREAMING-UNSIGNED-PAYLOAD-TRAILER' },
        body: 'x',
      });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).code).toBe('sigv4_streaming_unsupported');
      expect(aws.requests.length).toBe(0);
    });

    /** Sends headers, then body chunks until the proxy answers. */
    const upload = (headers: Record<string, string>, chunks: number): Promise<Sent> => {
      const [host, port] = address().split(':');
      return new Promise((resolve, reject) => {
        const req = http.request({ host, port: Number(port), path: '/aws/', method: 'POST', headers }, (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => { req.destroy(); resolve({ status: res.statusCode ?? 0, body, headers: res.headers }); });
          res.on('error', reject);
        });
        // The proxy closes the connection once it has answered; writes after that fail, as they should.
        req.on('error', () => {});
        req.flushHeaders();
        const chunk = Buffer.alloc(1024 * 1024, 1);
        let sent = 0;
        const more = () => {
          if (sent++ >= chunks || req.destroyed) return;
          req.write(chunk, () => setImmediate(more));
        };
        more();
      });
    };

    it.each([
      ['a declared length over the cap', (t: string) => ({ Authorization: sigv4(t, 'us-east-1', 'dynamodb'), 'Content-Length': String(SIGV4_MAX_BUFFERED_BODY + 1) }), 0],
      ['a chunked body that runs over the cap', (t: string) => ({ Authorization: sigv4(t, 'us-east-1', 'dynamodb'), 'Transfer-Encoding': 'chunked' }), SIGV4_MAX_BUFFERED_BODY / (1024 * 1024) + 2],
    ])('a body larger than the cap is refused: %s', async (_name, headers, chunks) => {
      const token = await routeToken();
      const before = store.gets;
      const res = await upload(headers(token), chunks);
      expect(res.status).toBe(413);
      expect(JSON.parse(res.body)).toMatchObject({ code: 'sigv4_body_too_large', fix: expect.stringContaining('UNSIGNED-PAYLOAD') });
      expect(aws.requests.length).toBe(0);
      expect(store.gets).toBe(before);
    });

    it('a body at the cap is hashed and forwarded', async () => {
      const token = await routeToken();
      const body = Buffer.alloc(SIGV4_MAX_BUFFERED_BODY, 3);
      const res = await send(address(), { method: 'POST', path: '/aws/', headers: { Authorization: sigv4(token, 'us-east-1', 'dynamodb') }, body });
      expect(res.status).toBe(200);
      expect(aws.last()!.problems).toEqual([]);
      expect(aws.last()!.body.length).toBe(SIGV4_MAX_BUFFERED_BODY);
    });

    it('a request with no stored secret is refused with the command that adds it', async () => {
      const token = await routeToken();
      await store.delete('aws', 'secret_access_key');
      const res = await send(address(), { path: '/aws/my-bucket/key', headers: { Authorization: sigv4(token) } });
      expect(res.status).toBe(401);
      expect(JSON.parse(res.body)).toEqual({ error: 'No credential found for aws/secret_access_key', fix: 'Run: aquaman credentials add aws secret_access_key' });
      expect(aws.requests.length).toBe(0);
    });
  });

  describe('request policy', () => {
    it.each([
      ['the plain path', 'DELETE', '/aws/protected-bucket/key', {}],
      ['an upper-case spelling of the path', 'DELETE', '/aws/PROTECTED-BUCKET/key', {}],
      ['an encoded slash in the path', 'DELETE', '/aws/protected-bucket%2Fkey', {}],
      ['a method-override header on a GET', 'GET', '/aws/protected-bucket/key', { 'X-HTTP-Method-Override': 'DELETE' }],
      ['a path named by X-Original-URL', 'DELETE', '/aws/other-bucket/key', { 'X-Original-URL': '/protected-bucket/key' }],
      ['the same bucket through the _host selector', 'DELETE', '/aws/_host/s3/protected-bucket/key', {}],
      ['the same bucket through the _global selector', 'DELETE', '/aws/_global/protected-bucket/key', {}],
      ['the same bucket through a dual-stack-looking endpoint', 'DELETE', '/aws/_host/s3-fips/protected-bucket/key', {}],
    ] as Array<[string, string, string, Record<string, string>]>)('a denied request spelled as %s is refused before any vault read', async (_name, method, path, extra) => {
      const token = await routeToken();
      const before = store.gets;
      const res = await send(address(), { method, path, headers: { Authorization: sigv4(token), ...extra } });
      expect(res.status).toBe(403);
      expect(res.body).not.toContain(REAL_SECRET);
      expect(store.gets).toBe(before);
      expect(aws.requests.length).toBe(0);
      expect(log.some((r) => r.statusCode === 403 && /Policy denied/.test(r.error ?? ''))).toBe(true);
    });

    it('a rule sees the path AWS receives, so one rule covers every way of choosing the host', async () => {
      await start({ policy: { aws: { defaultAction: 'deny', rules: [{ method: 'POST', path: '/model/*/invoke', action: 'allow' }] } } });
      const token = await routeToken();
      const allowed = await send(address(), { method: 'POST', path: '/aws/_host/bedrock-runtime/model/m/invoke', headers: { Authorization: sigv4(token, 'us-east-1', 'bedrock') }, body: '{}' });
      expect(allowed.status).toBe(200);
      const denied = await send(address(), { method: 'POST', path: '/aws/_host/bedrock-runtime/model/m/converse', headers: { Authorization: sigv4(token, 'us-east-1', 'bedrock') }, body: '{}' });
      expect(denied.status).toBe(403);
      expect(aws.requests.length).toBe(1);
    });

    it('a request the policy allows is signed and forwarded, with one audit entry', async () => {
      const token = await routeToken();
      log.length = 0;
      const res = await send(address(), { method: 'DELETE', path: '/aws/other-bucket/key', headers: { Authorization: sigv4(token) } });
      expect(res.status).toBe(200);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ service: 'aws', method: 'DELETE', statusCode: 200, authenticated: true });
      expect(log[0].error).toBeUndefined();
    });

    // Policy matches the method and the path. Many AWS APIs put the action in
    // the X-Amz-Target header or in the body, on one path for every action.
    it.fails('limit: an action named in X-Amz-Target is not seen by policy, so a rule that allows DynamoDB reads allows DeleteTable', async () => {
      await start({ policy: { aws: { defaultAction: 'deny', rules: [{ method: 'POST', path: '/', action: 'allow' }] } } });
      const token = await routeToken();
      const res = await send(address(), {
        method: 'POST', path: '/aws/',
        headers: { Authorization: sigv4(token, 'us-east-1', 'dynamodb'), 'Content-Type': 'application/x-amz-json-1.0', 'X-Amz-Target': 'DynamoDB_20120810.DeleteTable' },
        body: JSON.stringify({ TableName: 'orders' }),
      });
      expect(res.status).toBe(403);
    });

    // The service is in the credential scope and the host, not in the path.
    it.fails('limit: a path rule cannot tell one AWS service from another, so a rule that allows POST / for DynamoDB allows it for every service', async () => {
      await start({ policy: { aws: { defaultAction: 'deny', rules: [{ method: 'POST', path: '/', action: 'allow' }] } } });
      const token = await routeToken();
      const res = await send(address(), {
        method: 'POST', path: '/aws/',
        headers: { Authorization: sigv4(token, 'us-east-1', 'sts'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'Action=GetCallerIdentity&Version=2011-06-15',
      });
      expect(res.status).toBe(403);
    });
  });

  it('refuses a request whose Host header is not a loopback name, whatever it is signed with', async () => {
    const token = await routeToken();
    const res = await send(address(), { path: '/aws/my-bucket/key', headers: { Host: 'attacker.example', Authorization: sigv4(token) } });
    expect(res.status).toBe(403);
    expect(aws.requests.length).toBe(0);
  });
});
