/**
 * OpenShell external credential driver (v0.17.0): the transport-free core.
 *
 * NVIDIA OpenShell keeps provider credentials behind opaque handles owned by a
 * credential driver (`credential_driver.proto`, extension protocol 1.0). The
 * gateway calls Store when a provider is created, Resolve when a sandbox
 * starts, and Delete when a provider is removed. Its supervisor injects the
 * resolved value at egress while the sandbox sees only a placeholder, so
 * OpenShell does the isolation; aquaman supplies the value from the user's
 * vault, scopes it and audits it.
 *
 * Two modes, chosen by the value the gateway submits:
 *   - reference: the value is an `aquaman://service/key` ref
 *     (`openshell provider create --credential KEY=aquaman://svc/key`). It must
 *     be declared (same scope as the broker) and present in the vault. Nothing
 *     is stored; the ref itself is the handle. Delete is a no-op, so removing a
 *     provider never deletes the user's own vault item.
 *   - copy: any other value is written to the vault under the gateway-owned
 *     `openshell` service, keyed by OpenShell's object id and credential key.
 *
 * The meaning of a handle comes from its namespace, never from the metadata
 * the gateway echoes back: `aquaman://openshell/...` is a gateway-owned copy,
 * anything else is a reference and is re-checked against the scope on every
 * Resolve (a revoked declaration stops resolving). Otherwise a caller could
 * label `aquaman://github/token` as a copy to skip the scope.
 *
 * Verified against OpenShell 0.1.2 (2026-10-02): the gateway authenticates
 * nothing on the socket (only a user-agent header), so the socket's 0600 mode
 * is the boundary; it does not validate the submitted value's format; it
 * resolves about once per sandbox start, not per request; it never calls
 * ListCredentials.
 */

import type { CredentialStore } from '../core/credentials/store.js';
import { formatAquamanRef, parseAquamanRef, type BrokerScope } from '../broker-scope.js';

export const OPENSHELL_PROTOCOL = { major: 1, minor: 0 } as const;
export const CREDENTIALS_CONTRACT = 'openshell.credentials.contract';
/** Vault service that holds gateway-submitted copies. */
export const COPY_SERVICE = 'openshell';
export const DRIVER_NAME = 'aquaman';

const SAFE_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export type DriverErrorCode = 'invalid_argument' | 'not_found' | 'failed_precondition' | 'internal';

/** A refusal or failure carried back to the gateway (mapped to a gRPC status by the transport). */
export class DriverError extends Error {
  constructor(readonly code: DriverErrorCode, message: string) {
    super(message);
    this.name = 'DriverError';
  }
}

export interface PeerMetadata {
  protocol_version?: { major?: number; minor?: number };
  implementation_name?: string;
  implementation_version?: string;
  supported_capabilities?: string[];
  required_capabilities?: string[];
}

export interface CredentialHandle {
  driver?: string;
  handle?: string;
  metadata?: Record<string, string>;
}

export interface StoreRequest {
  provider?: string;
  credential_key?: string;
  value?: string;
  workspace?: string;
  provider_id?: string;
  object_id?: string;
}

export interface ResolveRequest {
  request_id?: string;
  provider?: string;
  credential_key?: string;
  handle?: CredentialHandle | null;
}

export interface DeleteRequest {
  provider?: string;
  credential_key?: string;
  handle?: CredentialHandle | null;
}

/** One driver operation, for the audit log. Never carries a credential value. */
export interface DriverAccessEvent {
  op: 'store' | 'resolve' | 'delete';
  mode: 'reference' | 'copy';
  ref: string;
  service: string;
  provider: string;
  success: boolean;
  error?: string;
}

export interface OpenShellDriverOptions {
  store: CredentialStore;
  /** Declared-ref scope shared with the broker. Absent means the broker is off: references are refused. */
  scope?: BrokerScope;
  version: string;
  onAccess?: (event: DriverAccessEvent) => void;
}

export interface OpenShellDriverCore {
  getCapabilities(gateway: PeerMetadata | null | undefined): Record<string, unknown>;
  store(req: StoreRequest): Promise<{ handle: CredentialHandle }>;
  resolve(reqs: ResolveRequest[]): Promise<{ request_id: string; value: string }[]>;
  delete(req: DeleteRequest): Promise<void>;
  list(): { handle: string; keys: string[]; metadata: Record<string, string> }[];
}

type ParsedHandle = { mode: 'reference' | 'copy'; service: string; key: string; ref: string };

function parseHandle(handle: string): ParsedHandle | null {
  const parsed = parseAquamanRef(handle);
  if (!parsed) return null;
  return { mode: parsed.service === COPY_SERVICE ? 'copy' : 'reference', ...parsed, ref: handle };
}

