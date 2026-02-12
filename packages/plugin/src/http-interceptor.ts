/**
 * HTTP interceptor for channel credential isolation.
 *
 * Overrides globalThis.fetch to redirect requests targeting known channel API
 * hosts through the aquaman credential proxy via Unix domain socket.
 * The proxy injects the real credentials, so the Gateway process never sees them.
 *
 * OpenClaw channels use globalThis.fetch (backed by undici) for all HTTP calls.
 * Many channel monitor functions also accept a `proxyFetch` parameter that
 * falls back to globalThis.fetch, so overriding it covers both paths.
 *
 * Uses sentinel hostname `aquaman.local` — SDK base URLs are set to
 * `http://aquaman.local/<service>` and the interceptor routes them through UDS.
 */

import { Agent } from 'undici';

/** Sentinel hostname used in SDK base URLs to route through UDS */
const PROXY_HOST = 'aquaman.local';

export interface HttpInterceptorOptions {
  /** Unix domain socket path for the proxy */
  socketPath: string;
  /** Map of hostname (or *.domain wildcard) → service name */
  hostMap: Map<string, string>;
  /** Optional logger */
  log?: (msg: string) => void;
}

export class HttpInterceptor {
  private socketPath: string;
  private hostMap: Map<string, string>;
  private originalFetch: typeof globalThis.fetch | null = null;
  private active = false;
  private log: (msg: string) => void;
  private socketAgent: Agent | null = null;

  constructor(options: HttpInterceptorOptions) {
    this.socketPath = options.socketPath;
    this.hostMap = options.hostMap;
    this.log = options.log || (() => {});
  }

  /**
   * Activate the interceptor by replacing globalThis.fetch.
   */
  activate(): void {
    if (this.active) return;

    this.originalFetch = globalThis.fetch;
    this.socketAgent = new Agent({ connect: { socketPath: this.socketPath } });

    const origFetch = this.originalFetch;
    const socketAgent = this.socketAgent;
    const matchHost = this.matchHost.bind(this);
    const extractUrl = this.extractUrl.bind(this);
    const stripAuthHeaders = this.stripAuthHeaders.bind(this);
    const logFn = this.log;

    (globalThis as any).fetch = (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const url = extractUrl(input);
      if (!url) {
        return origFetch.call(globalThis, input, init);
      }

      // SDK traffic via env vars (hostname = aquaman.local) — route through UDS
      if (url.hostname === PROXY_HOST) {
        return origFetch.call(globalThis, input, { ...init, dispatcher: socketAgent } as any);
      }

      // Channel traffic — match against host map
      const service = matchHost(url.hostname);
      if (!service) {
        return origFetch.call(globalThis, input, init);
      }

      // Rewrite the URL to go through the proxy
      const proxyUrl = `http://${PROXY_HOST}/${service}${url.pathname}${url.search}`;
      logFn(`[aquaman] Intercepted ${url.hostname}${url.pathname} → ${service}`);

      // Strip any existing authorization headers — the proxy will inject the real ones
      let newInit = init;
      if (init?.headers) {
        const stripped = stripAuthHeaders(init.headers);
        newInit = { ...init, headers: stripped };
      }

      return origFetch.call(globalThis, proxyUrl, { ...newInit, redirect: 'manual', dispatcher: socketAgent } as any);
    };

    this.active = true;
    this.log(`[aquaman] HTTP interceptor active for ${this.hostMap.size} host patterns`);
  }

  /**
   * Deactivate the interceptor and restore the original fetch.
   */
  deactivate(): void {
    if (!this.active || !this.originalFetch) return;

    globalThis.fetch = this.originalFetch;
    this.originalFetch = null;
    this.active = false;

    if (this.socketAgent) {
      this.socketAgent.close();
      this.socketAgent = null;
    }

    this.log('[aquaman] HTTP interceptor deactivated');
  }

  isActive(): boolean {
    return this.active;
  }

  /**
   * Match a hostname against the host map, supporting wildcard patterns.
   */
  matchHost(hostname: string): string | null {
    // Direct match
    const direct = this.hostMap.get(hostname);
    if (direct) return direct;

    // Wildcard match: *.example.com matches sub.example.com
    for (const [pattern, service] of this.hostMap) {
      if (pattern.startsWith('*.') && hostname.endsWith(pattern.slice(1))) {
        return service;
      }
    }

    return null;
  }

  private extractUrl(input: RequestInfo | URL): URL | null {
    try {
      if (input instanceof URL) return input;
      if (typeof input === 'string') return new URL(input);
      if (typeof input === 'object' && 'url' in input) return new URL(input.url);
    } catch {
      // Not a valid URL — pass through
    }
    return null;
  }

  private stripAuthHeaders(headers: HeadersInit): HeadersInit {
    if (headers instanceof Headers) {
      const h = new Headers(headers);
      h.delete('authorization');
      h.delete('x-api-key');
      return h;
    }

    if (Array.isArray(headers)) {
      return headers.filter(
        ([key]) => key.toLowerCase() !== 'authorization' && key.toLowerCase() !== 'x-api-key'
      );
    }

    // Plain object
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== 'authorization' && key.toLowerCase() !== 'x-api-key') {
        result[key] = value;
      }
    }
    return result;
  }
}

export function createHttpInterceptor(options: HttpInterceptorOptions): HttpInterceptor {
  return new HttpInterceptor(options);
}
