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
import { parseRequestTarget, policyPathInterpretations, policyMethods, policyPathOverrides } from './request-target.js';
import { clampPromptTimeout, type CredentialPrompter, type PromptResult } from './credential-prompt.js';
import { handleServiceConsent, SERVICE_CONSENT_PATH, type PromptLimiter } from './service-consent.js';
import type { BrokerScope } from './broker-scope.js';
import { routableKeys, routeKeyMismatch, basicTokenCandidates, basicValueCarries } from './route-auth.js';
import type { CredentialLinker } from './core/credentials/linked-store.js';
import { linkRequestPlan, linkUnreadableReply } from './link-request.js';

// Service name validation: lowercase alphanum, dots, hyphens, underscores
const SAFE_SERVICE_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * A url-path service carries its credential in a path segment instead of a
 * header (Telegram: `/bot<TOKEN>/sendMessage`). A client pointed at us sends
 * that segment filled with whatever it has — a placeholder, or on the loopback
 * listener the aquaman token, because the segment is the only auth slot the
 * shape has.
 */
export interface UrlPathCredentialSlot {
  /** Index of the credential segment within the service-relative path. */
  index: number;
  /** What the client put there. Never forwarded upstream. */
  presented: string;
}

/**
 * Only the first two segments are considered. Telegram builds exactly
 * `/bot<TOKEN>/<method>` and `/file/bot<TOKEN>/<file_path>`, so a deeper scan
 * would only add ways for a method or file name to be mistaken for the slot.
 */
const URL_PATH_SLOT_SCAN_DEPTH = 2;

/**
 * Locate the credential segment in a service-relative path.
 *
 * Returns null when the client sent no such segment, which is the shape the
 * plugin's fetch interceptor produces (`/telegram/sendMessage`). Callers then
 * insert the credential at index 0, the pre-v0.15.0 behaviour.
 */
export function findUrlPathCredentialSlot(
  segments: string[],
  authPathTemplate: string
): UrlPathCredentialSlot | null {
  const templateSegments = authPathTemplate.split('/').filter(s => s);
  if (templateSegments.length !== 1) return null;
  const [prefix, suffix] = templateSegments[0].split('{token}');
  if (suffix === undefined) return null;

  const depth = Math.min(segments.length, URL_PATH_SLOT_SCAN_DEPTH);
  for (let index = 0; index < depth; index++) {
    const segment = segments[index];
    if (segment.length <= prefix.length + suffix.length) continue;
    if (!segment.startsWith(prefix) || !segment.endsWith(suffix)) continue;
    return {
      index,
      presented: segment.slice(prefix.length, segment.length - suffix.length)
    };
  }
  return null;
}

/**
 * Constant-time string comparison that doesn't leak length via an early
 * return. timingSafeEqual requires equal-length buffers, so unequal lengths
 * are compared against self (to burn comparable time) and then rejected.
 */
/** The Host header names this machine's loopback interface (any port). */
function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return true; // HTTP/1.0 clients; a browser always sends one
  // The whole header is matched: a name, then at most a port. Anything after
  // the closing bracket of an IPv6 literal other than a port is not this host.
  const m = /^(\[[^\]]*\]|[^:]*)(?::\d{1,5})?$/.exec(host);
  if (!m) return false;
  const name = m[1].toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

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
  /**
   * Called once per request with what happened; the CLI writes the audit
   * entry here. If it throws or rejects, the entry was not written: a broker
   * resolve then refuses to return the value, and a forwarded request's
   * response is withheld from the client.
   */
  onRequest?: (info: RequestInfo) => unknown;
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
  /**
   * Credential broker (`POST /broker/resolve`) scope. When omitted the broker
   * is OFF: the endpoint refuses every request without touching the vault.
   * Only `aquaman daemon` passes a scope; OpenClaw-hosted proxies never do.
   * See broker-scope.ts for the rules.
   */
  broker?: BrokerScope;
  /**
   * `POST /broker/request`: an agent asks for a credential by reference and
   * the human supplies or approves it in a dialog the daemon shows. Needs
   * `broker` as well; without both the endpoint is off. Unix socket only.
   */
  credentialRequests?: {
    prompter: CredentialPrompter;
    /** Persist the ref as declared, so the broker scope serves it from now on. */
    declare(service: string, key: string): void | Promise<void>;
    /**
     * Makes links to items that already exist in the vault (`from` in the
     * request). Without it a request that names an item is refused.
     */
    links?: CredentialLinker;
  };
}

const AUDIT_UNAVAILABLE_FIX = 'Check that the audit directory (~/.aquaman/audit by default) is writable and the disk is not full. Run: aquaman doctor';
const AUDIT_UNAVAILABLE_FORWARD = {
  error: 'The audit log could not be written, so the response was withheld',
  fix: AUDIT_UNAVAILABLE_FIX,
  code: 'audit_unavailable',
};

