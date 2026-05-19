/**
 * Broker client — talks to the aquaman-proxy daemon over UDS to
 * materialize credentials per tool call.
 *
 * Wraps `POST /broker/resolve` with retry, timeout, and clean errors.
 */

import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

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

export function defaultSocketPath(): string {
  return path.join(os.homedir(), '.aquaman', 'proxy.sock');
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
      throw new Error(`${msg}${fix}`);
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
          reject(new Error(
            `Cannot reach aquaman proxy at ${this.socketPath}. ` +
            `Start it with: aquaman daemon`
          ));
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
