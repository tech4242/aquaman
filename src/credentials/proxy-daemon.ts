/**
 * Credential proxy daemon - holds secrets and proxies authenticated API calls
 * OpenClaw connects to this proxy instead of directly to external APIs
 */

import * as http from 'node:http';
import * as https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CredentialStore } from './store.js';
import { generateId } from '../utils/hash.js';

export interface CredentialProxyOptions {
  port: number;
  bindAddress?: string; // defaults to '0.0.0.0' for container access
  store: CredentialStore;
  allowedServices: string[];
  onRequest?: (info: RequestInfo) => void;
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

const SERVICE_CONFIGS: Record<string, ServiceConfig> = {
  anthropic: {
    upstream: 'https://api.anthropic.com',
    authHeader: 'x-api-key',
    credentialKey: 'api_key'
  },
  openai: {
    upstream: 'https://api.openai.com',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    credentialKey: 'api_key'
  },
  slack: {
    upstream: 'https://slack.com/api',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    credentialKey: 'bot_token'
  },
  discord: {
    upstream: 'https://discord.com/api',
    authHeader: 'Authorization',
    authPrefix: 'Bot ',
    credentialKey: 'bot_token'
  }
};

export class CredentialProxy {
  private server: http.Server | null = null;
  private options: CredentialProxyOptions;
  private running = false;

  constructor(options: CredentialProxyOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Credential proxy already running');
    }

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch(error => {
        console.error('Proxy error:', error);
        res.statusCode = 500;
        res.end('Internal proxy error');
      });
    });

    const bindAddress = this.options.bindAddress || '0.0.0.0';
    return new Promise((resolve, reject) => {
      this.server!.listen(this.options.port, bindAddress, () => {
        this.running = true;
        console.log(`Credential proxy listening on ${bindAddress}:${this.options.port}`);
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

    const config = SERVICE_CONFIGS[service];
    if (!config) {
      res.statusCode = 404;
      res.end(`No configuration for service: ${service}`);
      return;
    }

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

        clientRes.statusCode = 502;
        clientRes.end('Upstream error');
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

  getServiceConfigs(): Record<string, ServiceConfig> {
    return { ...SERVICE_CONFIGS };
  }

  static getBaseUrl(service: string, proxyPort: number): string {
    return `http://127.0.0.1:${proxyPort}/${service}`;
  }
}

export function createCredentialProxy(options: CredentialProxyOptions): CredentialProxy {
  return new CredentialProxy(options);
}
