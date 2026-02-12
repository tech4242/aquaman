/**
 * OAuth client credentials token cache for the credential proxy.
 *
 * Services like MS Teams, Feishu, and Google Chat require exchanging
 * stored client credentials for short-lived access tokens. This cache
 * handles the exchange and caches tokens until near-expiry.
 */

import type { CredentialStore } from './core/index.js';
import type { OAuthConfig } from './service-registry.js';

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class OAuthTokenCache {
  private tokens: Map<string, CachedToken> = new Map();
  /** Buffer in ms before expiry to trigger refresh (default 60s) */
  private refreshBuffer: number;
  /** Maximum number of cached tokens (default 100) */
  private maxSize: number;

  constructor(options?: { refreshBuffer?: number; maxSize?: number }) {
    this.refreshBuffer = options?.refreshBuffer ?? 60_000;
    this.maxSize = options?.maxSize ?? 100;
  }

  /**
   * Remove expired entries from the cache.
   */
  cleanExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.tokens) {
      if (entry.expiresAt < now) {
        this.tokens.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Get an access token for a service, exchanging credentials if needed.
   * Returns the Bearer token string ready for injection.
   */
  async getToken(
    service: string,
    oauthConfig: OAuthConfig,
    store: CredentialStore
  ): Promise<string> {
    const cached = this.tokens.get(service);
    if (cached && cached.expiresAt > Date.now() + this.refreshBuffer) {
      return cached.token;
    }

    const token = await this.exchangeCredentials(service, oauthConfig, store);
    return token;
  }

  private async exchangeCredentials(
    service: string,
    config: OAuthConfig,
    store: CredentialStore
  ): Promise<string> {
    const clientId = await store.get(service, config.clientIdKey);
    const clientSecret = await store.get(service, config.clientSecretKey);

    if (!clientId || !clientSecret) {
      throw new Error(
        `OAuth credentials not found for ${service}: need ${config.clientIdKey} and ${config.clientSecretKey}`
      );
    }

    // Resolve any template variables in the token URL (e.g. {tenant_id} for Azure AD)
    let tokenUrl = config.tokenUrl;
    const templateMatch = tokenUrl.match(/\{(\w+)\}/g);
    if (templateMatch) {
      for (const placeholder of templateMatch) {
        const key = placeholder.slice(1, -1);
        const value = await store.get(service, key);
        if (!value) {
          throw new Error(`OAuth token URL requires credential "${key}" for service ${service}`);
        }
        tokenUrl = tokenUrl.replace(placeholder, value);
      }
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });

    if (config.scope) {
      body.set('scope', config.scope);
    }
    if (config.audience) {
      body.set('audience', config.audience);
    }

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `OAuth token exchange failed for ${service}: ${response.status} ${text}`
      );
    }

    const data = await response.json() as { access_token: string; expires_in?: number };

    if (!data.access_token) {
      throw new Error(`OAuth response missing access_token for ${service}`);
    }

    const expiresIn = data.expires_in || 3600;

    // Evict expired entries, then oldest if still at capacity
    this.cleanExpired();
    if (this.tokens.size >= this.maxSize) {
      let oldestKey: string | null = null;
      let oldestExpiry = Infinity;
      for (const [key, entry] of this.tokens) {
        if (entry.expiresAt < oldestExpiry) {
          oldestExpiry = entry.expiresAt;
          oldestKey = key;
        }
      }
      if (oldestKey) this.tokens.delete(oldestKey);
    }

    this.tokens.set(service, {
      token: data.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
    });

    return data.access_token;
  }

  /**
   * Invalidate a cached token (forces re-exchange on next request).
   */
  invalidate(service: string): void {
    this.tokens.delete(service);
  }

  /**
   * Clear all cached tokens.
   */
  clear(): void {
    this.tokens.clear();
  }
}

export function createOAuthTokenCache(options?: { refreshBuffer?: number; maxSize?: number }): OAuthTokenCache {
  return new OAuthTokenCache(options);
}