export function createOpenShellDriverCore(opts: OpenShellDriverOptions): OpenShellDriverCore {
  const { store, scope, onAccess } = opts;

  const emit = (e: DriverAccessEvent) => {
    try { onAccess?.(e); } catch { /* auditing must not break the driver */ }
  };

  const checkScope = (service: string, key: string): void => {
    if (!scope) {
      throw new DriverError('failed_precondition',
        `aquaman: the broker is disabled (broker.enabled: false), so ${formatAquamanRef(service, key)} cannot be resolved. Fix: enable the broker in ~/.aquaman/config.yaml`);
    }
    const decision = scope.check(service, key, 'uds');
    if (!decision.allowed) {
      throw new DriverError('failed_precondition', `aquaman: ${decision.reason}. Fix: aquaman broker allow ${formatAquamanRef(service, key)}`);
    }
  };

  return {
    getCapabilities(gateway) {
      const major = gateway?.protocol_version?.major;
      if (major !== undefined && major !== OPENSHELL_PROTOCOL.major) {
        throw new DriverError('failed_precondition',
          `aquaman: gateway speaks credential driver protocol ${major}.x, aquaman supports ${OPENSHELL_PROTOCOL.major}.${OPENSHELL_PROTOCOL.minor}`);
      }
      const missing = (gateway?.required_capabilities ?? []).filter((c) => c !== CREDENTIALS_CONTRACT);
      if (missing.length > 0) {
        throw new DriverError('failed_precondition', `aquaman: gateway requires unsupported capabilities: ${missing.join(', ')}`);
      }
      return {
        driver_name: DRIVER_NAME,
        driver_version: opts.version,
        backend_kind: DRIVER_NAME,
        supports_list: true,
        supports_expires_at: false,
        extension: {
          protocol_version: { ...OPENSHELL_PROTOCOL },
          implementation_name: 'aquaman/openshell',
          implementation_version: opts.version,
          supported_capabilities: [CREDENTIALS_CONTRACT],
          required_capabilities: [CREDENTIALS_CONTRACT],
        },
      };
    },

    async store(req) {
      const provider = req.provider ?? '';
      const value = req.value ?? '';
      if (!value) throw new DriverError('invalid_argument', 'aquaman: empty credential value');

      if (value.startsWith('aquaman://')) {
        const parsed = parseAquamanRef(value);
        if (!parsed || parsed.service === COPY_SERVICE) {
          throw new DriverError('invalid_argument', `aquaman: ${value} is not a valid aquaman://service/key reference`);
        }
        try {
          checkScope(parsed.service, parsed.key);
          if (!(await store.exists(parsed.service, parsed.key))) {
            throw new DriverError('not_found', `aquaman: ${value} is not in the vault. Fix: aquaman credentials add ${parsed.service} ${parsed.key}`);
          }
        } catch (err) {
          emit({ op: 'store', mode: 'reference', ref: value, service: parsed.service, provider, success: false, error: (err as Error).message });
          throw err;
        }
        emit({ op: 'store', mode: 'reference', ref: value, service: parsed.service, provider, success: true });
        return { handle: { driver: DRIVER_NAME, handle: value, metadata: { mode: 'reference' } } };
      }

      const owner = req.object_id || req.provider_id || '';
      const key = `${owner}.${req.credential_key ?? ''}`;
      if (!owner || !req.credential_key || !SAFE_KEY.test(key)) {
        throw new DriverError('invalid_argument', `aquaman: cannot derive a vault key from provider id ${JSON.stringify(owner)} and credential key ${JSON.stringify(req.credential_key)}`);
      }
      const ref = formatAquamanRef(COPY_SERVICE, key);
      try {
        await store.set(COPY_SERVICE, key, value);
      } catch (err) {
        emit({ op: 'store', mode: 'copy', ref, service: COPY_SERVICE, provider, success: false, error: (err as Error).message });
        throw new DriverError('internal', `aquaman: vault write failed: ${(err as Error).message}`);
      }
      emit({ op: 'store', mode: 'copy', ref, service: COPY_SERVICE, provider, success: true });
      return { handle: { driver: DRIVER_NAME, handle: ref, metadata: { mode: 'copy' } } };
    },

    async resolve(reqs) {
      const out: { request_id: string; value: string }[] = [];
      for (const r of reqs) {
        const provider = r.provider ?? '';
        const h = parseHandle(r.handle?.handle ?? '');
        if (!h) throw new DriverError('invalid_argument', `aquaman: not an aquaman handle: ${JSON.stringify(r.handle?.handle ?? '')}`);
        let value: string | null;
        try {
          if (h.mode === 'reference') checkScope(h.service, h.key);
          value = await store.get(h.service, h.key);
          if (value === null) {
            throw new DriverError('not_found', `aquaman: ${h.ref} is not in the vault. Fix: aquaman credentials add ${h.service} ${h.key}`);
          }
        } catch (err) {
          emit({ op: 'resolve', mode: h.mode, ref: h.ref, service: h.service, provider, success: false, error: (err as Error).message });
          if (err instanceof DriverError) throw err;
          throw new DriverError('internal', `aquaman: vault read failed for ${h.ref}: ${(err as Error).message}`);
        }
        emit({ op: 'resolve', mode: h.mode, ref: h.ref, service: h.service, provider, success: true });
        out.push({ request_id: r.request_id ?? '', value });
      }
      return out;
    },

    async delete(req) {
      const provider = req.provider ?? '';
      const h = parseHandle(req.handle?.handle ?? '');
      if (!h) throw new DriverError('invalid_argument', `aquaman: not an aquaman handle: ${JSON.stringify(req.handle?.handle ?? '')}`);
      // A reference points at the user's own vault item: removing the provider must not delete it.
      if (h.mode === 'copy') await store.delete(h.service, h.key);
      emit({ op: 'delete', mode: h.mode, ref: h.ref, service: h.service, provider, success: true });
    },

    list() {
      return (scope?.declared() ?? []).map(({ ref, source }) => {
        const parsed = parseAquamanRef(ref)!;
        return { handle: ref, keys: [parsed.key], metadata: { source, mode: 'reference' } };
      });
    },
  };
}
