/**
 * Unit tests for the OpenShell driver glue (v0.17.0): socket path, gateway
 * snippet, the audit mapping, and starting the driver in-process.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MemoryStore, getDefaultConfig } from 'aquaman-core';
import { createBrokerScope } from 'aquaman-proxy';
import {
  openshellDriverSocketPath,
  gatewayConfigSnippet,
  auditDriverAccess,
  grpcAvailable,
  startOpenShellDriver,
  MAX_SOCKET_PATH,
  type AuditSink,
} from '../../../packages/proxy/src/openshell/integration.js';
import type { DriverAccessEvent } from '../../../packages/proxy/src/openshell/credential-driver.js';

function recordingSink() {
  const calls: { agentId: string; access: Parameters<AuditSink['logCredentialAccess']>[2] }[] = [];
  const sink: AuditSink = { logCredentialAccess: (_s, agentId, access) => { calls.push({ agentId, access }); } };
  return { sink, calls };
}

const ev = (over: Partial<DriverAccessEvent>): DriverAccessEvent => ({
  op: 'resolve', mode: 'reference', ref: 'aquaman://anthropic/api_key', service: 'anthropic', provider: 'claude', success: true, ...over,
});

describe('OpenShell integration glue', () => {
  const savedDir = process.env['AQUAMAN_CONFIG_DIR'];
  afterEach(() => {
    if (savedDir === undefined) delete process.env['AQUAMAN_CONFIG_DIR'];
    else process.env['AQUAMAN_CONFIG_DIR'] = savedDir;
  });

  describe('socket path', () => {
    it('defaults to <configDir>/openshell.sock', () => {
      process.env['AQUAMAN_CONFIG_DIR'] = '/tmp/aq-cfg';
      expect(openshellDriverSocketPath(getDefaultConfig())).toBe('/tmp/aq-cfg/openshell.sock');
    });

    it('honors openshell.driver.socketPath', () => {
      const config = { ...getDefaultConfig(), openshell: { driver: { enabled: true, socketPath: '/tmp/custom.sock' } } };
      expect(openshellDriverSocketPath(config)).toBe('/tmp/custom.sock');
    });
  });

  it('prints a gateway snippet that selects the aquaman UDS driver', () => {
    expect(gatewayConfigSnippet('/tmp/x.sock')).toBe([
      '[openshell.gateway]',
      'credential_drivers = ["aquaman"]',
      '',
      '[openshell.credential_drivers.aquaman]',
      'transport = "uds"',
      'socket_path = "/tmp/x.sock"',
    ].join('\n'));
  });

  describe('audit mapping', () => {
    it('logs a resolve as a read by the openshell agent', () => {
      const { sink, calls } = recordingSink();
      auditDriverAccess(sink, ev({}));
      expect(calls).toEqual([{ agentId: 'openshell', access: { service: 'anthropic', operation: 'read', success: true, error: undefined } }]);
    });

    it('logs a refused resolve as a failed read naming the ref', () => {
      const { sink, calls } = recordingSink();
      auditDriverAccess(sink, ev({ success: false, error: 'not declared' }));
      expect(calls[0].access).toEqual({ service: 'anthropic', operation: 'read', success: false, error: 'aquaman://anthropic/api_key: not declared' });
    });

    it('logs copy-mode writes and deletes as rotations', () => {
      const { sink, calls } = recordingSink();
      auditDriverAccess(sink, ev({ op: 'store', mode: 'copy', service: 'openshell', ref: 'aquaman://openshell/o.K' }));
      auditDriverAccess(sink, ev({ op: 'delete', mode: 'copy', service: 'openshell', ref: 'aquaman://openshell/o.K' }));
      expect(calls.map((c) => c.access.operation)).toEqual(['rotate', 'rotate']);
    });

    it('records nothing for a successful reference validation or reference delete (no value handed out)', () => {
      const { sink, calls } = recordingSink();
      auditDriverAccess(sink, ev({ op: 'store' }));
      auditDriverAccess(sink, ev({ op: 'delete' }));
      expect(calls).toEqual([]);
    });

    it('records a refused reference validation as a failed read', () => {
      const { sink, calls } = recordingSink();
      auditDriverAccess(sink, ev({ op: 'store', success: false, error: 'not in the vault' }));
      expect(calls[0].access).toMatchObject({ operation: 'read', success: false });
    });
  });

  it('reports the optional gRPC packages as available in this repo', async () => {
    expect(await grpcAvailable()).toBe(true);
  });

  describe('startOpenShellDriver', () => {
    it('refuses a socket path over the Unix limit before binding', async () => {
      const long = '/tmp/' + 'x'.repeat(MAX_SOCKET_PATH) + '.sock';
      const config = { ...getDefaultConfig(), openshell: { driver: { enabled: true, socketPath: long } } };
      await expect(startOpenShellDriver({ config, store: new MemoryStore(), scope: undefined, audit: recordingSink().sink, version: 't' }))
        .rejects.toThrow(/over the 103-byte Unix socket limit/);
    });

    it('starts on the configured socket and cleans it up on stop', async () => {
      const dir = fs.mkdtempSync(path.join('/tmp', 'aqoi-'));
      const socketPath = path.join(dir, 'd.sock');
      const config = { ...getDefaultConfig(), openshell: { driver: { enabled: true, socketPath } } };
      const scope = createBrokerScope({ projectsPath: path.join(dir, 'none.yaml') });
      const server = await startOpenShellDriver({ config, store: new MemoryStore(), scope, audit: recordingSink().sink, version: 't' });
      try {
        expect(server.socketPath).toBe(socketPath);
        expect(fs.statSync(socketPath).isSocket()).toBe(true);
      } finally {
        await server.stop();
        expect(fs.existsSync(socketPath)).toBe(false);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
