/**
 * E2E tests for the /_hostmap endpoint and host map propagation in plugin-mode.
 *
 * Tests:
 * 1. /_hostmap endpoint returns builtin host→service mappings
 * 2. /_hostmap includes custom services from services.yaml
 * 3. plugin-mode startup JSON includes hostMap field
 * 4. Custom service defined in services.yaml is routable through proxy
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CredentialProxy, createCredentialProxy, createServiceRegistry } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';

const CLI_PATH = path.resolve('packages/proxy/src/cli/index.ts');
const TEST_TIMEOUT = 30_000;

describe('/_hostmap endpoint', () => {
  let proxy: CredentialProxy;
  let store: MemoryStore;
  let proxyPort: number;

  beforeEach(async () => {
    store = new MemoryStore();
    await store.set('anthropic', 'api_key', 'sk-test');

    proxy = createCredentialProxy({
      port: 0,
      store,
      allowedServices: ['anthropic', 'openai'],
    });
    await proxy.start();
    proxyPort = proxy.getPort();
  });

  afterEach(async () => {
    await proxy.stop();
  });

  it('returns JSON with builtin host patterns', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/_hostmap`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const hostMap = await res.json() as Record<string, string>;
    // Builtin services should be present
    expect(hostMap['api.anthropic.com']).toBe('anthropic');
    expect(hostMap['api.openai.com']).toBe('openai');
    expect(hostMap['api.telegram.org']).toBe('telegram');
    expect(hostMap['*.slack.com']).toBe('slack');
  });

  it('returns all 23+ builtin service host patterns', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/_hostmap`);
    const hostMap = await res.json() as Record<string, string>;

    // Should have entries for at least the major services
    const serviceNames = new Set(Object.values(hostMap));
    expect(serviceNames.has('anthropic')).toBe(true);
    expect(serviceNames.has('openai')).toBe(true);
    expect(serviceNames.has('telegram')).toBe(true);
    expect(serviceNames.has('slack')).toBe(true);
    expect(serviceNames.has('discord')).toBe(true);
    expect(serviceNames.has('twilio')).toBe(true);
  });

  it('accepts trailing slash', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/_hostmap/`);
    expect(res.status).toBe(200);
    const hostMap = await res.json() as Record<string, string>;
    expect(hostMap['api.anthropic.com']).toBe('anthropic');
  });

  it('requires client token when configured (unlike /_health)', async () => {
    // Create a proxy with client token
    const tokenProxy = createCredentialProxy({
      port: 0,
      store,
      allowedServices: ['anthropic'],
      clientToken: 'test-secret-token',
    });
    await tokenProxy.start();
    const tokenPort = tokenProxy.getPort();

    try {
      // /_hostmap should be rejected without token
      const noTokenRes = await fetch(`http://127.0.0.1:${tokenPort}/_hostmap`);
      expect(noTokenRes.status).toBe(403);

      // /_hostmap should succeed with valid token
      const withTokenRes = await fetch(`http://127.0.0.1:${tokenPort}/_hostmap`, {
        headers: { 'X-Aquaman-Token': 'test-secret-token' },
      });
      expect(withTokenRes.status).toBe(200);
      const hostMap = await withTokenRes.json() as Record<string, string>;
      expect(hostMap['api.anthropic.com']).toBe('anthropic');

      // /_health should still be accessible without token
      const healthRes = await fetch(`http://127.0.0.1:${tokenPort}/_health`);
      expect(healthRes.status).toBe(200);
    } finally {
      await tokenProxy.stop();
    }
  });
});

describe('/_hostmap with custom services', () => {
  let tmpDir: string;
  let proxy: CredentialProxy;
  let store: MemoryStore;
  let proxyPort: number;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostmap-custom-'));

    // Write a custom services.yaml
    const servicesYaml = `services:
  - name: my-weather-api
    upstream: https://api.weather.example.com
    authHeader: X-API-Key
    credentialKey: api_key
    hostPatterns:
      - api.weather.example.com
      - '*.weather.example.com'
  - name: my-custom-llm
    upstream: https://api.custom-llm.io
    authHeader: Authorization
    authPrefix: 'Bearer '
    credentialKey: api_key
    hostPatterns:
      - api.custom-llm.io
`;
    fs.writeFileSync(path.join(tmpDir, 'services.yaml'), servicesYaml);

    store = new MemoryStore();
    await store.set('anthropic', 'api_key', 'sk-test');
    await store.set('my-weather-api', 'api_key', 'weather-key-123');

    const registry = createServiceRegistry({
      configPath: path.join(tmpDir, 'services.yaml'),
    });

    proxy = createCredentialProxy({
      port: 0,
      store,
      allowedServices: ['anthropic', 'my-weather-api', 'my-custom-llm'],
      serviceRegistry: registry,
    });
    await proxy.start();
    proxyPort = proxy.getPort();
  });

  afterEach(async () => {
    await proxy.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('includes custom service host patterns in /_hostmap', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/_hostmap`);
    const hostMap = await res.json() as Record<string, string>;

    // Custom services should appear
    expect(hostMap['api.weather.example.com']).toBe('my-weather-api');
    expect(hostMap['*.weather.example.com']).toBe('my-weather-api');
    expect(hostMap['api.custom-llm.io']).toBe('my-custom-llm');

    // Builtins should still be present
    expect(hostMap['api.anthropic.com']).toBe('anthropic');
  });

  it('routes requests to custom service and injects auth', async () => {
    // Create a mock upstream that captures the auth header
    let capturedHeaders: Record<string, string> = {};
    const mockUpstream = http.createServer((req, res) => {
      capturedHeaders = req.headers as Record<string, string>;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>((resolve) => {
      mockUpstream.listen(0, '127.0.0.1', resolve);
    });
    const mockPort = (mockUpstream.address() as any).port;

    // Override the custom service upstream to point to our mock
    const registry = proxy.getServiceRegistry();
    registry.override('my-weather-api', {
      upstream: `http://127.0.0.1:${mockPort}`,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${proxyPort}/my-weather-api/forecast`, {
        method: 'GET',
      });
      expect(res.status).toBe(200);

      // Verify auth header was injected
      expect(capturedHeaders['x-api-key']).toBe('weather-key-123');
    } finally {
      mockUpstream.close();
    }
  });
});

describe('plugin-mode hostMap in startup JSON', () => {
  let child: ChildProcess | null = null;

  afterEach(async () => {
    if (child && !child.killed) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          child?.kill('SIGKILL');
          resolve();
        }, 5000);
        child!.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    child = null;
  });

  it('startup JSON includes hostMap with builtin patterns', async () => {
    const connectionInfo = await new Promise<any>((resolve, reject) => {
      const proc = spawn('npx', ['tsx', CLI_PATH, 'plugin-mode', '--port', '0'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      child = proc;

      let stdout = '';
      const timeout = setTimeout(() => reject(new Error(`Timeout. stdout: ${stdout}`)), 20_000);

      proc.stdout!.on('data', (data: Buffer) => {
        stdout += data.toString();
        for (const line of stdout.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('{') && trimmed.includes('"ready"')) {
            try {
              const parsed = JSON.parse(trimmed);
              if (parsed.ready === true) {
                clearTimeout(timeout);
                resolve(parsed);
                return;
              }
            } catch { /* keep buffering */ }
          }
        }
      });

      proc.on('error', (err) => { clearTimeout(timeout); reject(err); });
      proc.on('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Exited with ${code}. stdout: ${stdout}`));
      });
    });

    // Verify hostMap is present and has expected structure
    expect(connectionInfo.hostMap).toBeDefined();
    expect(typeof connectionInfo.hostMap).toBe('object');
    expect(connectionInfo.hostMap['api.anthropic.com']).toBe('anthropic');
    expect(connectionInfo.hostMap['api.openai.com']).toBe('openai');
    expect(connectionInfo.hostMap['api.telegram.org']).toBe('telegram');
    expect(connectionInfo.hostMap['*.slack.com']).toBe('slack');
  }, TEST_TIMEOUT);
});
