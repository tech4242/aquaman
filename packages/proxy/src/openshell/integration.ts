/**
 * Glue between `aquaman daemon` / the CLI and the OpenShell credential driver.
 */

import * as path from 'node:path';
import type { WrapperConfig } from '../core/types.js';
import type { CredentialStore } from '../core/credentials/store.js';
import type { BrokerScope } from '../broker-scope.js';
import { getConfigDir } from '../core/utils/config.js';
import { createOpenShellDriverCore, type DriverAccessEvent } from './credential-driver.js';
import { startOpenShellDriverServer, loadGrpc, type OpenShellDriverServer } from './grpc-server.js';

/** macOS caps Unix socket paths at 104 bytes (Linux 108); bind fails above that. */
export const MAX_SOCKET_PATH = 103;

export function openshellDriverSocketPath(config: WrapperConfig): string {
  return config.openshell?.driver?.socketPath || path.join(getConfigDir(), 'openshell.sock');
}

/** True when the optional gRPC peers can be loaded. */
export async function grpcAvailable(): Promise<boolean> {
  try {
    await loadGrpc();
    return true;
  } catch {
    return false;
  }
}

/** The gateway TOML that points OpenShell at this driver. */
export function gatewayConfigSnippet(socketPath: string): string {
  return [
    '[openshell.gateway]',
    'credential_drivers = ["aquaman"]',
    '',
    '[openshell.credential_drivers.aquaman]',
    'transport = "uds"',
    `socket_path = "${socketPath}"`,
  ].join('\n');
}

export interface AuditSink {
  logCredentialAccess(
    sessionId: string,
    agentId: string,
    access: { service: string; operation: 'read' | 'use' | 'rotate'; success: boolean; error?: string },
  ): unknown;
}

/**
 * Resolves hand a value to the gateway (`read`); copy-mode writes and deletes
 * change the vault (`rotate`). Validating a reference at create time hands
 * nothing out, so only its refusals are recorded.
 */
export function auditDriverAccess(audit: AuditSink, e: DriverAccessEvent): void {
  let operation: 'read' | 'rotate';
  if (e.op === 'resolve') operation = 'read';
  else if (e.mode === 'copy') operation = 'rotate';
  else if (!e.success) operation = 'read';
  else return;
  audit.logCredentialAccess('system', 'openshell', {
    service: e.service,
    operation,
    success: e.success,
    error: e.success ? undefined : `${e.ref}: ${e.error ?? 'refused'}`,
  });
}

export async function startOpenShellDriver(opts: {
  config: WrapperConfig;
  store: CredentialStore;
  scope: BrokerScope | undefined;
  audit: AuditSink;
  version: string;
}): Promise<OpenShellDriverServer> {
  const socketPath = openshellDriverSocketPath(opts.config);
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) {
    throw new Error(`socket path is ${Buffer.byteLength(socketPath)} bytes, over the ${MAX_SOCKET_PATH}-byte Unix socket limit: ${socketPath}. Set openshell.driver.socketPath to a shorter path.`);
  }
  const core = createOpenShellDriverCore({
    store: opts.store,
    scope: opts.scope,
    version: opts.version,
    onAccess: (e) => auditDriverAccess(opts.audit, e),
  });
  return startOpenShellDriverServer(core, socketPath);
}
