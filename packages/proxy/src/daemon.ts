/**
 * Credential proxy daemon - holds secrets and proxies authenticated API calls
 * OpenClaw connects to this proxy via Unix domain socket instead of directly to external APIs
 */

import * as http from 'node:http';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { type CredentialStore, generateId } from './core/index.js';
import { ServiceRegistry, createServiceRegistry, type ServiceDefinition, type AuthMode } from './service-registry.js';
import { OAuthTokenCache, createOAuthTokenCache } from './oauth-token-cache.js';
import { matchPolicy, type PolicyConfig } from './request-policy.js';

// Service name validation: lowercase alphanum, dots, hyphens, underscores
const SAFE_SERVICE_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Constant-time string comparison that doesn't leak length via an early
 * return. timingSafeEqual requires equal-length buffers, so unequal lengths
 * are compared against self (to burn comparable time) and then rejected.
 */
function timingSafeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

// Read version from package.json
const __daemonFilename = fileURLToPath(import.meta.url);
const __daemonDirname = path.dirname(__daemonFilename);
const daemonPkgJson = JSON.parse(fs.readFileSync(path.resolve(__daemonDirname, '../package.json'), 'utf-8'));
const DAEMON_VERSION: string = daemonPkgJson.version;

export interface CredentialProxyOptions {
  socketPath: string;
  store: CredentialStore;
  allowedServices: string[];
  onRequest?: (info: RequestInfo) => void;
  serviceRegistry?: ServiceRegistry;
  requestTimeout?: number; // Upstream request timeout in ms, defaults to 30000 (30s)
  policyConfig?: PolicyConfig;
  /**
   * Opt-in loopback TCP listener for foreign-language agent hosts (Hermes)
   * that can't dial a UDS. Default-off. When set, the proxy ALSO listens on
   * `host:port` (host defaults to 127.0.0.1) and requires every request on
   * that listener to present `token` — as `x-api-key`, `Authorization: Bearer`,
   * or `x-aquaman-token`. Requests on the UDS are unaffected (file-perm gated).
   */
  loopback?: { port: number; token: string; host?: string };
}

export interface RequestInfo {
  id: string;
  service: string;
  method: string;
  path: string;
  timestamp: Date;
  authenticated: boolean;
  statusCode?: number;
  error?: string;
}

interface ServiceConfig {
  upstream: string;
  authHeader: string;
  authPrefix?: string;
  credentialKey: string;
}

export class CredentialProxy {
  private server: http.Server | null = null;
  private loopbackServer: http.Server | null = null;
  private options: CredentialProxyOptions;
  private running = false;
  private serviceRegistry: ServiceRegistry;
  private oauthCache: OAuthTokenCache;

  constructor(options: CredentialProxyOptions) {
    this.options = options;
    this.serviceRegistry = options.serviceRegistry || createServiceRegistry();
    this.oauthCache = createOAuthTokenCache();
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Credential proxy already running');
    }

    const handlerFor = (fromLoopback: boolean) => (req: IncomingMessage, res: ServerResponse) => {
      this.handleRequest(req, res, fromLoopback).catch(error => {
        console.error('Proxy error:', error);
        res.statusCode = 500;
        res.end('Internal proxy error');
      });
    };

    this.server = http.createServer(handlerFor(false));

