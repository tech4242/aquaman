/**
 * E2E: an app that uses the AWS SDK for JavaScript v3, started by the real
 * `aquaman-coder exec` from a binding made by the real `aquaman-coder bind`,
 * calling S3, DynamoDB, IAM and Bedrock Runtime through a real proxy.
 *
 * The app (test/fixtures/approute/aws-sdk-v3.mjs) takes region, credentials
 * and endpoints from its environment. A local server stands in for AWS and
 * checks every signature with the stored secret, using the SDK's own signer
 * (test/helpers/aws-stand-in.ts). Nothing here talks to AWS.
 *
 * The proxy runs in this process because a daemon cannot be pointed at a
 * stand-in: the builtin aws definition cannot be overridden from a file. Its
 * socket and projects.yaml are where the CLI looks for them, so `bind` and
 * `exec` are the shipped commands, each its own process with its own HOME
 * and config directory.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createCredentialProxy, createBrokerScope, createServiceRegistry, type CredentialProxy, type RequestInfo } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import { createSandbox, fakeProxy, json, CODER_CLI, TSX, type Sandbox, type RunResult, type FakeProxy } from './cov-cli-core-helpers.js';
import { startAwsStandIn, type AwsStandIn } from '../helpers/aws-stand-in.js';
import { SIGV4_PLACEHOLDER_SECRET } from '../../packages/proxy/src/sigv4.js';

const APP = path.resolve('test/fixtures/approute/aws-sdk-v3.mjs');
const T = 120_000;

const REAL_KEY_ID = 'AKIAVAULTKEYID000002';
const REAL_SECRET = 'vaultSecretAccessKey/abcdefgh+0123456789';
const REAL_SESSION = 'IQoJb3JpZ2luX2VjEvaultSessionToken//abcdef==';
const LOOPBACK_TOKEN = 'aqm_lb_approute_aws_sdk_0123456789abcdef';
/** What a developer's shell may hold. None of it may reach AWS or be what the app signs with. */
const SHELL_SECRET = 'shellSecretAccessKeyThatMustNotBeUsed0001';
const SHELL_SESSION = 'shell-session-token-that-must-not-be-sent';

const LIST_XML = '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>reports</Name><Prefix>q3/</Prefix><KeyCount>1</KeyCount><MaxKeys>1000</MaxKeys><Delimiter>/</Delimiter><IsTruncated>false</IsTruncated><Contents><Key>q3/summary 2026.txt</Key><Size>17</Size></Contents></ListBucketResult>';
const USER_XML = '<GetUserResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><GetUserResult><User><Path>/</Path><UserName>support-app</UserName><UserId>AIDAEXAMPLE</UserId><Arn>arn:aws:iam::123456789012:user/support-app</Arn><CreateDate>2026-01-01T00:00:00Z</CreateDate></User></GetUserResult><ResponseMetadata><RequestId>00000000-0000-0000-0000-000000000000</RequestId></ResponseMetadata></GetUserResponse>';

