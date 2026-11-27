/**
 * gRPC transport for the Agent Substrate credential provider. Serves
 * `substrate.credprovider.v1.CredentialProvider` over TLS 1.3 on a network
 * address, to one caller: Substrate's egress gateway.
 *
 * This is the one listener of the daemon that is meant to be reached from
 * another machine, so who may call it is decided twice. The TLS handshake
 * requires a client certificate that chains to the configured authority
 * (Substrate's pod identity signer). Then, when a call's headers arrive and
 * before its body is waited for, the certificate of that connection must be
 * within its validity dates and carry exactly one URI name, the gateway's
 * SPIFFE identity. A certificate from the same authority for any other
 * workload is refused there, so such a caller cannot hold calls open.
 *
 * A caller that passes the handshake can still hold connections. What bounds
 * that: a cap on calls per connection and on a connection's memory, an idle
 * time after which a connection without calls is closed, and a maximum age,
 * so a connection does not outlive the certificate it was opened with by
 * more than that age. When the authority bundle changes, the connections
 * opened under the old one are closed.
 *
 * Substrate issues the serving certificate and the authority bundle as files
 * in the pod and renews them about once a day. The files are read again when
 * they change. A set that does not load is not adopted: the listener keeps
 * the one it has and says so on stderr.
 *
 * `@grpc/grpc-js` and `@grpc/proto-loader` are optional peer dependencies,
 * loaded only when a gRPC listener is enabled.
 */

import * as fs from 'node:fs';
import * as tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadGrpc } from '../openshell/grpc-server.js';
import { ProviderError, shown, type SubstrateProviderCore } from './credential-provider.js';

/** Vendored proto: packages/proxy/proto/substrate, from both src/substrate and dist/substrate. */
export function substrateProtoDir(): string {
  return fileURLToPath(new URL('../../proto/substrate/', import.meta.url));
}

export interface SubstrateTlsFiles {
  /** PEM file with the serving certificate chain. */
  certFile: string;
  /** PEM file with the private key. Substrate writes key and chain into one file, so this may be `certFile`. */
  keyFile: string;
  /** PEM bundle of the authority a caller's certificate must chain to. */
  clientCaFile: string;
}

/**
 * The URI names in a certificate's subject alternative name, as Node prints
 * it (`URI:spiffe://..., DNS:...`). Node writes a name that holds a comma, a
 * quote or a control character as a JSON string; such a name is not a plain
 * URI and is returned as it is printed, quotes included, so it matches
 * nothing a caller could be expected to be.
 */
export function uriSubjectAltNames(subjectAltName: string | undefined): string[] {
  if (!subjectAltName) return [];
  const names: string[] = [];
  let i = 0;
  while (i < subjectAltName.length) {
    let j = i;
    let quoted = false;
    while (j < subjectAltName.length) {
      const c = subjectAltName[j];
      if (quoted) {
        if (c === '\\') j++;
        else if (c === '"') quoted = false;
      } else if (c === '"') {
        quoted = true;
      } else if (c === ',' && subjectAltName[j + 1] === ' ') {
        break;
      }
      j++;
    }
    const entry = subjectAltName.slice(i, j);
    if (entry.startsWith('URI:')) names.push(entry.slice(4));
    i = j + 2;
  }
  return names;
}

/**
 * Why a caller's certificate is not the expected workload's, or `null` when
 * it is. A SPIFFE certificate carries exactly one URI name, so one with two
 * is refused even when one of them is the right one. The dates are checked
 * here as well as in the handshake: a connection can stay open past the end
 * of the certificate it was opened with.
 */
export function callerRefusal(peerCertificateDer: Buffer | undefined, expectedSpiffeId: string, now: number = Date.now()): string | null {
  if (!peerCertificateDer || peerCertificateDer.length === 0) return 'the caller presented no certificate';
  let cert: X509Certificate;
  let names: string[];
  try {
    cert = new X509Certificate(peerCertificateDer);
    names = uriSubjectAltNames(cert.subjectAltName);
  } catch {
    return "the caller's certificate could not be read";
  }
  const from = Date.parse(cert.validFrom);
  const to = Date.parse(cert.validTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || now < from || now > to) {
    return "the caller's certificate is outside its validity dates";
  }
  if (names.length !== 1) return `the caller's certificate carries ${names.length} URI names, and a workload identity is exactly one`;
  if (names[0] !== expectedSpiffeId) return `the caller's certificate is not the egress gateway's identity (it names ${shown(names[0])})`;
  return null;
}

/** The certificates in a PEM bundle, each parsed; throws on a block that does not parse. */
function certificatesIn(pem: Buffer): X509Certificate[] {
  const blocks = pem.toString('latin1').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  return blocks.map((b) => new X509Certificate(b));
}

