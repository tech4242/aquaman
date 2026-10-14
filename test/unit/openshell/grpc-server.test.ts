/**
 * Unit tests for the OpenShell gRPC transport's failure paths (v0.17.0).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import type { OpenShellDriverCore } from '../../../packages/proxy/src/openshell/credential-driver.js';

const MODULE = '../../../packages/proxy/src/openshell/grpc-server.js';

afterEach(() => {
  vi.doUnmock('@grpc/grpc-js');
  vi.resetModules();
});

describe('OpenShell gRPC transport', () => {
  it('fails with the install hint when the optional gRPC packages are missing', async () => {
    vi.resetModules();
    vi.doMock('@grpc/grpc-js', () => { throw new Error("Cannot find package '@grpc/grpc-js'"); });
    const { loadGrpc, startOpenShellDriverServer } = await import(MODULE);
    await expect(loadGrpc()).rejects.toThrow(/npm install -g @grpc\/grpc-js@\^1\.14 @grpc\/proto-loader@\^0\.8/);
    await expect(startOpenShellDriverServer({} as OpenShellDriverCore, '/tmp/never.sock')).rejects.toThrow(/optional gRPC packages/);
  });

  it('maps a non-driver error to INTERNAL and never deletes a regular file at the socket path', async () => {
    const { startOpenShellDriverServer, openshellProtoDir } = await import(MODULE);
    const dir = fs.mkdtempSync(path.join('/tmp', 'aqog-'));
    try {
      // A regular file where the socket should go is left alone and the bind fails loudly.
      const occupied = path.join(dir, 'occupied');
      fs.writeFileSync(occupied, 'not a socket');
      const failingCore = {
        getCapabilities: () => { throw new Error('boom'); },
        store: async () => { throw new Error('vault exploded'); },
        resolve: async () => [],
        delete: async () => {},
        list: () => [],
      } as unknown as OpenShellDriverCore;
      await expect(startOpenShellDriverServer(failingCore, occupied)).rejects.toThrow(/could not bind/);
      expect(fs.readFileSync(occupied, 'utf-8')).toBe('not a socket');

      // A stale socket left by a crashed daemon (a socket file with no server
      // behind it) is replaced. Python's bind leaves the file in place on exit.
      const socketPath = path.join(dir, 'd.sock');
      const made = spawnSync('python3', ['-c', `import socket; socket.socket(socket.AF_UNIX).bind(${JSON.stringify(socketPath)})`]);
      expect(made.status).toBe(0);
      expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
      const server = await startOpenShellDriverServer(failingCore, socketPath);
      expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
      const def = protoLoader.loadSync('credential_driver.proto', { includeDirs: [openshellProtoDir()], keepCase: true, defaults: true });
      const pkg: any = grpc.loadPackageDefinition(def);
      const client = new pkg.openshell.credentials.v1.CredentialDriver(`unix://${socketPath}`, grpc.credentials.createInsecure());
      const call = (m: string, req: unknown) => new Promise((res, rej) => client[m](req, (e: any, r: any) => (e ? rej(e) : res(r))));
      try {
        await expect(call('StoreCredential', { value: 'x' })).rejects.toMatchObject({ code: grpc.status.INTERNAL, details: 'vault exploded' });
        await expect(call('GetCapabilities', {})).rejects.toMatchObject({ code: grpc.status.INTERNAL });
      } finally {
        client.close();
        await server.stop();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
