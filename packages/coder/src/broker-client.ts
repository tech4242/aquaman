/**
 * Broker client — talks to the aquaman-proxy daemon over UDS to
 * materialize credentials per tool call.
 *
 * Wraps `POST /broker/resolve` with retry, timeout, and clean errors.
 */

import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * aquaman's config dir, same rule as the proxy's getConfigDir(). Duplicated
 * rather than imported from aquaman-proxy on purpose: this CLI is spawned
 * from source (`npx tsx .../cli/index.ts`) in tests and dev, where the proxy's
 * dist build may not exist yet, and a runtime import would fail there.
 */
export function aquamanConfigDir(): string {
  return process.env['AQUAMAN_CONFIG_DIR'] || path.join(os.homedir(), '.aquaman');
}

export interface BrokerResolveOptions {
  service: string;
  key: string;
  ttlSeconds?: number;
}

export interface BrokerResolveResult {
  value: string;
  expiresAt: string;
}

export interface BrokerClientOptions {
  socketPath?: string;
  timeoutMs?: number;
}

/** Same socket the daemon binds: `<configDir>/proxy.sock` (honors AQUAMAN_CONFIG_DIR). */
export function defaultSocketPath(): string {
  return path.join(aquamanConfigDir(), 'proxy.sock');
}

/**
 * A broker refusal or failure with the daemon's machine-readable `code`
 * (v0.15.0+: `broker_disabled`, `broker_ref_not_declared`,
 * `broker_ref_isolated`) and HTTP status, so callers can pick the right fix.
 */
export class BrokerError extends Error {
  readonly code?: string;
  readonly status?: number;
  readonly fix?: string;

  constructor(message: string, opts: { code?: string; status?: number; fix?: string } = {}) {
    super(message);
    this.name = 'BrokerError';
    this.code = opts.code;
    this.status = opts.status;
    this.fix = opts.fix;
  }
}

/**
 * Claude Code's sandbox denies Unix-socket connects it hasn't allowlisted, and
 * the kernel reports that as EPERM (macOS Seatbelt) or EACCES/EPERM (Linux
 * seccomp). Say so instead of surfacing a bare errno.
 */
export function sandboxSocketHint(socketPath: string): string {
  return (
    `Connecting to the aquaman proxy socket at ${socketPath} was blocked — most likely by ` +
    `Claude Code's sandbox, which denies Unix sockets by default. On macOS run ` +
    `\`aquaman coder setup claude-code\` (it allowlists this socket in sandbox.network.allowUnixSockets). ` +
    `On Linux/WSL2 the sandbox can only allow it with sandbox.network.allowAllUnixSockets: true, ` +
    `which opens every Unix socket to sandboxed commands.`
  );
}

export class BrokerClient {
  private socketPath: string;
  private timeoutMs: number;

  constructor(opts: BrokerClientOptions = {}) {
    this.socketPath = opts.socketPath ?? defaultSocketPath();
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  /**
   * Materialize a credential. Throws if the proxy is unreachable,
   * the credential is not found, or the request is policy-denied.
   */
  async resolve(opts: BrokerResolveOptions): Promise<BrokerResolveResult> {
    const body = JSON.stringify({
      service: opts.service,
      key: opts.key,
      ttl_seconds: opts.ttlSeconds,
    });

    const { statusCode, payload } = await this.request('POST', '/broker/resolve', body);

    let json: any;
    try {
      json = JSON.parse(payload);
    } catch {
      throw new Error(
        `Broker returned non-JSON response (status ${statusCode}): ${payload.slice(0, 200)}`
      );
    }

    if (statusCode >= 400) {
      const msg = json.error || `Broker error (HTTP ${statusCode})`;
      const fix = json.fix ? ` — ${json.fix}` : '';
      throw new BrokerError(`${msg}${fix}`, { code: json.code, status: statusCode, fix: json.fix });
    }

    if (typeof json.value !== 'string' || typeof json.expires_at !== 'string') {
      throw new Error('Broker response missing value / expires_at');
    }

    return { value: json.value, expiresAt: json.expires_at };
  }

  /**
   * Check whether the proxy is up and responsive.
   */
  async health(): Promise<{ status: string; version?: string }> {
    const { statusCode, payload } = await this.request('GET', '/_health');
    if (statusCode !== 200) {
      throw new Error(`Proxy health check failed: HTTP ${statusCode}`);
    }
    return JSON.parse(payload);
  }

  private request(
    method: 'GET' | 'POST',
    urlPath: string,
    body?: string
  ): Promise<{ statusCode: number; payload: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          path: urlPath,
          method,
          headers: body
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            : undefined,
          timeout: this.timeoutMs,
        },
        (res) => {
          let chunks = '';
          res.on('data', (chunk) => { chunks += chunk; });
          res.on('end', () => {
            resolve({ statusCode: res.statusCode ?? 0, payload: chunks });
          });
        }
      );

      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
          reject(new BrokerError(
            `Cannot reach aquaman proxy at ${this.socketPath}. ` +
            `Start it with: aquaman daemon`,
            { code: 'proxy_unreachable' }
          ));
        } else if (err.code === 'EPERM' || err.code === 'EACCES') {
          reject(new BrokerError(sandboxSocketHint(this.socketPath), { code: 'socket_blocked' }));
        } else {
          reject(err);
        }
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Broker request timed out after ${this.timeoutMs}ms`));
      });

      if (body) req.write(body);
      req.end();
    });
  }
}
