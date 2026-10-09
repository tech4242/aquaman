/**
 * gRPC transport for the OpenShell credential driver. Serves
 * `openshell.credentials.v1.CredentialDriver` on a Unix socket (mode 0600).
 *
 * `@grpc/grpc-js` and `@grpc/proto-loader` are optional peer dependencies,
 * loaded only here, so installs that never enable the driver carry neither
 * (the same posture as kdbxweb/argon2 for KeePassXC).
 */

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DriverError, type OpenShellDriverCore } from './credential-driver.js';

export const GRPC_INSTALL_HINT = 'npm install -g @grpc/grpc-js@^1.14 @grpc/proto-loader@^0.8';

/** Vendored protos: packages/proxy/proto/openshell, from both src/openshell and dist/openshell. */
export function openshellProtoDir(): string {
  return fileURLToPath(new URL('../../proto/openshell/', import.meta.url));
}

/** Throws with an install hint when the optional gRPC packages are missing. */
export async function loadGrpc(): Promise<{ grpc: any; protoLoader: any }> {
  try {
    const grpc = await import('@grpc/grpc-js');
    const protoLoader = await import('@grpc/proto-loader');
    return { grpc: (grpc as any).default ?? grpc, protoLoader: (protoLoader as any).default ?? protoLoader };
  } catch {
    throw new Error(`The OpenShell credential driver needs the optional gRPC packages. Install them with: ${GRPC_INSTALL_HINT}`);
  }
}

export interface OpenShellDriverServer {
  socketPath: string;
  stop(): Promise<void>;
}

export async function startOpenShellDriverServer(core: OpenShellDriverCore, socketPath: string): Promise<OpenShellDriverServer> {
  const { grpc, protoLoader } = await loadGrpc();
  const definition = protoLoader.loadSync('credential_driver.proto', {
    includeDirs: [openshellProtoDir()],
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const pkg = grpc.loadPackageDefinition(definition);

  const STATUS: Record<string, number> = {
    invalid_argument: grpc.status.INVALID_ARGUMENT,
    not_found: grpc.status.NOT_FOUND,
    failed_precondition: grpc.status.FAILED_PRECONDITION,
    internal: grpc.status.INTERNAL,
  };
  const fail = (cb: (err: unknown) => void, err: unknown) => {
    const code = err instanceof DriverError ? STATUS[err.code] : grpc.status.INTERNAL;
    cb({ code, message: err instanceof Error ? err.message : String(err) });
  };

  const handlers = {
    GetCapabilities(call: any, cb: any) {
      try { cb(null, core.getCapabilities(call.request.gateway)); } catch (err) { fail(cb, err); }
    },
    StoreCredential(call: any, cb: any) {
      core.store(call.request).then((res) => cb(null, res), (err) => fail(cb, err));
    },
    ResolveCredentials(call: any, cb: any) {
      core.resolve(call.request.credentials ?? []).then((credentials) => cb(null, { credentials }), (err) => fail(cb, err));
    },
    DeleteCredential(call: any, cb: any) {
      core.delete(call.request).then(() => cb(null, {}), (err) => fail(cb, err));
    },
    ListCredentials(_call: any, cb: any) {
      try { cb(null, { credentials: core.list() }); } catch (err) { fail(cb, err); }
    },
  };

  const server = new grpc.Server();
  server.addService(pkg.openshell.credentials.v1.CredentialDriver.service, handlers);

  // Never unlink something that isn't a stale socket.
  try {
    if (fs.lstatSync(socketPath).isSocket()) fs.unlinkSync(socketPath);
  } catch { /* absent */ }

  // Create the socket 0600 from the start (no window where it is group/world
  // accessible), then chmod as a fallback. process.umask() throws in worker
  // threads (vitest), hence the try/catch, same as the proxy socket.
  let previousUmask: number | undefined;
  try { previousUmask = process.umask(0o177); } catch { /* unsupported in workers */ }
  try {
    await new Promise<void>((resolve, reject) => {
      server.bindAsync(`unix://${socketPath}`, grpc.ServerCredentials.createInsecure(), (err: Error | null) => {
        if (err) reject(new Error(`OpenShell driver could not bind ${socketPath}: ${err.message}`));
        else resolve();
      });
    });
  } finally {
    if (previousUmask !== undefined) { try { process.umask(previousUmask); } catch { /* ignore */ } }
  }
  fs.chmodSync(socketPath, 0o600);

  return {
    socketPath,
    async stop() {
      await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
      try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
    },
  };
}