/** Key, chain and authority as one TLS context, or an error naming the file that failed. */
export function readTlsContext(files: SubstrateTlsFiles): tls.SecureContextOptions {
  const read = (file: string, what: string): Buffer => {
    try {
      return fs.readFileSync(file);
    } catch (err: any) {
      throw new Error(`cannot read the ${what} at ${file}: ${err?.message ?? err}`);
    }
  };
  const options: tls.SecureContextOptions = {
    cert: read(files.certFile, 'serving certificate'),
    key: read(files.keyFile, 'private key'),
    ca: read(files.clientCaFile, 'client authority bundle'),
    minVersion: 'TLSv1.3',
  };
  // Node loads a bundle whose certificates do not parse without complaint and
  // then accepts no caller at all. Such a bundle is a file caught half written
  // or damaged, and the set in use is better than it.
  let authorities: X509Certificate[];
  try {
    authorities = certificatesIn(options.ca as Buffer);
  } catch (err: any) {
    throw new Error(`the client authority bundle at ${files.clientCaFile} holds a certificate that does not parse: ${err?.message ?? err}`);
  }
  if (authorities.length === 0) throw new Error(`the client authority bundle at ${files.clientCaFile} holds no certificate`);
  try {
    tls.createSecureContext(options);
  } catch (err: any) {
    throw new Error(`the TLS files do not load (${files.certFile}, ${files.keyFile}, ${files.clientCaFile}): ${err?.message ?? err}`);
  }
  return options;
}

function filesStamp(files: SubstrateTlsFiles): string {
  return [files.certFile, files.keyFile, files.clientCaFile].map((f) => {
    try {
      const s = fs.statSync(f);
      return `${s.mtimeMs}:${s.size}:${s.ino}`;
    } catch {
      return 'absent';
    }
  }).join('|');
}

export interface SubstrateProviderServerOptions {
  /** `host:port` to listen on. Port 0 picks a free one. */
  listen: string;
  tls: SubstrateTlsFiles;
  /** The one identity that may call: the egress gateway's SPIFFE ID. */
  callerSpiffeId: string;
  /** How often the TLS files are checked for a change. */
  reloadIntervalMs?: number;
  /** Called with each refusal of a caller, for the audit log: the reason, and where the connection came from. */
  onCallerRefused?: (reason: string, from: string) => unknown;
}

/**
 * Bounds on what one connection may hold. The gateway keeps one connection
 * and sends one short call per request, so these are far above its needs.
 */
export const CONNECTION_LIMITS = {
  /** Calls open at once on one connection. */
  maxConcurrentStreams: 100,
  /** A connection with no call for this long is closed; the gateway connects again on its next request. */
  maxIdleMs: 5 * 60_000,
  /** A connection is closed after about this long (the library varies it by a tenth), so it cannot outlive its certificate by much more. */
  maxAgeMs: 60 * 60_000,
  /** Time a call in flight is given when a connection is closed for age or for a new authority. */
  graceMs: 10_000,
  /** Megabytes of memory one connection may use for its calls. */
  maxSessionMemoryMb: 4,
} as const;

export interface SubstrateProviderServer {
  /** The address in use, with the port that was bound. */
  address: string;
  port: number;
  /** Check the TLS files now; `true` when a new set was adopted. */
  reload(): boolean;
  stop(): Promise<void>;
}

