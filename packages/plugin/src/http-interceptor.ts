/**
 * HTTP fetch interceptor for channel credential isolation.
 *
 * Overrides globalThis.fetch to redirect requests targeting known channel API
 * hosts through the aquaman credential proxy. The proxy injects the real
 * credentials, so the Gateway process never sees them.
 *
 * OpenClaw channels use globalThis.fetch (backed by undici) for all HTTP calls.
 * Many channel monitor functions also accept a `proxyFetch` parameter that
 * falls back to globalThis.fetch, so overriding it covers both paths.
 */

export interface HttpInterceptorOptions {
  /** Base URL of the aquaman proxy, e.g. "http://127.0.0.1:8081" */
  proxyBaseUrl: string;
  /** Map of hostname (or *.domain wildcard) → service name */
  hostMap: Map<string, string>;
  /** Client authentication token for the proxy */
  clientToken?: string;
  /** Optional logger */
  log?: (msg: string) => void;
}

export class HttpInterceptor {
  private proxyBaseUrl: string;
  private proxyHost: string;
  private hostMap: Map<string, string>;
  private clientToken: string | null;
  private originalFetch: typeof globalThis.fetch | null = null;
  private active = false;
  private log: (msg: string) => void;

  constructor(options: HttpInterceptorOptions) {
    this.proxyBaseUrl = options.proxyBaseUrl.replace(/\/$/, '');
    this.hostMap = options.hostMap;
    this.clientToken = options.clientToken || null;
    this.log = options.log || (() => {});

    // Extract proxy hostname to avoid intercepting requests to the proxy itself
    try {
      this.proxyHost = new URL(this.proxyBaseUrl).hostname;
    } catch {
      this.proxyHost = '127.0.0.1';
    }
  }

  /**
   * Activate the interceptor by replacing globalThis.fetch.
   */
  activate(): void {
    if (this.active) return;

    this.originalFetch = globalThis.fetch;

    const origFetch = this.originalFetch;
    const proxyBase = this.proxyBaseUrl;
    const proxyHostname = this.proxyHost;
    const token = this.clientToken;
    const matchHost = this.matchHost.bind(this);
    const extractUrl = this.extractUrl.bind(this);
    const stripAuthHeaders = this.stripAuthHeaders.bind(this);
    const injectToken = this.injectTokenHeader.bind(this);
    const logFn = this.log;

    globalThis.fetch = (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const url = extractUrl(input);
      if (!url) {
        return origFetch.call(globalThis, input, init);
      }

      // Requests to the proxy itself (SDK traffic via env vars) — inject token, pass through
      if (url.hostname === proxyHostname || url.hostname === 'localhost') {
        if (token) {
          const tokenInit = injectToken(init, token);
          return origFetch.call(globalThis, input, tokenInit);
        }
        return origFetch.call(globalThis, input, init);
      }

      const service = matchHost(url.hostname);
      if (!service) {
        return origFetch.call(globalThis, input, init);
      }

      // Rewrite the URL to go through the proxy
      const proxyUrl = `${proxyBase}/${service}${url.pathname}${url.search}`;
      logFn(`[aquaman] Intercepted ${url.hostname}${url.pathname} → ${service}`);

      // Strip any existing authorization headers — the proxy will inject the real ones
      let newInit = init;
      if (init?.headers) {
        const stripped = stripAuthHeaders(init.headers);
        newInit = { ...init, headers: stripped };
      }

      // Inject client token for proxy authentication
      if (token) {
        newInit = injectToken(newInit, token);
      }

      return origFetch.call(globalThis, proxyUrl, newInit);
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

  private injectTokenHeader(init: RequestInit | undefined, token: string): RequestInit {
    const base = init || {};
    const headers = base.headers;

    if (!headers) {
      return { ...base, headers: { 'x-aquaman-token': token } };
    }

    if (headers instanceof Headers) {
      const h = new Headers(headers);
      h.set('x-aquaman-token', token);
      return { ...base, headers: h };
    }

    if (Array.isArray(headers)) {
      return { ...base, headers: [...headers, ['x-aquaman-token', token]] };
    }

    // Plain object
    return { ...base, headers: { ...headers, 'x-aquaman-token': token } };
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