    // Clean up stale socket (atomic — no TOCTOU race)
    try { fs.unlinkSync(this.options.socketPath); } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }

    // Ensure socket directory exists
    const socketDir = path.dirname(this.options.socketPath);
    if (!fs.existsSync(socketDir)) {
      fs.mkdirSync(socketDir, { recursive: true });
    }

    await new Promise<void>((resolve, reject) => {
      // Set restrictive umask so the socket file is created owner-only.
      // process.umask() is unsupported in worker threads — guard with try/catch.
      let prevUmask: number | undefined;
      try { prevUmask = process.umask(0o177); } catch { /* worker thread */ }

      this.server!.listen(this.options.socketPath, () => {
        if (prevUmask !== undefined) try { process.umask(prevUmask); } catch { /* worker */ }
        // Explicitly chmod the socket to 0o600 — umask isn't honored under
        // Vitest worker threads (process.umask is unsupported there) and we
        // want a hard guarantee, not a best-effort one.
        try { fs.chmodSync(this.options.socketPath, 0o600); } catch { /* socket gone */ }
        this.running = true;
        console.log(`Credential proxy listening on ${this.options.socketPath}`);
        resolve();
      });

      this.server!.on('error', (err: NodeJS.ErrnoException) => {
        if (prevUmask !== undefined) try { process.umask(prevUmask); } catch { /* worker */ }
        reject(err);
      });
    });

    // Opt-in loopback TCP listener (Hermes path). Token-gated; bound to
    // loopback only. If it fails to bind, tear down the UDS server too so we
    // don't leave a half-started proxy running.
    if (this.options.loopback) {
      const { port, host = '127.0.0.1' } = this.options.loopback;
      this.loopbackServer = http.createServer(handlerFor(true));
      try {
        await new Promise<void>((resolve, reject) => {
          this.loopbackServer!.on('error', reject);
          this.loopbackServer!.listen(port, host, () => {
            console.log(`Credential proxy loopback listening on http://${this.getLoopbackAddress()}`);
            resolve();
          });
        });
      } catch (err) {
        this.loopbackServer = null;
        await this.stop();
        throw err;
      }
    }
  }

  /**
   * Validate the per-request loopback token. The agent host presents it as the
   * provider api_key, so it arrives in whatever header that provider's SDK uses
   * (`x-api-key` for Anthropic, `Authorization: Bearer` for OpenAI), or as an
   * explicit `x-aquaman-token`. Comparison is constant-time.
   */
  private isLoopbackTokenValid(req: IncomingMessage): boolean {
    const expected = this.options.loopback?.token;
    if (!expected) return false;

    const candidates: string[] = [];
    const header = (name: string): string | undefined => {
      const v = req.headers[name];
      return Array.isArray(v) ? v[0] : v;
    };

    const explicit = header('x-aquaman-token');
    if (explicit) candidates.push(explicit);

    const apiKey = header('x-api-key');
    if (apiKey) candidates.push(apiKey);

    const authz = header('authorization');
    if (authz) {
      candidates.push(authz.replace(/^Bearer\s+/i, ''));
    }

    return candidates.some(c => timingSafeStrEqual(c, expected));
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse, fromLoopback = false): Promise<void> {
    const requestId = generateId();
    const url = req.url || '/';

    // Loopback listener is network-reachable (unlike the 0o600 UDS), so every
    // request on it must present the loopback token. Health check is exempt so
    // local tooling can probe liveness without the token.
    if (fromLoopback && url !== '/_health' && url !== '/_health/' && !this.isLoopbackTokenValid(req)) {
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 401;
      res.end(JSON.stringify({
        error: 'Loopback request rejected: missing or invalid aquaman loopback token',
        fix: 'Set the placeholder api_key in ~/.hermes/.env to the token from: aquaman hermes status'
      }));
      return;
    }

    // Health check endpoint
    if (url === '/_health' || url === '/_health/') {
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 200;
      res.end(JSON.stringify({ status: 'ok', version: DAEMON_VERSION, uptime: process.uptime(), services: this.options.allowedServices }));
      return;
    }

    // Host map endpoint — returns hostname→service mapping for interceptors
    if (url === '/_hostmap' || url === '/_hostmap/') {
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 200;
      const hostMap = this.serviceRegistry.buildHostMap();
      const obj: Record<string, string> = {};
      for (const [pattern, serviceName] of hostMap) {
        obj[pattern] = serviceName;
      }
      res.end(JSON.stringify(obj));
      return;
    }

    // Broker endpoint — resolves a vault-stored credential and returns it
    // with a short-lived expiry hint. Used by aquaman-coder hooks (v0.12.0+)
    // to materialize credentials on-demand for one tool call, then discard.
    // The expires_at field is a hint for the consumer, not a server-side
    // expiration (the value isn't cached daemon-side beyond the call).
    if ((url === '/broker/resolve' || url === '/broker/resolve/') && req.method === 'POST') {
      await this.handleBrokerResolve(req, res, requestId);
      return;
    }

    // Parse service from path: /anthropic/v1/messages -> anthropic
    const pathParts = url.split('/').filter(p => p);
    const service = pathParts[0];

    // Validate service name to prevent path traversal / injection
    if (service && !SAFE_SERVICE_NAME.test(service)) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }

    if (!service || !this.options.allowedServices.includes(service)) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }

    const serviceDef = this.serviceRegistry.get(service);
    if (!serviceDef) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }

    const authMode: AuthMode = serviceDef.authMode || 'header';

    if (authMode === 'none') {
      res.statusCode = 400;
      res.end(`Service "${service}" is at-rest storage only and does not support proxying`);
      return;
    }

    const config: ServiceConfig = {
      upstream: serviceDef.upstream,
      authHeader: serviceDef.authHeader,
      authPrefix: serviceDef.authPrefix,
      credentialKey: serviceDef.credentialKey
    };

    const remainingPath = '/' + pathParts.slice(1).join('/');

    const requestInfo: RequestInfo = {
      id: requestId,
      service,
      method: req.method || 'GET',
      path: url,
      timestamp: new Date(),
      authenticated: false
    };

    // Policy check — before credential retrieval
    if (this.options.policyConfig) {
      const policyResult = matchPolicy(service, req.method || 'GET', remainingPath, this.options.policyConfig);
      if (!policyResult.allowed) {
        requestInfo.error = `Policy denied: ${req.method || 'GET'} ${remainingPath}`;
        requestInfo.statusCode = 403;
        this.emitRequest(requestInfo);
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 403;
        res.end(JSON.stringify({
          error: `Request denied by policy: ${req.method || 'GET'} ${url}`,
          fix: `Check policy rules for "${service}" in ~/.aquaman/config.yaml`
        }));
        return;
      }
    }

    try {
      // Get primary credential from store
      const credential = await this.options.store.get(service, config.credentialKey);

      if (!credential) {
        requestInfo.error = 'Credential not found';
        requestInfo.statusCode = 401;
        this.emitRequest(requestInfo);
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 401;
        res.end(JSON.stringify({
          error: `No credential found for ${service}/${config.credentialKey}`,
          fix: `Run: aquaman credentials add ${service} ${config.credentialKey}`
        }));
        return;
      }

      requestInfo.authenticated = true;

      // Build upstream URL based on auth mode
      let upstreamPath: string;

      if (authMode === 'url-path' && serviceDef.authPathTemplate) {
        // Inject token into URL path: /bot{token}/getUpdates
        const tokenPath = serviceDef.authPathTemplate.replace('{token}', credential);
        upstreamPath = tokenPath + remainingPath;
      } else {
        upstreamPath = remainingPath;
      }

      const upstreamUrl = new URL(upstreamPath, config.upstream);

      // Forward the request with auth mode context
      await this.proxyRequest(req, res, upstreamUrl, serviceDef, credential, requestInfo);

    } catch (error) {
      requestInfo.error = error instanceof Error ? error.message : String(error);
      requestInfo.statusCode = 500;
      this.emitRequest(requestInfo);
      res.statusCode = 500;
      res.end('Proxy error');
    }
  }

  private async proxyRequest(
    clientReq: IncomingMessage,
    clientRes: ServerResponse,
    upstreamUrl: URL,
    serviceDef: ServiceDefinition,
    credential: string,
    requestInfo: RequestInfo
  ): Promise<void> {
    const isHttps = upstreamUrl.protocol === 'https:';
    const transport = isHttps ? https : http;
    const authMode: AuthMode = serviceDef.authMode || 'header';

    // Copy headers, strip auth-related ones
    const headers: Record<string, string> = {};

    if (clientReq.headers) {
      for (const [key, value] of Object.entries(clientReq.headers)) {
        if (key.toLowerCase() === 'host') continue;
        // Strip existing auth header if we're injecting one
        if (serviceDef.authHeader && key.toLowerCase() === serviceDef.authHeader.toLowerCase()) continue;
        if (key.toLowerCase() === 'authorization') continue;
        // Never forward the loopback access token to the upstream provider
        if (key.toLowerCase() === 'x-aquaman-token') continue;
        if (value) {
          headers[key] = Array.isArray(value) ? value[0] : value;
        }
      }
    }

    // Inject authentication based on auth mode
    if (authMode === 'header') {
      const authValue = serviceDef.authPrefix
        ? `${serviceDef.authPrefix}${credential}`
        : credential;
      headers[serviceDef.authHeader] = authValue;
    } else if (authMode === 'basic') {
      // Basic auth: base64(primary:secondary)
      let password = '';
      if (serviceDef.additionalCredentialKeys?.length) {
        password = await this.options.store.get(
          requestInfo.service, serviceDef.additionalCredentialKeys[0]
        ) || '';
      }
      const encoded = Buffer.from(`${credential}:${password}`).toString('base64');
      headers['Authorization'] = `Basic ${encoded}`;
    }
    // url-path mode: credential already injected into URL by handleRequest, no header needed
    else if (authMode === 'oauth' && serviceDef.oauthConfig) {
      const accessToken = await this.oauthCache.getToken(
        requestInfo.service, serviceDef.oauthConfig, this.options.store
      );
      const authValue = serviceDef.authPrefix
        ? `${serviceDef.authPrefix}${accessToken}`
        : `Bearer ${accessToken}`;
      headers[serviceDef.authHeader || 'Authorization'] = authValue;
    }

    // Inject additional headers (e.g. Twitch Client-Id)
    if (serviceDef.additionalHeaders) {
      for (const [headerName, headerDef] of Object.entries(serviceDef.additionalHeaders)) {
        const headerCredential = await this.options.store.get(
          requestInfo.service, headerDef.credentialKey
        );
        if (headerCredential) {
          const headerValue = headerDef.prefix
            ? `${headerDef.prefix}${headerCredential}`
            : headerCredential;
          headers[headerName] = headerValue;
        }
      }
    }

    return new Promise((resolve) => {

      const options = {
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (isHttps ? 443 : 80),
        path: upstreamUrl.pathname + upstreamUrl.search,
        method: clientReq.method,
        headers
      };

      const proxyReq = transport.request(options, (proxyRes) => {
        requestInfo.statusCode = proxyRes.statusCode;
        this.emitRequest(requestInfo);

        // Copy response headers (except those that shouldn't be forwarded)
        const responseHeaders = proxyRes.headers;
        for (const [key, value] of Object.entries(responseHeaders)) {
          if (key.toLowerCase() === 'transfer-encoding') continue;
          if (value) {
            clientRes.setHeader(key, value);
          }
        }

        clientRes.statusCode = proxyRes.statusCode || 200;
        proxyRes.pipe(clientRes);
        proxyRes.on('end', resolve);
      });

      proxyReq.on('error', (error) => {
        requestInfo.error = error.message;
        requestInfo.statusCode = 502;
        this.emitRequest(requestInfo);

        if (!clientRes.headersSent) {
          clientRes.statusCode = 502;
          clientRes.end('Upstream error');
        }
        resolve();
      });

      // Add timeout to prevent indefinite hangs
      const timeout = this.options.requestTimeout ?? 30000;
      proxyReq.setTimeout(timeout, () => {
        proxyReq.destroy();
        requestInfo.error = 'Gateway timeout';
        requestInfo.statusCode = 504;
        this.emitRequest(requestInfo);

        if (!clientRes.headersSent) {
          clientRes.statusCode = 504;
          clientRes.end('Gateway Timeout');
        }
        resolve();
      });

      // Forward request body
      clientReq.pipe(proxyReq);
    });
  }

  private emitRequest(info: RequestInfo): void {
    if (this.options.onRequest) {
      this.options.onRequest(info);
    }
  }

  /**
   * Broker endpoint handler. Resolves a vault-stored credential and returns
   * it with an expiry hint so the consumer (typically an aquaman-coder hook)
   * can scrub it after the indicated TTL. The daemon does not cache the
   * value beyond this single response — every call re-reads from the vault.
   *
   * Request body (JSON):
   *   { "service": "aws", "key": "secret_access_key", "ttl_seconds": 60 }
   *
   * Responses:
   *   200 → { "value": "...", "expires_at": "ISO-8601 UTC" }
   *   400 → { "error": "...", "fix": "..." }       (malformed body)
   *   404 → { "error": "...", "fix": "..." }       (credential not found)
   *   500 → { "error": "...", "fix": "..." }       (vault backend failed)
   *
   * The expires_at field is advisory; the consumer is expected to honor it.
   * v0.12.0+ — used by the aquaman-coder hook adapters to materialize
   * credentials per tool call without writing .env files to disk.
   */
  private async handleBrokerResolve(
    req: IncomingMessage,
    res: ServerResponse,
    requestId: string
  ): Promise<void> {
    res.setHeader('Content-Type', 'application/json');

    // Read request body
    let bodyBuf = '';
    for await (const chunk of req) {
      bodyBuf += (chunk as Buffer).toString('utf-8');
      if (bodyBuf.length > 4096) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'Broker request body too large', fix: 'Keep broker requests under 4 KB' }));
        return;
      }
    }

    let body: { service?: unknown; key?: unknown; ttl_seconds?: unknown };
    try {
      body = JSON.parse(bodyBuf);
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Broker request body is not valid JSON', fix: 'POST a JSON body with { service, key, ttl_seconds }' }));
      return;
    }

    const service = body.service;
    const key = body.key;
    const ttlInput = body.ttl_seconds;

    if (typeof service !== 'string' || !service) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Broker request missing required string field: service', fix: 'Include { service: "<name>" } in the JSON body' }));
      return;
    }
    if (typeof key !== 'string' || !key) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Broker request missing required string field: key', fix: 'Include { key: "<name>" } in the JSON body' }));
      return;
    }
    if (!SAFE_SERVICE_NAME.test(service)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: `Invalid service name: ${JSON.stringify(service)}`, fix: 'Service names must match /^[a-z0-9][a-z0-9._-]*$/' }));
      return;
    }
    // Key name validation: alphanumeric, dots, hyphens, underscores. Allows
    // common patterns like "api_key", "secret_access_key", "bot_token".
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(key)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: `Invalid key name: ${JSON.stringify(key)}`, fix: 'Key names must match /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/' }));
      return;
    }

    // TTL defaults to 60 seconds; clamp to [1, 3600].
    let ttlSeconds = 60;
    if (ttlInput !== undefined) {
      if (typeof ttlInput !== 'number' || !Number.isFinite(ttlInput) || ttlInput < 1 || ttlInput > 3600) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'Invalid ttl_seconds (must be a number 1..3600)', fix: 'Omit ttl_seconds to use the 60-second default' }));
        return;
      }
      ttlSeconds = Math.floor(ttlInput);
    }

    // Fetch from vault
    let value: string | null;
    try {
      value = await this.options.store.get(service, key);
    } catch (err) {
      res.statusCode = 500;
      const message = err instanceof Error ? err.message : String(err);
      res.end(JSON.stringify({
        error: `Vault backend error resolving ${service}/${key}: ${message}`,
        fix: 'Check that the configured backend (keychain, 1password, vault, etc.) is accessible. Run: aquaman doctor'
      }));
      this.emitRequest({
        id: requestId,
        service,
        method: 'BROKER',
        path: `/broker/resolve`,
        timestamp: new Date(),
        authenticated: false,
        statusCode: 500,
        error: message,
      });
      return;
    }

    if (value === null) {
      res.statusCode = 404;
      res.end(JSON.stringify({
        error: `No credential found for ${service}/${key}`,
        fix: `Run: aquaman credentials add ${service} ${key}`
      }));
      this.emitRequest({
        id: requestId,
        service,
        method: 'BROKER',
        path: `/broker/resolve`,
        timestamp: new Date(),
        authenticated: false,
        statusCode: 404,
      });
      return;
    }

    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    res.statusCode = 200;
    res.end(JSON.stringify({ value, expires_at: expiresAt }));

    // Audit: broker call resolved (value not logged — only service/key
    // metadata, matching the rest of the audit log's content discipline).
    this.emitRequest({
      id: requestId,
      service,
      method: 'BROKER',
      path: `/broker/resolve`,
      timestamp: new Date(),
      authenticated: true,
      statusCode: 200,
    });
  }

  async stop(): Promise<void> {
    const socketPath = this.options.socketPath;

    // Close the loopback listener first (if any), then the UDS server.
    if (this.loopbackServer) {
      const lb = this.loopbackServer;
      this.loopbackServer = null;
      await new Promise<void>((resolve) => lb.close(() => resolve()));
    }

    if (!this.running || !this.server) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.server!.close((error) => {
        if (error) {
          reject(error);
        } else {
          this.running = false;
          this.server = null;
          // Clean up socket file
          try { fs.unlinkSync(socketPath); } catch { /* already removed */ }
          resolve();
        }
      });
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  getSocketPath(): string {
    return this.options.socketPath;
  }

  /**
   * Returns the loopback bind address (host:port) if the listener is active,
   * else null. Reports the actually-bound port (so `port: 0` resolves to the
   * OS-assigned port) when available.
   */
  getLoopbackAddress(): string | null {
    if (!this.loopbackServer || !this.options.loopback) return null;
    const host = this.options.loopback.host ?? '127.0.0.1';
    const addr = this.loopbackServer.address();
    const port = addr && typeof addr === 'object' ? addr.port : this.options.loopback.port;
    return `${host}:${port}`;
  }

  getServiceRegistry(): ServiceRegistry {
    return this.serviceRegistry;
  }

  getServiceConfigs(): Record<string, ServiceConfig> {
    return this.serviceRegistry.toConfigMap();
  }
}

export function createCredentialProxy(options: CredentialProxyOptions): CredentialProxy {
  return new CredentialProxy(options);
}

export type { ServiceDefinition };