export async function startSubstrateProviderServer(
  core: SubstrateProviderCore,
  options: SubstrateProviderServerOptions,
): Promise<SubstrateProviderServer> {
  const { grpc, protoLoader } = await loadGrpc();
  const definition = protoLoader.loadSync('credprovider.proto', {
    includeDirs: [substrateProtoDir()],
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const pkg = grpc.loadPackageDefinition(definition);

  const STATUS: Record<string, number> = {
    invalid_argument: grpc.status.INVALID_ARGUMENT,
    permission_denied: grpc.status.PERMISSION_DENIED,
    not_found: grpc.status.NOT_FOUND,
    failed_precondition: grpc.status.FAILED_PRECONDITION,
    unavailable: grpc.status.UNAVAILABLE,
  };

  // The library's own TLS credentials take the files once. This one keeps
  // the handshake settings and lets the certificate set be replaced.
  class ReloadingCredentials extends grpc.ServerCredentials {
    constructor(context: tls.SecureContextOptions) {
      super({ requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, context);
    }
    adopt(context: tls.SecureContextOptions): void {
      this.updateSecureContextOptions(context);
    }
    _equals(other: unknown): boolean {
      return other === this;
    }
  }

  let stamp = filesStamp(options.tls);
  let context = readTlsContext(options.tls);
  const credentials = new ReloadingCredentials(context);
  let reloadFailure: string | null = null;
  let drainPort: string | null = null;
  // Connections opened under an authority that has been replaced are still to be closed.
  let drainOwed = false;
  let server: any = null;

  const reload = (): boolean => {
    const now = filesStamp(options.tls);
    if (now === stamp) return false;
    try {
      const next = readTlsContext(options.tls);
      const authorityChanged = !(next.ca as Buffer).equals(context.ca as Buffer);
      credentials.adopt(next);
      // A connection opened under the previous authority was checked against
      // it once, at its handshake. It is closed, and has to pass the new one.
      // The new set counts as adopted only after that, so a drain that failed
      // is tried again at the next check.
      if (authorityChanged) drainOwed = true;
      if (drainOwed && drainPort) {
        try {
          server?.drain(drainPort, CONNECTION_LIMITS.graceMs);
          drainOwed = false;
        } catch (err) {
          // New handshakes already use the new set. Not counted as done, so the next check tries again.
          const message = `the new client authority is in use for new connections, but the connections opened under the old one could not be closed: ${err instanceof Error ? err.message : String(err)}`;
          if (message !== reloadFailure) {
            reloadFailure = message;
            console.error(`  ⚠ Agent Substrate credential provider: ${message}`);
          }
          return false;
        }
      }
      context = next;
    } catch (err) {
      // Tried again at the next check: the files may be half written.
      const message = err instanceof Error ? err.message : String(err);
      if (message !== reloadFailure) {
        reloadFailure = message;
        console.error(`  ⚠ Agent Substrate credential provider: new TLS files were not adopted, the previous ones stay in use: ${message}`);
      }
      return false;
    }
    stamp = now;
    reloadFailure = null;
    return true;
  };

  const handlers = {
    FetchSecret(call: any, cb: any) {
      core.fetchSecret(call.request).then(
        (bytes) => cb(null, { opaque_bytes: bytes }),
        (err) => cb({
          code: err instanceof ProviderError ? STATUS[err.code] : grpc.status.UNAVAILABLE,
          message: err instanceof ProviderError ? err.message : 'aquaman: the request could not be answered',
        }),
      );
    },
  };

  // Runs when a call's headers arrive, before its body: a caller that is not
  // the gateway is answered at once and cannot leave calls waiting.
  const callerCheck = (_method: unknown, call: any) => new grpc.ServerInterceptingCall(call, {
    start(next: any) {
      // Whatever goes wrong while looking at the caller is a refusal. An
      // exception here would otherwise be nobody's to catch.
      let refusal: string | null;
      let peer = '';
      try {
        refusal = callerRefusal(call.getAuthContext?.()?.sslPeerCertificate?.raw, options.callerSpiffeId);
        if (refusal) peer = String(call.getPeer?.() ?? '');
      } catch {
        refusal = "the caller's connection could not be examined";
      }
      if (!refusal) return next();
      const reason = refusal;
      void Promise.resolve().then(() => options.onCallerRefused?.(reason, shown(peer))).catch(() => { /* the callback reports its own failures */ });
      call.sendStatus({ code: grpc.status.PERMISSION_DENIED, details: `aquaman: ${reason}` });
    },
  });

  server = new grpc.Server({
    interceptors: [callerCheck],
    'grpc.max_receive_message_length': 16 * 1024,
    'grpc.max_concurrent_streams': CONNECTION_LIMITS.maxConcurrentStreams,
    'grpc.max_connection_idle_ms': CONNECTION_LIMITS.maxIdleMs,
    'grpc.max_connection_age_ms': CONNECTION_LIMITS.maxAgeMs,
    'grpc.max_connection_age_grace_ms': CONNECTION_LIMITS.graceMs,
    'grpc-node.max_session_memory': CONNECTION_LIMITS.maxSessionMemoryMb,
  });
  server.addService(pkg.substrate.credprovider.v1.CredentialProvider.service, handlers);
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync(options.listen, credentials, (err: Error | null, bound: number) => {
      if (err) reject(new Error(`Agent Substrate credential provider could not listen on ${options.listen}: ${err.message}`));
      else resolve(bound);
    });
  });
  drainPort = options.listen.replace(/:\d+$/, `:${port}`);

  const timer = setInterval(reload, options.reloadIntervalMs ?? 15_000);
  timer.unref();

  return {
    address: options.listen.replace(/:\d+$/, `:${port}`),
    port,
    reload,
    async stop() {
      clearInterval(timer);
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => { server.forceShutdown(); resolve(); }, 2000);
        force.unref();
        server.tryShutdown(() => { clearTimeout(force); resolve(); });
      });
    },
  };
}
