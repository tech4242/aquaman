/**
 * E2E: OpenShell external credential driver over real gRPC (v0.17.0).
 *
 * A gRPC client plays the OpenShell gateway, using the vendored protos and the
 * same handshake the real 0.1.2 gateway sent in the 2026-10-02 spike
 * (implementation `openshell/gateway`, protocol 1.0, contract capability).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { MemoryStore } from 'aquaman-core';
import { createBrokerScope } from 'aquaman-proxy';
import { createOpenShellDriverCore, type DriverAccessEvent } from '../../packages/proxy/src/openshell/credential-driver.js';
import { startOpenShellDriverServer, openshellProtoDir, type OpenShellDriverServer } from '../../packages/proxy/src/openshell/grpc-server.js';

const SECRET = 'sk-ant-openshell-e2e-0123456789abcdef';
const GATEWAY_META = {
  protocol_version: { major: 1, minor: 0 },
  implementation_name: 'openshell/gateway',
  implementation_version: '0.1.2',
  supported_capabilities: ['openshell.credentials.contract'],
  required_capabilities: ['openshell.credentials.contract'],
};

describe('OpenShell credential driver over gRPC', () => {
  let dir: string;
  let server: OpenShellDriverServer;
  let client: any;
  const events: DriverAccessEvent[] = [];
  const call = (method: string, req: unknown) =>
    new Promise<any>((resolve, reject) => client[method](req, (err: any, res: any) => (err ? reject(err) : resolve(res))));

  beforeAll(async () => {
    // Short path: macOS caps Unix socket paths at ~104 bytes.
    dir = fs.mkdtempSync(path.join('/tmp', 'aqos-'));
    const store = new MemoryStore();
    await store.set('anthropic', 'api_key', SECRET);
    const scope = createBrokerScope({ projectsPath: path.join(dir, 'none.yaml'), allowedRefs: ['aquaman://anthropic/api_key'] });
    const core = createOpenShellDriverCore({ store, scope, version: '0.17.0-test', onAccess: (e) => events.push(e) });
    server = await startOpenShellDriverServer(core, path.join(dir, 'openshell.sock'));

    const def = protoLoader.loadSync('credential_driver.proto', { includeDirs: [openshellProtoDir()], keepCase: true, defaults: true, oneofs: true });
    const pkg: any = grpc.loadPackageDefinition(def);
    client = new pkg.openshell.credentials.v1.CredentialDriver(`unix://${server.socketPath}`, grpc.credentials.createInsecure());
  });

  afterAll(async () => {
    client?.close();
    await server?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the socket owner-only', () => {
    expect(fs.statSync(server.socketPath).mode & 0o777).toBe(0o600);
  });

  it('answers the gateway handshake', async () => {
    const res = await call('GetCapabilities', { gateway: GATEWAY_META });
    expect(res.backend_kind).toBe('aquaman');
    expect(res.extension.protocol_version).toEqual({ major: 1, minor: 0 });
    expect(res.extension.required_capabilities).toEqual(['openshell.credentials.contract']);
  });

  it('round-trips a reference: Store returns the ref, Resolve returns the vault value, Delete keeps it', async () => {
    const { handle } = await call('StoreCredential', { provider: 'claude', credential_key: 'ANTHROPIC_API_KEY', value: 'aquaman://anthropic/api_key', workspace: 'default', provider_id: 'p1' });
    expect(handle).toMatchObject({ driver: 'aquaman', handle: 'aquaman://anthropic/api_key' });

    const res = await call('ResolveCredentials', { credentials: [{ request_id: 'r1', provider: 'claude', credential_key: 'ANTHROPIC_API_KEY', handle }] });
    expect(res.credentials).toEqual([expect.objectContaining({ request_id: 'r1', value: SECRET })]);

    await call('DeleteCredential', { provider: 'claude', credential_key: 'ANTHROPIC_API_KEY', handle });
    const again = await call('ResolveCredentials', { credentials: [{ request_id: 'r2', handle }] });
    expect(again.credentials[0].value).toBe(SECRET);
  });

  it('maps an undeclared reference to FAILED_PRECONDITION with the fix', async () => {
    await expect(call('StoreCredential', { provider: 'gh', credential_key: 'GITHUB_TOKEN', value: 'aquaman://github/token' }))
      .rejects.toMatchObject({ code: grpc.status.FAILED_PRECONDITION, details: expect.stringMatching(/aquaman broker allow aquaman:\/\/github\/token/) });
  });

  it('maps a foreign handle to INVALID_ARGUMENT', async () => {
    await expect(call('ResolveCredentials', { credentials: [{ request_id: 'x', handle: { driver: 'vault', handle: 'secret/data/x' } }] }))
      .rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
  });

  it('lists declared refs', async () => {
    const res = await call('ListCredentials', {});
    expect(res.credentials.map((c: any) => c.handle)).toEqual(['aquaman://anthropic/api_key']);
  });

  it('never puts a value in an audit event', () => {
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });
});
