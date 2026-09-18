/**
 * The plugin's ProxyManager against the REAL `aquaman openclaw plugin-mode`
 * process (v0.15.0 regression guard).
 *
 * plugin-mode prints "Credential proxy listening on …" and only THEN the
 * `{"ready":true,…}` connection-info line. ProxyManager used to parse only the
 * first stdout line, so it never saw "ready". After 10 s it reported
 * "Proxy startup timeout" and killed the healthy proxy it had just spawned,
 * which meant the gateway never got a proxy. Unit tests mocked spawn with the
 * JSON on line one, so this surfaced only in a real-gateway smoke test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createProxyManager, findAquamanProxyBinary, type ProxyManager } from '../../packages/plugin/src/proxy-manager.js';
import { createTempEnv, type TempEnv } from '../helpers/temp-env.js';
import { udsFetch } from '../helpers/uds-proxy.js';

const HAS_BINARY = findAquamanProxyBinary() !== null;

describe.skipIf(!HAS_BINARY)('ProxyManager ↔ real plugin-mode process', () => {
  let env: TempEnv;
  let mgr: ProxyManager | null = null;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    env = createTempEnv({ withConfig: true });
    // pickProxyEnv forwards AQUAMAN_* from the parent env to the child.
    for (const [k, v] of Object.entries(env.env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });

  afterEach(async () => {
    if (mgr) await mgr.stop();
    mgr = null;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    env.cleanup();
  });

  it('resolves with the ready connection info and leaves the proxy running', async () => {
    mgr = createProxyManager({ config: { backend: 'encrypted-file' } as any });
    const started = Date.now();
    const info = await mgr.start();
    expect(info.ready).toBe(true);
    expect(info.socketPath).toBe(path.join(env.aquamanDir, 'proxy.sock'));
    expect(Object.keys(info.hostMap ?? {})).toContain('api.anthropic.com');
    // Well under the 10 s startup timeout the old first-line parse always hit.
    expect(Date.now() - started).toBeLessThan(9_000);

    // The proxy is alive and serving, not killed by a timeout.
    expect(fs.existsSync(info.socketPath)).toBe(true);
    const health = await udsFetch(info.socketPath, '/_health');
    expect(health.status).toBe(200);
    expect(mgr.isRunning()).toBe(true);

    // And it's the OpenClaw proxy: no credential broker (v0.15.0).
    const broker = await udsFetch(info.socketPath, '/broker/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'anthropic', key: 'api_key' }),
    });
    expect(JSON.parse(broker.body).code).toBe('broker_disabled');
  }, 30_000);
});
