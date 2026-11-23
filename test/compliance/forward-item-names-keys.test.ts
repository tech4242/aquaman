/**
 * Conformance: every key a services.yaml definition names is checked against
 * the items of built-in services, whatever form it is written in. A key that
 * is not a plain key name (a YAML list, which a store would turn into text)
 * is refused when the file is read; a key under `additionalHeaders` or
 * `oauthConfig` is compared like the primary one; and a name that differs
 * from a built-in's item only by case is refused before the vault is asked.
 *
 * Same harness as forward-item-names.test.ts: real OnePasswordStore over a
 * stand-in for `op`, real proxy, stand-in upstream on localhost.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawnSync: vi.fn(),
}));

import { createCredentialProxy, createBrokerScope, ServiceRegistry, type CredentialProxy } from 'aquaman-proxy';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../helpers/uds-proxy.js';

const CF_AI_SECRET = 'cloudflare-ai-builtin-key-0123456789abcdef';
const GCHAT_SECRET = 'google-chat-service-account-0123456789abcdef';
const OWN = 'the-custom-services-own-key-0123456789';
const opTitles: string[] = [];

function fakeOp(items: Record<string, string>): void {
  vi.mocked(spawnSync).mockImplementation(((cmd: string, args: string[]) => {
    const ok = (stdout: string) => ({ status: 0, stdout, stderr: '', pid: 1, signal: null, output: [] });
    if (cmd === 'which') return ok('/usr/local/bin/op\n');
    if (args[0] === 'account') return ok('{}');
    if (args[0] === 'item' && args[1] === 'get') {
      opTitles.push(String(args[2]));
      return args[2] in items
        ? ok(JSON.stringify({ value: items[args[2]] }))
        : { status: 1, stdout: '', stderr: `"${args[2]}" isn't an item`, pid: 1, signal: null, output: [] };
    }
    return { status: 1, stdout: '', stderr: 'not implemented', pid: 1, signal: null, output: [] };
  }) as never);
}

describe('forwarding for a services.yaml service: every key it names', () => {
  let dir: string;
  let proxy: CredentialProxy;
  let upstream: http.Server;
  let socketPath = '';
  const seen: string[] = [];

  async function startWith(yaml: string[], allowed: string[]): Promise<void> {
    const upstreamPort = await new Promise<number>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve((upstream.address() as net.AddressInfo).port)));
    const servicesPath = path.join(dir, 'services.yaml');
    fs.writeFileSync(servicesPath, yaml.join('\n').replaceAll('UPSTREAM', `http://127.0.0.1:${upstreamPort}`));
    fakeOp({
      'aquaman-cloudflare-ai-api_token': CF_AI_SECRET,        // builtin cloudflare-ai/api_token
      'aquaman-google-chat-service_account': GCHAT_SECRET,    // builtin google-chat/service_account
      'aquaman-cloudflare-api_token': OWN,                    // the person's own custom "cloudflare" service
      'aquaman-google-api_key': OWN,                          // the person's own custom "google" service
    });
    const { OnePasswordStore } = await import('aquaman-core');
    const store = new OnePasswordStore();
    socketPath = tmpSocketPath();
    proxy = createCredentialProxy({
      socketPath,
      store,
      allowedServices: allowed,
      serviceRegistry: new ServiceRegistry({ configPath: servicesPath }),
      broker: createBrokerScope({
        configPath: path.join(dir, 'config.yaml'),
        projectsPath: path.join(dir, 'projects.yaml'),
        itemIdentity: (service, key) => store.itemIdentity?.(service, key),
      }),
    });
    await proxy.start();
  }

  beforeEach(() => {
    seen.length = 0;
    opTitles.length = 0;
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-review-f-')));
    upstream = http.createServer((req, res) => { seen.push(JSON.stringify(req.headers)); res.end('ok'); });
  });

  afterEach(async () => {
    if (proxy?.isRunning()) await proxy.stop();
    await new Promise((resolve) => upstream.close(resolve));
    if (socketPath) cleanupSocket(socketPath);
    fs.rmSync(dir, { recursive: true, force: true });
    vi.resetAllMocks();
  });

  it('control: the string form of the same additionalHeaders key is refused', async () => {
    await startWith([
      'services:',
      '  - name: cloudflare',
      '    upstream: UPSTREAM',
      '    authHeader: Authorization',
      '    credentialKey: api_token',
      '    additionalHeaders:',
      '      X-Extra: { credentialKey: ai-api_token }',
      '',
    ], ['cloudflare']);
    const res = await udsFetch(socketPath, '/cloudflare/anything');
    expect(res.status).toBe(403);
    expect(seen.join('\n')).not.toContain(CF_AI_SECRET);
  });

  it('an additionalHeaders key written as a YAML list ([ai-api_token]) is not sent the builtin cloudflare-ai key', async () => {
    await startWith([
      'services:',
      '  - name: cloudflare',
      '    upstream: UPSTREAM',
      '    authHeader: Authorization',
      '    credentialKey: api_token',
      '    additionalHeaders:',
      '      X-Extra: { credentialKey: [ai-api_token] }',
      '',
    ], ['cloudflare']);
    const res = await udsFetch(socketPath, '/cloudflare/anything');
    expect(seen.join('\n'), `status ${res.status}; op was asked for: ${opTitles.join(', ')}`).not.toContain(CF_AI_SECRET);
  });

  it('an oauth clientIdKey written as a YAML list is not read from the builtin google-chat item', async () => {
    await startWith([
      'services:',
      '  - name: google',
      '    upstream: UPSTREAM',
      '    authMode: oauth',
      '    credentialKey: api_key',
      '    oauthConfig:',
      '      tokenUrl: UPSTREAM/token',
      '      clientIdKey: [chat-service_account]',
      '      clientSecretKey: api_key',
      '',
    ], ['google']);
    await udsFetch(socketPath, '/google/anything');
    expect(opTitles, 'the vault item of the builtin google-chat service was read').not.toContain('aquaman-google-chat-service_account');
  });

  it('a primary key that differs from the builtin item only by case is refused before the vault is asked', async () => {
    await startWith([
      'services:',
      '  - name: cloudflare',
      '    upstream: UPSTREAM',
      '    authHeader: Authorization',
      '    credentialKey: AI-api_token',
      '',
    ], ['cloudflare']);
    const res = await udsFetch(socketPath, '/cloudflare/anything');
    // The stand-in matches titles exactly, so nothing is sent here; what this
    // row shows is that `op item get` IS run for a title equal to the builtin's
    // item up to case. Whether real `op` resolves it was not run.
    expect({ status: res.status, asked: opTitles }).toEqual({ status: 403, asked: [] });
  });
});
