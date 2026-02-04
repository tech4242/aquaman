/**
 * Credential proxy daemon - holds secrets and proxies authenticated API calls
 * OpenClaw connects to this proxy instead of directly to external APIs
 */

import * as http from 'node:http';
import * as https from 'node:https';
import * as fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type CredentialStore, generateId } from '@aquaman/core';
import { ServiceRegistry, createServiceRegistry, type ServiceDefinition } from './service-registry.js';

export interface TlsOptions {
  enabled: boolean;
  certPath?: string;
  keyPath?: string;
}

export interface CredentialProxyOptions {
  port: number;
  bindAddress?: string; // defaults to '0.0.0.0' for container access
  store: CredentialStore;
  allowedServices: string[];
  onRequest?: (info: RequestInfo) => void;
  tls?: TlsOptions;
  serviceRegistry?: ServiceRegistry;
  requestTimeout?: number; // Upstream request timeout in ms, defaults to 30000 (30s)
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
  private server: http.Server | https.Server | null = null;
  private options: CredentialProxyOptions;
  private running = false;
  private tlsEnabled = false;
  private serviceRegistry: ServiceRegistry;
  private actualPort: number = 0;

  constructor(options: CredentialProxyOptions) {
    this.options = options;
    this.serviceRegistry = options.serviceRegistry || createServiceRegistry();
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Credential proxy already running');
    }

    const requestHandler = (req: IncomingMessage, res: ServerResponse) => {
      this.handleRequest(req, res).catch(error => {
        console.error('Proxy error:', error);
        res.statusCode = 500;
        res.end('Internal proxy error');
      });
    };

    // Determine if TLS should be used
    const tls = this.options.tls;
    if (tls?.enabled && tls.certPath && tls.keyPath) {
      if (!fs.existsSync(tls.certPath) || !fs.existsSync(tls.keyPath)) {
        console.warn('TLS cert/key not found, falling back to HTTP');
        this.server = http.createServer(requestHandler);
        this.tlsEnabled = false;
      } else {
        const tlsOptions = {
          cert: fs.readFileSync(tls.certPath, 'utf-8'),
          key: fs.readFileSync(tls.keyPath, 'utf-8')
        };
        this.server = https.createServer(tlsOptions, requestHandler);
        this.tlsEnabled = true;
      }
    } else {
      this.server = http.createServer(requestHandler);
      this.tlsEnabled = false;
    }

    const bindAddress = this.options.bindAddress || '0.0.0.0';
    const protocol = this.tlsEnabled ? 'https' : 'http';

    return new Promise((resolve, reject) => {
      this.server!.listen(this.options.port, bindAddress, () => {
        // Get actual port (important when port 0 is used for dynamic allocation)
        const address = this.server!.address();
        if (address && typeof address === 'object') {
          this.actualPort = address.port;
        } else {
          this.actualPort = this.options.port;
        }

        this.running = true;
        console.log(`Credential proxy listening on ${protocol}://${bindAddress}:${this.actualPort}`);
        resolve();
      });

      this.server!.on('error', reject);
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = generateId();
    const url = req.url || '/';

    // Parse service from path: /anthropic/v1/messages -> anthropic
    const pathParts = url.split('/').filter(p => p);
    const service = pathParts[0];

    if (!service || !this.options.allowedServices.includes(service)) {
      res.statusCode = 404;
      res.end(`Service not found or not allowed: ${service}`);
      return;
    }

    const serviceDef = this.serviceRegistry.get(service);
    if (!serviceDef) {
      res.statusCode = 404;
      res.end(`No configuration for service: ${service}`);
      return;
    }

    const config: ServiceConfig = {
      upstream: serviceDef.upstream,
      authHeader: serviceDef.authHeader,
      authPrefix: serviceDef.authPrefix,
      credentialKey: serviceDef.credentialKey
    };

    const requestInfo: RequestInfo = {
      id: requestId,
      service,
      method: req.method || 'GET',
      path: url,
      timestamp: new Date(),
      authenticated: false
    };

    try {
      // Get credential from store
      const credential = await this.options.store.get(service, config.credentialKey);

      if (!credential) {
        requestInfo.error = 'Credential not found';
        requestInfo.statusCode = 401;
        this.emitRequest(requestInfo);
        res.statusCode = 401;
        res.end(`No credential configured for ${service}`);
        return;
      }

      requestInfo.authenticated = true;

      // Build upstream URL (strip service prefix from path)
      const upstreamPath = '/' + pathParts.slice(1).join('/');
      const upstreamUrl = new URL(upstreamPath, config.upstream);

      // Forward the request
      await this.proxyRequest(req, res, upstreamUrl, config, credential, requestInfo);

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
    config: ServiceConfig,
    credential: string,
    requestInfo: RequestInfo
  ): Promise<void> {
    return new Promise((resolve) => {
      const isHttps = upstreamUrl.protocol === 'https:';
      const transport = isHttps ? https : http;

      // Copy headers, add auth, remove problematic ones
      const headers: Record<string, string> = {};

      if (clientReq.headers) {
        for (const [key, value] of Object.entries(clientReq.headers)) {
          if (key.toLowerCase() === 'host') continue;
          if (key.toLowerCase() === config.authHeader.toLowerCase()) continue;
          if (value) {
            headers[key] = Array.isArray(value) ? value[0] : value;
          }
        }
      }

      // Add authentication
      const authValue = config.authPrefix
        ? `${config.authPrefix}${credential}`
        : credential;
      headers[config.authHeader] = authValue;

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

  async stop(): Promise<void> {
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
          resolve();
        }
      });
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  isTlsEnabled(): boolean {
    return this.tlsEnabled;
  }

  getPort(): number {
    return this.actualPort;
  }

  getServiceRegistry(): ServiceRegistry {
    return this.serviceRegistry;
  }

  getServiceConfigs(): Record<string, ServiceConfig> {
    return this.serviceRegistry.toConfigMap();
  }

  getBaseUrl(service: string): string {
    const protocol = this.tlsEnabled ? 'https' : 'http';
    return `${protocol}://127.0.0.1:${this.actualPort}/${service}`;
  }

  static getBaseUrl(service: string, proxyPort: number, useTls = false): string {
    const protocol = useTls ? 'https' : 'http';
    return `${protocol}://127.0.0.1:${proxyPort}/${service}`;
  }
}

export function createCredentialProxy(options: CredentialProxyOptions): CredentialProxy {
  return new CredentialProxy(options);
}

export type { ServiceDefinition };