/** A ref the human declined is not asked about again for this long. */
const REQUEST_DECLINE_COOLDOWN_MS = 10 * 60 * 1000;
const REQUEST_NAME_MAX = 64;
/** At most this many dialogs per window, so a looping caller cannot bury the human in prompts. */
const REQUEST_WINDOW_MS = 10 * 60 * 1000;
const REQUEST_MAX_PROMPTS_PER_WINDOW = 6;

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
  /**
   * What a program routed through the proxy presents in place of its key.
   * Separate from the loopback token that agent hosts hold: this one is
   * accepted only for forwarding to a service a project has routed, never by
   * a broker endpoint. Made per daemon start and kept in memory only.
   */
  private readonly routeToken = `aqm_rt_${crypto.randomBytes(24).toString('hex')}`;
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
    return this.presentedTokens(req).some(c => timingSafeStrEqual(c, expected));
  }

  /**
   * Whether the request presents the route token, for a service a project has
   * routed. A client sends its "key" in whatever header the vendor uses, so
   * the service's own auth header is read as well.
   */
  private isRouteTokenValid(req: IncomingMessage): boolean {
    if (!this.options.loopback) return false;
    const target = parseRequestTarget(req.url || '/');
    const service = target.ok ? target.segments[0] : undefined;
    if (!service || !SAFE_SERVICE_NAME.test(service) || !this.isServiceRouted(service)) return false;
    const def = this.serviceRegistry.get(service)!;
    const candidates = this.presentedTokens(req);
    const own = req.headers[def.authHeader.toLowerCase()];
    const ownValue = Array.isArray(own) ? own[0] : own;
    if (ownValue) {
      candidates.push(def.authPrefix && ownValue.startsWith(def.authPrefix) ? ownValue.slice(def.authPrefix.length) : ownValue);
    }
    // A basic client builds the header itself, so the token is one half of the pair.
    if (def.authMode === 'basic') candidates.push(...basicTokenCandidates(req.headers.authorization));
    return candidates.some(c => timingSafeStrEqual(c, this.routeToken));
  }

  /** Every place a client may have put a local token. */
  private presentedTokens(req: IncomingMessage): string[] {
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
      // GitHub clients send `token <value>` as well as `Bearer <value>`.
      candidates.push(authz.replace(/^(?:Bearer|token)\s+/i, ''));
    }

    const pathBorne = this.urlPathTokenCandidate(req.url || '/');
    if (pathBorne) candidates.push(pathBorne);

    return candidates;
  }

  /** True for a header value that is, or wraps, one of this proxy's own tokens. Those never go upstream. */
  private carriesLocalToken(value: string): boolean {
    const lb = this.options.loopback?.token;
    const tokens = lb ? [this.routeToken, lb] : [this.routeToken];
    return tokens.some((t) => value.includes(t)) || basicValueCarries(value, tokens);
  }

  /**
   * A url-path service sends no auth header at all, so the loopback token can
   * only arrive in the credential segment. OpenClaw's Telegram channel, for
   * instance, is pointed at us with `channels.telegram.apiRoot` and a
   * placeholder bot token; the placeholder it sends is the loopback token.
   */
  private urlPathTokenCandidate(url: string): string | undefined {
    const target = parseRequestTarget(url);
    if (!target.ok) return undefined;
    const segments = target.segments;
    const service = segments[0];
    if (!service || !SAFE_SERVICE_NAME.test(service)) return undefined;
    if (!this.isServiceProxied(service)) return undefined;

    const serviceDef = this.serviceRegistry.get(service);
    if (!serviceDef || serviceDef.authMode !== 'url-path' || !serviceDef.authPathTemplate) {
      return undefined;
    }
    return findUrlPathCredentialSlot(segments.slice(1), serviceDef.authPathTemplate)?.presented;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse, fromLoopback = false): Promise<void> {
    const requestId = generateId();
    const url = req.url || '/';

    // Loopback listener is network-reachable (unlike the 0o600 UDS), so every
    // request on it must present the loopback token. Health check is exempt so
    // local tooling can probe liveness without the token.
    // A browser page can be made to send requests here under a name it
    // controls (DNS rebinding). Nothing legitimate addresses this listener by
    // any name other than the loopback ones.
    if (fromLoopback && !isLoopbackHostHeader(req.headers.host)) {
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 403;
      res.end(JSON.stringify({ error: 'Loopback request rejected: unexpected Host header', fix: 'Address the proxy as 127.0.0.1 or localhost' }));
      return;
    }
    // A routed program's token is good for forwarding to routed services and
    // for nothing else; `viaRouteToken` narrows everything below.
    let viaRouteToken = false;
    if (fromLoopback && url !== '/_health' && url !== '/_health/' && !this.isLoopbackTokenValid(req)) {
      viaRouteToken = this.isRouteTokenValid(req);
    }
    if (fromLoopback && url !== '/_health' && url !== '/_health/' && !viaRouteToken && !this.isLoopbackTokenValid(req)) {
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 401;
      res.end(JSON.stringify({
        error: 'Loopback request rejected: missing or invalid aquaman loopback token',
        fix: 'The host must present the loopback token as its placeholder credential. Hermes: aquaman hermes status. OpenClaw: aquaman openclaw status'
      }));
      return;
    }

    // Health check endpoint
    if (url === '/_health' || url === '/_health/') {
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 200;
      res.end(JSON.stringify({
        status: 'ok',
        version: DAEMON_VERSION,
        uptime: process.uptime(),
        services: this.options.allowedServices,
        // Only over the socket: lets `aquaman init` confirm the pid file names this process before signalling it.
        ...(fromLoopback ? {} : { pid: process.pid }),
      }));
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

    // Broker endpoint: resolves a vault-stored credential and returns its
    // VALUE, with a short-lived expiry hint. Used by aquaman-coder (v0.12.0+)
    // and the Hermes secret source (v0.14.0+) to materialize declared refs.
    // The expires_at field is a hint for the consumer, not a server-side
    // expiration. Scoped since v0.15.0: off unless the proxy was built with a
    // BrokerScope, and limited to declared refs when on (broker-scope.ts).
    if (viaRouteToken && (url.startsWith('/broker/') || url.startsWith('/_'))) {
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'This token only forwards requests to routed services', code: 'route_token_forward_only' }));
      return;
    }

    if ((url === '/broker/resolve' || url === '/broker/resolve/') && req.method === 'POST') {
      await this.handleBrokerResolve(req, res, requestId, fromLoopback);
      return;
    }

    if ((url === '/broker/route' || url === '/broker/route/') && req.method === 'POST') {
      await this.handleBrokerRoute(req, res, fromLoopback);
      return;
    }

    if ((url === '/broker/available' || url === '/broker/available/') && req.method === 'POST') {
      await this.handleBrokerAvailable(req, res, fromLoopback);
      return;
    }

    if ((url === '/broker/request' || url === '/broker/request/') && req.method === 'POST') {
      await this.handleBrokerRequest(req, res, requestId, fromLoopback);
      return;
    }

    if ((url === SERVICE_CONSENT_PATH || url === `${SERVICE_CONSENT_PATH}/`) && req.method === 'POST') {
      await handleServiceConsent(req, res, {
        fromLoopback,
        // Off wherever credential requests are off: the same dialog machinery.
        prompter: this.options.broker ? this.options.credentialRequests?.prompter : undefined,
        limiter: this.promptLimiter,
        audit: (error) => this.emitRequest({
          id: requestId, service: 'aquaman-service', method: 'SERVICE_CONSENT', path: SERVICE_CONSENT_PATH,
          timestamp: new Date(), authenticated: false, statusCode: 200, error,
        }),
      });
      return;
    }

    // One strict reading of the request target, used for the service name,
    // the policy check AND the upstream path. Anything a server could read
    // two ways (backslashes, dot segments, encoded separators) is refused
    // here; request-target.ts explains each case.
    const target = parseRequestTarget(url);
    if (!target.ok) {
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 400;
      res.end(JSON.stringify({
        error: `Request rejected: ${target.reason}`,
        fix: 'Send a plain path: no backslashes, no "." or ".." segments, no encoded separators'
      }));
      return;
    }

    // Parse service from path: /anthropic/v1/messages -> anthropic
    const pathParts = target.segments;
    const service = pathParts[0];

    // Validate service name to prevent path traversal / injection
    if (service && !SAFE_SERVICE_NAME.test(service)) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }

    if (!service || !(viaRouteToken ? this.isServiceRouted(service) : this.isServiceProxied(service))) {
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

    // Split the credential segment out of a url-path request before anything
    // else reads the path, so policy rules match the method (`/sendMessage`,
    // not `/bot<TOKEN>/sendMessage`) and nothing observable records the token
    // the client presented.
    const serviceSegments = pathParts.slice(1);
    const credentialSlot = authMode === 'url-path' && serviceDef.authPathTemplate
      ? findUrlPathCredentialSlot(serviceSegments, serviceDef.authPathTemplate)
      : null;
    const canonicalSegments = credentialSlot
      ? serviceSegments.filter((_, i) => i !== credentialSlot.index)
      : serviceSegments;
    const remainingPath = '/' + canonicalSegments.join('/');

    const requestInfo: RequestInfo = {
      id: requestId,
      service,
      method: req.method || 'GET',
      path: credentialSlot ? `/${service}${remainingPath}` : url,
      timestamp: new Date(),
      authenticated: false
    };

    // Policy check — before credential retrieval. The request must be allowed
    // under every reading an upstream might apply: each path interpretation
    // (encoded slashes, `;params`, a path named by `X-Original-URL` or
    // `X-Rewrite-URL`) and each method a method-override header or `_method`
    // query parameter names. One denied combination denies the request.
    if (this.options.policyConfig) {
      const policyConfig = this.options.policyConfig;
      // A path-override header the parser refuses cannot be evaluated, so a
      // service that has rules does not get the request.
      const overrides = policyPathOverrides(req.headers);
      const paths = [...policyPathInterpretations(canonicalSegments), ...(overrides.ok ? overrides.paths : [])];
      const denied = (!overrides.ok && policyConfig[service] !== undefined) ||
        policyMethods(req.method || 'GET', req.headers, target.search).some((method) =>
          paths.some((p) => !matchPolicy(service, method, p, policyConfig).allowed));
      if (denied) {
        requestInfo.error = `Policy denied: ${req.method || 'GET'} ${remainingPath}`;
        requestInfo.statusCode = 403;
        this.emitRequest(requestInfo);
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 403;
        res.end(JSON.stringify({
          error: `Request denied by policy: ${req.method || 'GET'} ${requestInfo.path}`,
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
        // Put the real token back in the position the client used it: index 0
        // for `/bot<TOKEN>/sendMessage`, index 1 for the file-download shape
        // `/file/bot<TOKEN>/<file_path>`. A client that sent no segment at all
        // gets the credential prefixed, as before.
        // A credential that contains a slash would silently become extra path
        // segments and send the request somewhere the service definition never
        // named. No url-path token has one; refuse rather than guess.
        if (credential.includes('/')) {
          requestInfo.error = 'Invalid credential: url-path token contains a slash';
          requestInfo.statusCode = 500;
          this.emitRequest(requestInfo);
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 500;
          res.end(JSON.stringify({
            error: `Stored credential ${service}/${config.credentialKey} is not a valid ${service} token`,
            fix: `Re-add it: aquaman credentials add ${service} ${config.credentialKey}`
          }));
          return;
        }
        const template = serviceDef.authPathTemplate;
        const injected = (template.startsWith('/') ? template.slice(1) : template)
          .replace('{token}', credential);
        const segments = [...canonicalSegments];
        segments.splice(credentialSlot?.index ?? 0, 0, injected);
        upstreamPath = '/' + segments.join('/');
      } else {
        upstreamPath = remainingPath;
      }

      // Host and scheme come from the service definition and nothing else.
      // Never resolve a client-supplied path against the upstream with
      // `new URL(path, base)`: a path that parses as scheme-relative
      // (`//host`, or `/\host`) replaces the host, and the credential follows.
      const upstreamBase = new URL(config.upstream);
      const upstreamUrl = new URL(upstreamBase.origin);
      upstreamUrl.pathname = upstreamPath;
      upstreamUrl.search = target.search;
      if (upstreamUrl.origin !== upstreamBase.origin || upstreamUrl.username || upstreamUrl.password) {
        requestInfo.error = 'Upstream origin mismatch';
        requestInfo.statusCode = 400;
        this.emitRequest(requestInfo);
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'Request rejected: path does not resolve to the service upstream', fix: 'Send a plain path' }));
        return;
      }

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
        // Nor in any other header a client may have put it in.
        if ((Array.isArray(value) ? value : [value ?? '']).some((v) => this.carriesLocalToken(v))) continue;
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
        // The upstream has answered, so the credential was used. The client
        // gets that answer only once the use is on record.
        void this.recordRequest(requestInfo).then((recorded) => {
          if (!recorded) {
            proxyRes.resume();
            if (!clientRes.headersSent) {
              clientRes.setHeader('Content-Type', 'application/json');
              clientRes.statusCode = 500;
              clientRes.end(JSON.stringify(AUDIT_UNAVAILABLE_FORWARD));
            }
            resolve();
            return;
          }

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

      // Add timeout to prevent indefinite hangs. Long-polling services declare
      // a floor so a shorter global setting can't cut their polls short.
      const timeout = Math.max(this.options.requestTimeout ?? 30000, serviceDef.minRequestTimeout ?? 0);
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

  /**
   * Hand one request to `onRequest` (the audit log) and say whether that
   * worked. Never throws and never rejects: a log that cannot be written is
   * reported on stderr and to the caller, and the daemon keeps running.
   */
  private async recordRequest(info: RequestInfo): Promise<boolean> {
    if (!this.options.onRequest) return true;
    try {
      await this.options.onRequest(info);
      return true;
    } catch (err) {
      console.error(
        `AUDIT FAILURE: could not record ${info.method} ${info.service} (${info.path}): ${err instanceof Error ? err.message : String(err)}. ` +
        'Credential values are not handed out until the audit log can be written.',
      );
      return false;
    }
  }

  /** Record a request whose outcome hands nothing out (a refusal, an error). */
  private emitRequest(info: RequestInfo): void {
    void this.recordRequest(info);
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
  private requestPromptOpen = false;
  private requestPromptTimes: number[] = [];
  private requestDeclinedAt = new Map<string, number>();
  /** The dialog limits above, for the other endpoint that shows a dialog: one budget for both. */
  private readonly promptLimiter: PromptLimiter = {
    cooldownMs: REQUEST_DECLINE_COOLDOWN_MS,
    windowMs: REQUEST_WINDOW_MS,
    maxPerWindow: REQUEST_MAX_PROMPTS_PER_WINDOW,
    isOpen: () => this.requestPromptOpen,
    setOpen: (open) => { this.requestPromptOpen = open; },
    times: () => this.requestPromptTimes,
    setTimes: (times) => { this.requestPromptTimes = times; },
    declinedAt: this.requestDeclinedAt,
  };

  /**
   * POST /broker/request  { service, key, project? }
   *
   * Makes a credential available by reference without the caller ever
   * holding it. Never returns a value and never replaces a stored one.
   *
   *   200 { status: "ready" }     already stored and declared; nothing asked
   *   200 { status: "stored" }    the human typed it; now stored and declared
   *   200 { status: "approved" }  already stored; the human allowed its use
   *   200 { status: "linked" }    `from` named a vault item; the human allowed it and it resolved
   *   200 { status: "declined" }  the human said no (or did so recently)
   *   200 { status: "pending" }   nobody could be asked; `fix` says what to run
   *   404 { code }                broker off here, or not the Unix socket
   */
  /**
   * `POST /broker/available`: for each reference, whether `/broker/resolve`
   * would return a value right now. Never returns one. The scope is checked
   * before the vault, as in resolve, so an undeclared reference answers
   * `false` whatever the vault holds.
   */
  /** Whether requests for this service are forwarded for agent hosts and socket clients: the configured list. */
  private isServiceProxied(service: string): boolean {
    return this.options.allowedServices.includes(service);
  }

  /**
   * Whether a project has routed a program to this service in a way the
   * proxy can serve: the service takes its credential in a header or as
   * HTTP basic auth, and the routed reference is a key the proxy injects for
   * it (route-auth.ts).
   */
  private isServiceRouted(service: string): boolean {
    const def = this.serviceRegistry.get(service);
    if (!def) return false;
    const routed = this.options.broker?.routedRefs?.();
    return routableKeys(def).some((key) => routed?.has(`aquaman://${service}/${key}`) === true);
  }

  /**
   * `POST /broker/route`: where a program should send its requests for one
   * service so that the proxy, not the program, holds the credential. Returns
   * the loopback listener's URL for the service and the listener's token.
   *
   * The token is the capability to reach the local proxy, not a credential:
   * it works only on this machine, the proxy strips it, and request policy
   * applies to everything sent with it. So this endpoint never touches a
   * credential value, and the token it returns is refused by every broker
   * endpoint. It answers only over the Unix socket, only for a reference a
   * project has routed, only for a service the proxy injects a header or
   * basic auth for, only when the reference names a key the proxy would
   * inject, and only when every key of that injection is stored.
   */
  private async handleBrokerRoute(req: IncomingMessage, res: ServerResponse, fromLoopback: boolean): Promise<void> {
    res.setHeader('Content-Type', 'application/json');
    const reply = (statusCode: number, body: Record<string, unknown>) => {
      res.statusCode = statusCode;
      res.end(JSON.stringify(body));
    };
    let bodyBuf = '';
    for await (const chunk of req) {
      bodyBuf += (chunk as Buffer).toString('utf-8');
      if (bodyBuf.length > 4096) {
        reply(400, { error: 'Request body too large', fix: 'POST { service, key }' });
        return;
      }
    }
    let body: { service?: unknown; key?: unknown } | null;
    try {
      body = JSON.parse(bodyBuf);
    } catch {
      body = null;
    }
    const service = body && typeof body === 'object' ? body.service : undefined;
    const key = body && typeof body === 'object' ? body.key : undefined;
    if (
      typeof service !== 'string' || !SAFE_SERVICE_NAME.test(service) ||
      typeof key !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(key)
    ) {
      reply(400, { error: 'Expected { service, key }', fix: 'POST a JSON body naming one reference' });
      return;
    }
    const refuse = (code: string, error: string, fix: string) => {
      reply(404, { error, fix, code });
      this.emitRequest({
        id: crypto.randomUUID(),
        service,
        method: 'BROKER',
        path: '/broker/route',
        timestamp: new Date(),
        authenticated: false,
        statusCode: 404,
        error: `${code}: ${service}/${key}`,
      });
    };
    if (fromLoopback) {
      refuse('route_socket_only', 'Routes are handed out over the Unix socket only', 'Ask over the proxy socket');
      return;
    }
    const scope = this.options.broker;
    if (!scope) {
      refuse('broker_disabled', 'The credential broker is disabled on this proxy', 'OpenClaw-hosted proxies do not hand out routes. Run: aquaman daemon');
      return;
    }
    // Scope before anything else, as in resolve: an answer about a reference
    // nobody routed must not depend on what the vault or the registry holds.
    if (!scope.routedRefs?.().has(`aquaman://${service}/${key}`)) {
      refuse('route_not_recorded', `No project routes a program to aquaman://${service}/${key}`, `Bind it with: aquaman coder bind <NAME>=aquaman://${service}/${key} --via-proxy <URL_ENV>`);
      return;
    }
    const address = this.getLoopbackAddress();
    if (!address) {
      refuse('route_listener_off', 'The loopback listener is not running, so there is nowhere to send requests', 'Run: aquaman init --agent <agent> --loopback');
      return;
    }
    const serviceDef = this.serviceRegistry.get(service);
    if (!serviceDef) {
      refuse('route_service_unknown', `The proxy has no definition for "${service}", so it cannot forward requests for it`, `Add "${service}" to services.yaml (see docs/app-through-proxy.md), or bind the reference without --via-proxy`);
      return;
    }
    const keys = routableKeys(serviceDef);
    if (keys.length === 0) {
      refuse('route_unsupported', `"${service}" does not take its credential in a request header or as HTTP basic auth, so a program cannot be routed to it this way`, 'Bind the reference without --via-proxy');
      return;
    }
    if (!keys.includes(key)) {
      const mismatch = routeKeyMismatch(service, keys, key);
      refuse('route_key_mismatch', mismatch.error, mismatch.fix);
      return;
    }
    // Every key the proxy injects for the service, the routed one first: a
    // basic request sent with half a pair would only fail at the upstream.
    for (const needed of [key, ...keys.filter((k) => k !== key)]) {
      let stored = false;
      try {
        stored = (await this.options.store.get(service, needed)) !== null;
      } catch {
        stored = false;
      }
      if (!stored) {
        refuse('credential_not_found', `Credential not found: ${service}/${needed}`, `Run: aquaman credentials add ${service} ${needed}`);
        return;
      }
    }
    reply(200, { url: `http://${address}/${service}`, token: this.routeToken });
    this.emitRequest({
      id: crypto.randomUUID(),
      service,
      method: 'BROKER_ROUTE',
      path: '/broker/route',
      timestamp: new Date(),
      authenticated: true,
      statusCode: 200,
    });
  }

  private async handleBrokerAvailable(req: IncomingMessage, res: ServerResponse, fromLoopback: boolean): Promise<void> {
    res.setHeader('Content-Type', 'application/json');
    const reply = (statusCode: number, body: Record<string, unknown>) => {
      res.statusCode = statusCode;
      res.end(JSON.stringify(body));
    };
    let bodyBuf = '';
    for await (const chunk of req) {
      bodyBuf += (chunk as Buffer).toString('utf-8');
      if (bodyBuf.length > 16384) {
        reply(400, { error: 'Request body too large', fix: 'Ask about at most 64 references' });
        return;
      }
    }
    let refs: unknown;
    try {
      refs = (JSON.parse(bodyBuf) as { refs?: unknown } | null)?.refs;
    } catch {
      refs = undefined;
    }
    if (!Array.isArray(refs) || refs.length > 64) {
      reply(400, { error: 'Expected { refs: [{ service, key }] } with at most 64 entries', fix: 'POST a JSON body with a refs array' });
      return;
    }
    const scope = this.options.broker;
    if (!scope) {
      reply(404, {
        error: 'The credential broker is disabled on this proxy',
        fix: 'OpenClaw-hosted proxies never hand out credential values. Run: aquaman daemon',
        code: 'broker_disabled',
      });
      return;
    }
    const available: boolean[] = [];
    for (const ref of refs as Array<{ service?: unknown; key?: unknown } | null>) {
      const service = ref?.service;
      const key = ref?.key;
      let ok = false;
      if (
        typeof service === 'string' && SAFE_SERVICE_NAME.test(service) &&
        typeof key === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(key) &&
        (scope.check(service, key, fromLoopback ? 'loopback' : 'uds').allowed ||
          // A routed reference is usable by its project without being resolvable.
          (!fromLoopback && scope.routedRefs?.().has(`aquaman://${service}/${key}`) === true))
      ) {
        try {
          ok = (await this.options.store.get(service, key)) !== null;
        } catch {
          ok = false;
        }
      }
      available.push(ok);
    }
    reply(200, { available });
  }

  private async handleBrokerRequest(
    req: IncomingMessage,
    res: ServerResponse,
    requestId: string,
    fromLoopback: boolean
  ): Promise<void> {
    res.setHeader('Content-Type', 'application/json');
    const reply = (statusCode: number, body: Record<string, unknown>) => {
      res.statusCode = statusCode;
      res.end(JSON.stringify(body));
    };

    let bodyBuf = '';
    for await (const chunk of req) {
      bodyBuf += (chunk as Buffer).toString('utf-8');
      if (bodyBuf.length > 4096) {
        reply(400, { error: 'Request body too large', fix: 'Keep broker requests under 4 KB' });
        return;
      }
    }
    let body: { service?: unknown; key?: unknown; project?: unknown; timeout_seconds?: unknown; routed?: unknown; from?: unknown };
    try {
      body = JSON.parse(bodyBuf);
    } catch {
      reply(400, { error: 'Request body is not valid JSON', fix: 'POST a JSON body with { service, key }' });
      return;
    }
    if (body === null || typeof body !== 'object') {
      reply(400, { error: 'Request body is not a JSON object', fix: 'POST a JSON body with { service, key }' });
      return;
    }
    const { service, key } = body;
    // Both names are shown to a person in the dialog, so they stay short
    // enough to read in full.
    if ((typeof service === 'string' && service.length > REQUEST_NAME_MAX) || (typeof key === 'string' && key.length > REQUEST_NAME_MAX)) {
      reply(400, { error: `Service and key names are limited to ${REQUEST_NAME_MAX} characters here`, fix: 'Use a shorter reference' });
      return;
    }
    if (typeof service !== 'string' || !SAFE_SERVICE_NAME.test(service)) {
      reply(400, { error: `Invalid service name: ${JSON.stringify(service)}`, fix: 'Service names must match /^[a-z0-9][a-z0-9._-]*$/' });
      return;
    }
    if (typeof key !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(key)) {
      reply(400, { error: `Invalid key name: ${JSON.stringify(key)}`, fix: 'Key names must match /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/' });
      return;
    }
    const project = typeof body.project === 'string' ? body.project : undefined;
    const timeoutSeconds = clampPromptTimeout(body.timeout_seconds);
    const ref = `aquaman://${service}/${key}`;
    // Asked for on behalf of a binding made through the proxy: the value is
    // stored, and the reference is not declared for handing out.
    const routed = body.routed === true;
    let manual = routed
      ? `aquaman credentials add ${service} ${key}`
      : `aquaman credentials add ${service} ${key} && aquaman broker allow ${ref}`;

    const audit = (error?: string) => this.emitRequest({
      id: requestId,
      service,
      method: 'BROKER_REQUEST',
      path: '/broker/request',
      timestamp: new Date(),
      authenticated: false,
      statusCode: 200,
      error,
    });

    const scope = this.options.broker;
    const requests = this.options.credentialRequests;
    if (!scope || !requests) {
      reply(404, {
        error: 'Credential requests are disabled on this proxy',
        fix: 'OpenClaw-hosted proxies never take credential requests. Run: aquaman daemon',
        code: 'broker_disabled',
      });
      return;
    }
    if (fromLoopback) {
      reply(404, {
        error: 'Credential requests are only accepted on the Unix socket',
        fix: `Run on the machine itself: aquaman request ${ref}`,
        code: 'broker_request_local_only',
      });
      return;
    }

    // `from` asks for a link to an item that already exists in the vault.
    // Until the person has agreed, only the locator's syntax and the link map
    // are looked at: reading or probing the item here would let a request
    // find out which items exist.
    const link = linkRequestPlan(requests.links, service, key, body.from, routed);
    if (link && !link.ok) {
      reply(link.status, { error: link.error, fix: link.fix, code: link.code });
      return;
    }
    const linkFrom = link?.pending ? link.locator : undefined;
    if (link?.pending) manual = link.manual;

    let exists: boolean;
    try {
      exists = linkFrom === undefined && await this.options.store.exists(service, key);
    } catch (err) {
      reply(500, {
        error: `Vault backend error checking ${service}/${key}: ${err instanceof Error ? err.message : String(err)}`,
        fix: 'Check that the configured backend is accessible. Run: aquaman doctor',
      });
      return;
    }
    const declared = routed
      ? scope.routedRefs?.().has(ref) === true
      : scope.check(service, key, 'uds').allowed;
    if (exists && declared) {
      reply(200, { status: 'ready', ref });
      return;
    }
    // A linked reference whose item cannot be read is not asked for as a new
    // value: a typed value is never written over a link.
    if (!exists && linkFrom === undefined && requests.links?.linkOf(service, key) !== undefined) {
      reply(404, linkUnreadableReply(service, key));
      return;
    }

    const now = Date.now();
    const declinedAt = this.requestDeclinedAt.get(ref);
    if (declinedAt !== undefined && now - declinedAt < REQUEST_DECLINE_COOLDOWN_MS) {
      audit(`declined: ${service}/${key}`);
      reply(200, { status: 'declined', ref, reason: 'declined a few minutes ago; not asking again yet' });
      return;
    }
    this.requestPromptTimes = this.requestPromptTimes.filter((t) => now - t < REQUEST_WINDOW_MS);
    if (this.requestPromptOpen || this.requestPromptTimes.length >= REQUEST_MAX_PROMPTS_PER_WINDOW) {
      audit(`pending: ${service}/${key}`);
      reply(200, {
        status: 'pending',
        ref,
        reason: this.requestPromptOpen ? 'another credential request is waiting for an answer' : 'too many credential requests in a short time',
        fix: manual,
      });
      return;
    }

    this.requestPromptOpen = true;
    this.requestPromptTimes.push(now);
    let result: PromptResult;
    try {
      // `routed` picks the dialog's wording: what the person is told has to
      // match what a caller can obtain once they agree.
      result = linkFrom !== undefined
        ? await requests.prompter.askApproval({ service, key, project, timeoutSeconds, routed, from: linkFrom })
        : exists
          ? await requests.prompter.askApproval({ service, key, project, timeoutSeconds, routed })
          : await requests.prompter.askValue({ service, key, project, timeoutSeconds, routed });
    } catch (err) {
      result = { outcome: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
    } finally {
      this.requestPromptOpen = false;
    }

    if (result.outcome === 'declined') {
      this.requestDeclinedAt.set(ref, Date.now());
      // No `fix` here: a command that completes what the person just refused
      // is not something to hand back to the caller.
      audit(`declined: ${service}/${key}`);
      reply(200, { status: 'declined', ref, reason: 'the person at the dialog said no' });
      return;
    }
    if (result.outcome === 'timeout' || result.outcome === 'unavailable') {
      audit(`pending: ${service}/${key}`);
      reply(200, {
        status: 'pending',
        ref,
        reason: result.outcome === 'timeout' ? 'nobody answered the dialog' : result.reason,
        fix: manual,
      });
      return;
    }

    try {
      if (linkFrom !== undefined) {
        // The person agreed, so the item is read here for the first time. A
        // link is written only if it resolves and nothing is stored under the
        // reference; this refusal may say the item is missing.
        const made = await requests.links!.establish(service, key, linkFrom);
        if (!made.ok) {
          audit(`${made.code}: ${service}/${key}`);
          reply(404, { error: made.error, fix: made.fix, code: made.code });
          return;
        }
      }
      // Checked again: the dialog was open for a while, and a stored value is never replaced.
      if (result.outcome === 'entered' && !(await this.options.store.exists(service, key))) {
        await this.options.store.set(service, key, result.value);
      }
      if (!declared && !routed) await requests.declare(service, key);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      audit(message);
      reply(500, { error: `Could not store ${service}/${key}: ${message}`, fix: 'Run: aquaman doctor' });
      return;
    }
    audit();
    reply(200, { status: linkFrom !== undefined ? 'linked' : result.outcome === 'entered' ? 'stored' : 'approved', ref });
  }

  private async handleBrokerResolve(
    req: IncomingMessage,
    res: ServerResponse,
    requestId: string,
    fromLoopback: boolean
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

    if (body === null || typeof body !== 'object') {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Broker request body is not a JSON object', fix: 'POST a JSON body with { service, key, ttl_seconds }' }));
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

    // Scope check BEFORE the vault lookup: a refusal must not depend on (or
    // reveal) what the vault holds. 404 rather than 403 so that clients which
    // treat 401/403 as "bad token" (the Hermes source aborts all refs on
    // those) handle a refusal per ref, like a missing credential.
    const scope = this.options.broker;
    const decision = scope
      ? scope.check(service, key, fromLoopback ? 'loopback' : 'uds')
      : {
          allowed: false as const,
          code: 'broker_disabled' as const,
          reason: 'The credential broker is disabled on this proxy',
          fix: 'OpenClaw-hosted proxies never hand out credential values. For coding agents or the Hermes secret source, run: aquaman daemon',
        };
    if (!decision.allowed) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: decision.reason, fix: decision.fix, code: decision.code }));
      this.emitRequest({
        id: requestId,
        service,
        method: 'BROKER',
        path: '/broker/resolve',
        timestamp: new Date(),
        authenticated: false,
        statusCode: 404,
        error: `${decision.code}: ${service}/${key}`,
      });
      return;
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
        fix: `Run: aquaman credentials add ${service} ${key}`,
        code: 'credential_not_found'
      }));
      this.emitRequest({
        id: requestId,
        service,
        method: 'BROKER',
        path: `/broker/resolve`,
        timestamp: new Date(),
        authenticated: false,
        statusCode: 404,
        // Without an error the audit logger records this as a successful use.
        error: `credential_not_found: ${service}/${key}`,
      });
      return;
    }

    // The audit entry comes first (service and outcome, never the value): a
    // value leaves this process only once its read is on record.
    const recorded = await this.recordRequest({
      id: requestId,
      service,
      method: 'BROKER',
      path: `/broker/resolve`,
      timestamp: new Date(),
      authenticated: true,
      statusCode: 200,
    });
    if (!recorded) {
      res.statusCode = 500;
      res.end(JSON.stringify({
        error: `The audit log could not be written, so ${service}/${key} was not handed out`,
        fix: AUDIT_UNAVAILABLE_FIX,
        code: 'audit_unavailable',
      }));
      return;
    }

    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    res.statusCode = 200;
    res.end(JSON.stringify({ value, expires_at: expiresAt }));
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
