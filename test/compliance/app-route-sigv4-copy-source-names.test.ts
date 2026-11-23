/**
 * Conformance, AWS path: a copy source is evaluated only when its first part
 * is a plain bucket name. An access point ARN in any encoding, a `+` that
 * may be read as a space, and white space around the name are refused for a
 * service that has rules, because policy cannot be sure S3 reads them the
 * way the proxy does.
 *
 * Same harness as app-route-sigv4.test.ts: a real proxy in this process and
 * the stand-in that re-signs each request with @smithy/signature-v4.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
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

  describe('review probes', () => {
    const DENY_BUCKET: PolicyConfig = { aws: { defaultAction: 'allow', rules: [{ method: '*', path: '/protected-bucket/**', action: 'deny' }] } };
    it.each([
      ['control: the ARN row the repo has', 'arn%3Aaws%3As3:us-east-1:123456789012:accesspoint/ap/object/secret.txt'],
      ['an access point ARN with every colon encoded (what botocore sends)', 'arn%3Aaws%3As3%3Aus-east-1%3A123456789012%3Aaccesspoint/ap/object/secret.txt'],
      ['the same with a leading slash', '/arn%3Aaws%3As3%3Aus-east-1%3A123456789012%3Aaccesspoint/ap/object/secret.txt'],
      ['the same, lower-case escapes, slashes encoded too', 'arn%3aaws%3as3%3aus-east-1%3a123456789012%3aaccesspoint%2fap%2fobject%2fsecret.txt'],
      ['an escape cut by the 16-character window', '%61%72%6e%3aaws:s3:us-east-1:123456789012:accesspoint/ap/object/secret.txt'],
      ['a plus sign (a space to S3) before the bucket', '+protected-bucket/secret.txt'],
      ['a plus sign after the bucket', 'protected-bucket+/secret.txt'],
    ])('denied under a deny-everything rule on the bucket: %s', async (_name, source) => {
      await start(DENY_BUCKET);
      const token = await routeToken();
      const res = await send(address(), { method: 'PUT', path: '/aws/other-bucket/copy.txt', headers: { Authorization: sigv4(token), 'X-Amz-Copy-Source': source } });
      expect({ status: res.status, forwarded: aws.requests.length }).toEqual({ status: 403, forwarded: 0 });
    });
  });
});