describe('the AWS SDK for JavaScript v3 routed through the proxy', () => {
  let sb: Sandbox;
  let aws: AwsStandIn;
  let proxy: CredentialProxy;
  let store: MemoryStore;
  let log: RequestInfo[];

  const coder = (args: string[], extraEnv: Record<string, string> = {}): Promise<RunResult> =>
    new Promise((resolve, reject) => {
      const child = spawn(TSX, [CODER_CLI, ...args], { cwd: sb.project, stdio: ['ignore', 'pipe', 'pipe'], env: sb.env(extraEnv) });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  /** The environment the command is started from: a region, and AWS variables a real shell might hold. */
  const SHELL = { AWS_REGION: 'eu-central-1', AWS_SECRET_ACCESS_KEY: SHELL_SECRET, AWS_SESSION_TOKEN: SHELL_SESSION, AWS_MAX_ATTEMPTS: '1', AWS_EC2_METADATA_DISABLED: 'true' };
  const exec = (only?: string) => coder(['exec', '--', 'node', APP, ...(only ? [only] : [])], SHELL);
  const appOutput = (result: RunResult) => JSON.parse(result.stdout.trim().split('\n').pop()!);
  const upstreamText = () => aws.requests.map((r) => [r.url, ...Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`), r.body.toString('latin1')].join('\n')).join('\n');

  beforeAll(async () => {
    sb = createSandbox();
    aws = await startAwsStandIn({ accessKeyId: REAL_KEY_ID, secretAccessKey: REAL_SECRET });
    aws.respond((r) => {
      if (r.host.startsWith('s3.')) {
        if (r.method === 'PUT') return { headers: { ETag: '"etag-from-the-stand-in"' }, body: '' };
        if (r.url.startsWith('/reports/?')) return { headers: { 'Content-Type': 'application/xml' }, body: LIST_XML };
        return { headers: { 'Content-Type': 'text/plain' }, body: 'quarterly summary' };
      }
      if (r.host.startsWith('dynamodb.')) return { headers: { 'Content-Type': 'application/x-amz-json-1.0' }, body: JSON.stringify({ Item: { id: { S: '42' }, total: { N: '99' } } }) };
      if (r.host === 'iam.amazonaws.com') return { headers: { 'Content-Type': 'text/xml' }, body: USER_XML };
      if (r.host.startsWith('bedrock-runtime.')) return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ completion: 'hello from the stand-in' }) };
      return { status: 404, body: '{}' };
    });

    const registry = createServiceRegistry({ configPath: path.join(sb.config, 'services.yaml') });
    // Test only: connections go to the stand-in. Host header and signature still name the AWS host.
    registry.override('aws', { upstream: `http://127.0.0.1:${aws.port}` });
    store = new MemoryStore();
    await store.set('aws', 'access_key_id', REAL_KEY_ID);
    await store.set('aws', 'secret_access_key', REAL_SECRET);

    log = [];
    proxy = createCredentialProxy({
      socketPath: sb.socket,
      store,
      serviceRegistry: registry,
      allowedServices: [],
      broker: createBrokerScope({ configPath: path.join(sb.config, 'config.yaml'), projectsPath: path.join(sb.config, 'projects.yaml') }),
      loopback: { port: 0, token: LOOPBACK_TOKEN, host: '127.0.0.1' },
      onRequest: (info) => { log.push(info); },
    });
    await proxy.start();

    expect((await coder(['project', 'add', 'support-app', '--path', sb.project])).code).toBe(0);
  }, T);

  afterAll(async () => {
    if (proxy?.isRunning()) await proxy.stop();
    await aws?.stop();
    await sb?.cleanup();
  });

  beforeEach(() => {
    aws.clear();
    aws.setCredentials({ accessKeyId: REAL_KEY_ID, secretAccessKey: REAL_SECRET });
    log.length = 0;
  });

  it('bind records the route for the access key id, and refuses the secret access key', async () => {
    const bound = await coder(['bind', 'AWS_ACCESS_KEY_ID=aquaman://aws/access_key_id', '--via-proxy', 'AWS_ENDPOINT_URL', '--json']);
    expect(bound.code, bound.stderr || bound.stdout).toBe(0);
    const project = parseYaml(fs.readFileSync(path.join(sb.config, 'projects.yaml'), 'utf-8')).projects['support-app'];
    expect(project.env).toEqual({ AWS_ACCESS_KEY_ID: 'aquaman://aws/access_key_id' });
    expect(project.routes).toEqual({ AWS_ACCESS_KEY_ID: { url_env: 'AWS_ENDPOINT_URL' } });
  }, T);

  it('exec starts the app with a token, a placeholder secret and the proxy as its AWS endpoint, and every call is signed with the stored keys', async () => {
    const result = await exec();
    expect(result.code, result.stderr || result.stdout).toBe(0);
    const out = appOutput(result);

    // What the app was started with: no stored value, and not the shell's own secret.
    const address = proxy.getLoopbackAddress();
    expect(out.env.AWS_ENDPOINT_URL).toBe(`http://${address}/aws`);
    expect(out.env.AWS_ENDPOINT_URL_IAM).toBe(`http://${address}/aws/_global`);
    expect(out.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME).toBe(`http://${address}/aws/_host/bedrock-runtime`);
    expect(out.env.AWS_SECRET_ACCESS_KEY).toBe(SIGV4_PLACEHOLDER_SECRET);
    // exec redacts the token it injected from the command's output.
    expect(out.env.AWS_ACCESS_KEY_ID).not.toMatch(/^AKIA/);
    const everything = result.stdout + result.stderr;
    expect(everything).not.toContain(REAL_SECRET);
    expect(everything).not.toContain(REAL_KEY_ID);
    expect(everything).not.toMatch(/aqm_rt_[0-9a-f]{48}/);

    // What the app got back.
    expect(out.calls).toEqual({
      's3.put': { ok: true, result: '"etag-from-the-stand-in"' },
      's3.put-stream': { ok: true, result: '"etag-from-the-stand-in"' },
      's3.get': { ok: true, result: 'quarterly summary' },
      's3.list': { ok: true, result: ['q3/summary 2026.txt'] },
      'dynamodb.get': { ok: true, result: { id: { S: '42' }, total: { N: '99' } } },
      'iam.get-user': { ok: true, result: 'support-app' },
      'bedrock.invoke': { ok: true, result: { completion: 'hello from the stand-in' } },
    });

    // What AWS would have seen: one request per call, each one valid for the stored keys.
    expect(aws.requests.map((r) => [r.method, r.host, r.url.split('?')[0], r.region, r.service])).toEqual([
      ['PUT', 's3.eu-central-1.amazonaws.com', '/reports/q3/summary%202026.txt', 'eu-central-1', 's3'],
      ['PUT', 's3.eu-central-1.amazonaws.com', '/reports/q3/stream.bin', 'eu-central-1', 's3'],
      ['GET', 's3.eu-central-1.amazonaws.com', '/reports/q3/summary%202026.txt', 'eu-central-1', 's3'],
      ['GET', 's3.eu-central-1.amazonaws.com', '/reports/', 'eu-central-1', 's3'],
      ['POST', 'dynamodb.eu-central-1.amazonaws.com', '/', 'eu-central-1', 'dynamodb'],
      // The client signed for eu-central-1; the global endpoint is signed for us-east-1.
      ['POST', 'iam.amazonaws.com', '/', 'us-east-1', 'iam'],
      ['POST', 'bedrock-runtime.eu-central-1.amazonaws.com', '/model/anthropic.claude-opus-5-5-v1%3A0/invoke', 'eu-central-1', 'bedrock'],
    ]);
    for (const r of aws.requests) {
      expect(r.problems, `${r.method} ${r.host}${r.url}`).toEqual([]);
      expect(r.accessKeyId).toBe(REAL_KEY_ID);
    }
    expect(aws.requests[0].body.toString()).toBe('quarterly summary');
    // A stream is uploaded in the SDK's unsigned aws-chunked framing and passed through as sent.
    expect(aws.requests[1].headers['x-amz-content-sha256']).toBe('STREAMING-UNSIGNED-PAYLOAD-TRAILER');
    expect(aws.requests[1].headers['x-amz-decoded-content-length']).toBe('70000');
    expect(aws.requests[4].headers['x-amz-target']).toBe('DynamoDB_20120810.GetItem');
    expect(aws.requests[4].signedHeaders).toContain('x-amz-target');

    const sent = upstreamText();
    expect(sent).not.toMatch(/aqm_rt_[0-9a-f]{48}/);
    expect(sent).not.toContain(LOOPBACK_TOKEN);
    expect(sent).not.toContain(SIGV4_PLACEHOLDER_SECRET);
    expect(sent).not.toContain(SHELL_SECRET);
    expect(sent).not.toContain(SHELL_SESSION);

    // One audit entry per forwarded request, plus the route that was handed out.
    expect(log.filter((r) => r.service === 'aws' && r.statusCode === 200 && r.authenticated && r.method !== 'BROKER_ROUTE')).toHaveLength(7);
    expect(log.filter((r) => r.method === 'BROKER_ROUTE')).toHaveLength(1);
  }, T);

  it('a stored session token is sent with every request, and the one in the shell never is', async () => {
    await store.set('aws', 'session_token', REAL_SESSION);
    aws.setCredentials({ accessKeyId: REAL_KEY_ID, secretAccessKey: REAL_SECRET, sessionToken: REAL_SESSION });
    try {
      const result = await exec('dynamodb.get');
      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(appOutput(result).calls['dynamodb.get'].ok).toBe(true);
      expect(aws.requests).toHaveLength(1);
      expect(aws.requests[0].problems).toEqual([]);
      expect(aws.requests[0].headers['x-amz-security-token']).toBe(REAL_SESSION);
      expect(result.stdout + result.stderr).not.toContain(REAL_SESSION);
    } finally {
      await store.delete('aws', 'session_token');
    }
  }, T);

  it('the value is never handed to the project: a resolve for either key is refused', async () => {
    for (const key of ['access_key_id', 'secret_access_key']) {
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({ socketPath: sb.socket, path: '/broker/resolve', method: 'POST' }, (r) => {
          let body = '';
          r.on('data', (c) => { body += c; });
          r.on('end', () => resolve({ status: r.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end(JSON.stringify({ service: 'aws', key }));
      });
      expect(res.status, key).toBe(404);
      expect(res.body).not.toContain(REAL_SECRET);
      expect(res.body).not.toContain(REAL_KEY_ID);
    }
  }, T);

  it('exec names the missing key when the secret access key is not stored, and the app is not given a route', async () => {
    await store.delete('aws', 'secret_access_key');
    try {
      const result = await exec('dynamodb.get');
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('aws/secret_access_key');
      expect(result.stderr).toContain('aquaman credentials add aws secret_access_key');
      expect(aws.requests).toHaveLength(0);
    } finally {
      await store.set('aws', 'secret_access_key', REAL_SECRET);
    }
  }, T);

  it('the Bedrock Runtime client with its default HTTP/2 transport does not reach the listener, which speaks HTTP/1.1', async () => {
    const result = await exec('bedrock.invoke-default-transport');
    expect(result.code, result.stderr || result.stdout).toBe(0);
    const call = appOutput(result).calls['bedrock.invoke-default-transport'];
    expect(call.ok).toBe(false);
    expect(aws.requests).toHaveLength(0);
  }, T);
});

describe('which variables exec takes from a route', () => {
  let sb: Sandbox;
  let proxy: FakeProxy;

  const coder = (args: string[]): Promise<RunResult> =>
    new Promise((resolve, reject) => {
      const child = spawn(TSX, [CODER_CLI, ...args], { cwd: sb.project, stdio: ['ignore', 'pipe', 'pipe'], env: sb.env({ AWS_SECRET_ACCESS_KEY: SHELL_SECRET }) });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

  beforeAll(async () => {
    sb = createSandbox();
    fs.writeFileSync(path.join(sb.config, 'projects.yaml'), [
      'projects:',
      '  app:',
      `    paths: ["${sb.project}"]`,
      '    env:',
      '      AWS_ACCESS_KEY_ID: aquaman://aws/access_key_id',
      '      STRIPE_SECRET_KEY: aquaman://stripe/secret_key',
      '      BOUND_BY_PROJECT: aquaman://mistral/api_key',
      '    routes:',
      '      AWS_ACCESS_KEY_ID: { url_env: AWS_ENDPOINT_URL }',
      '      STRIPE_SECRET_KEY: { url_env: STRIPE_API_BASE }',
      '',
    ].join('\n'));
    // A proxy on the socket that names more variables than it should.
    proxy = await fakeProxy(sb.socket, (req, res) => {
      if (req.url === '/broker/resolve') return json(res, 200, { value: 'value-from-the-binding', expires_at: new Date().toISOString() });
      if (req.body?.service === 'stripe') return json(res, 200, { url: 'http://127.0.0.1:1/stripe', token: 'aqm_rt_stripe' });
      return json(res, 200, {
        url: 'http://127.0.0.1:1/aws',
        token: 'aqm_rt_aws',
        env: {
          AWS_SECRET_ACCESS_KEY: SIGV4_PLACEHOLDER_SECRET,
          AWS_ENDPOINT_URL_IAM: 'http://127.0.0.1:1/aws/_global',
          PATH: '/somewhere/else',
          NODE_OPTIONS: '--require /somewhere/else.js',
          LD_PRELOAD: '/somewhere/else.so',
          DYLD_INSERT_LIBRARIES: '/somewhere/else.dylib',
          HTTPS_PROXY: 'http://somewhere.else',
          'NOT A NAME': 'x',
          BOUND_BY_PROJECT: 'value-from-the-route',
          STRIPE_API_BASE: 'http://somewhere.else',
          AWS_ENDPOINT_URL: 'http://somewhere.else',
        },
      });
    });
  }, T);

  afterAll(async () => {
    await proxy?.close();
    await sb?.cleanup();
  });

  it('sets the plain ones over the shell value, and never a loader variable, a name the project binds or the URL of a route', async () => {
    const result = await coder(['exec', '--', 'node', '-e', 'console.log(JSON.stringify(process.env))']);
    expect(result.code, result.stderr).toBe(0);
    const env = JSON.parse(result.stdout.trim().split('\n').pop()!);
    expect(env.AWS_SECRET_ACCESS_KEY).toBe(SIGV4_PLACEHOLDER_SECRET);
    expect(env.AWS_ENDPOINT_URL_IAM).toBe('http://127.0.0.1:1/aws/_global');
    expect(env.AWS_ENDPOINT_URL).toBe('http://127.0.0.1:1/aws');
    expect(env.STRIPE_API_BASE).toBe('http://127.0.0.1:1/stripe');
    expect(env.PATH).toBe(sb.env().PATH);
    for (const name of ['NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'HTTPS_PROXY', 'NOT A NAME']) {
      expect(env[name], name).toBeUndefined();
    }
    // exec redacts the value it injected for this name; what matters is that the route did not replace it.
    expect(env.BOUND_BY_PROJECT).not.toBe('value-from-the-route');
    expect(result.stdout).not.toContain('somewhere');
  }, T);
});
