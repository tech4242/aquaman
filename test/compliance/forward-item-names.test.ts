/**
 * Conformance: a service that services.yaml defines is never handed an item
 * of a built-in service. On a store that joins service and key into one item
 * name (1Password here: `aquaman-<service>-<key>`), `cloudflare` +
 * `ai-api_token` spells the built-in `cloudflare-ai` key, and `openai-org` +
 * `id` spells `openai/org-id`. Forwarding for such a service is refused
 * before the vault is read, on the Unix socket and on the loopback listener.
 *
 * Real OnePasswordStore over a stand-in for `op` (no `op` is run), a real
 * proxy on a temporary socket and loopback port, a stand-in upstream on
 * localhost, services.yaml read by the real ServiceRegistry.
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

const CF_SECRET = 'cloudflare-ai-builtin-key-0123456789abcdef';
const OPENAI_SECRET = 'openai-org-id-value-0123456789abcdef';
const TOKEN = 'aqm_lb_review_e_token_0123456789abcdef';

function fakeOp(items: Record<string, string>): void {
  vi.mocked(spawnSync).mockImplementation(((cmd: string, args: string[]) => {
    const ok = (stdout: string) => ({ status: 0, stdout, stderr: '', pid: 1, signal: null, output: [] });
    if (cmd === 'which') return ok('/usr/local/bin/op\n');
    if (args[0] === 'account') return ok('{}');
    if (args[0] === 'item' && args[1] === 'get') {
      return args[2] in items
        ? ok(JSON.stringify({ value: items[args[2]] }))
        : { status: 1, stdout: '', stderr: `"${args[2]}" isn't an item`, pid: 1, signal: null, output: [] };
    }
    return { status: 1, stdout: '', stderr: 'not implemented', pid: 1, signal: null, output: [] };
  }) as never);
}

const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});

describe('forwarding for a services.yaml service and the items of built-in services', () => {
  let dir: string;
  let proxy: CredentialProxy;
  let upstream: http.Server;
  let socketPath = '';
  let port = 0;
  const seen: string[] = [];

  beforeEach(async () => {
    seen.length = 0;
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-review-e-')));
    upstream = http.createServer((req, res) => { seen.push(String(req.headers.authorization ?? '')); res.end('ok'); });
    const upstreamPort = await new Promise<number>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve((upstream.address() as net.AddressInfo).port)));
    // What any program running as the user can write: two service definitions with an upstream of its choosing.
    const servicesPath = path.join(dir, 'services.yaml');
    fs.writeFileSync(servicesPath, [
      'services:',
      '  - name: cloudflare',
      `    upstream: http://127.0.0.1:${upstreamPort}`,
      '    authHeader: Authorization',
      '    authPrefix: "Bearer "',
      '    credentialKey: ai-api_token',
      '  - name: openai-org',
      `    upstream: http://127.0.0.1:${upstreamPort}`,
      '    authHeader: Authorization',
      '    authPrefix: "Bearer "',
      '    credentialKey: id',
      '',
    ].join('\n'));
    // The vault holds the builtin cloudflare-ai key, and an openai key whose name has a hyphen.
    fakeOp({ 'aquaman-cloudflare-ai-api_token': CF_SECRET, 'aquaman-openai-org-id': OPENAI_SECRET });
    const { OnePasswordStore } = await import('aquaman-core');
    const store = new OnePasswordStore();
    socketPath = tmpSocketPath();
    port = await freePort();
    proxy = createCredentialProxy({
      socketPath,
      store,
      // config.yaml `credentials.proxiedServices`, which the same program can write.
      allowedServices: ['cloudflare', 'openai-org'],
      serviceRegistry: new ServiceRegistry({ configPath: servicesPath }),
      broker: createBrokerScope({
        configPath: path.join(dir, 'config.yaml'),
        projectsPath: path.join(dir, 'projects.yaml'),
        loopbackDeniedServices: ['anthropic', 'openai'],
        itemIdentity: (service, key) => store.itemIdentity?.(service, key),
      }),
      loopback: { port, token: TOKEN },
    });
    await proxy.start();
  });

  afterEach(async () => {
    if (proxy?.isRunning()) await proxy.stop();
    await new Promise((resolve) => upstream.close(resolve));
    if (socketPath) cleanupSocket(socketPath);
    fs.rmSync(dir, { recursive: true, force: true });
    vi.resetAllMocks();
  });

  it('the builtin cloudflare-ai key is not sent to the upstream services.yaml names for "cloudflare" (Unix socket)', async () => {
    const res = await udsFetch(socketPath, '/cloudflare/anything');
    expect(res.status).toBe(403);
    expect(seen.join('\n')).not.toContain(CF_SECRET);
  });

  it('an openai item is not sent to the upstream services.yaml names for "openai-org" (loopback listener, loopback token)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/openai-org/anything`, { headers: { 'x-aquaman-token': TOKEN } });
    expect(res.status).toBe(403);
    expect(seen.join('\n')).not.toContain(OPENAI_SECRET);
  });

  it('for comparison: the broker refuses the same second name over loopback', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/broker/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-aquaman-token': TOKEN }, body: JSON.stringify({ service: 'openai-org', key: 'id' }) });
    expect(res.status).toBe(404);
  });
});
