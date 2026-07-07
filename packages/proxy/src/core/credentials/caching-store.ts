/**
 * TTL'd in-memory credential cache (v0.13.1+)
 *
 * Wraps any CredentialStore so the daemon hits the underlying backend at most
 * once per TTL window per credential. This exists for backends where every
 * read has a per-access cost: 1Password (a biometric prompt per `op` spawn in
 * desktop-app mode), Bitwarden (~1-2s `bw` spawn), HashiCorp Vault (an HTTP
 * round-trip). It applies the same pattern systemd-creds, keepassxc, and
 * encrypted-file already use — but TTL-bounded instead of daemon-lifetime.
 *
 * Security posture: the cache lives in the proxy's address space, where
 * credentials already transit on every proxied request. It adds no interface
 * (not reachable via UDS, loopback, or broker) and is never persisted —
 * agent-side isolation (ATLAS T0055/T0090) and at-rest posture (NIST SC-28)
 * are unchanged. See docs/compliance/ and test/compliance/cache-residency.
 *
 * Only wrap long-lived daemon processes: one-shot CLI commands gain nothing
 * and should not extend credential residency.
 */

import type { CredentialStore } from './store.js';

interface CacheEntry {
  value: string;
  fetchedAt: number;
}

export class CachingStore implements CredentialStore {
  private inner: CredentialStore;
  private ttlMs: number;
  private cache = new Map<string, CacheEntry>();

  constructor(inner: CredentialStore, ttlSeconds: number) {
    this.inner = inner;
    this.ttlMs = ttlSeconds * 1000;
  }

  private cacheKey(service: string, key: string): string {
    // NUL separator: unlike ':', it cannot appear in service/key names, so
    // ("a", "b:c") and ("a:b", "c") can never collide.
    return `${service}\u0000${key}`;
  }

  async get(service: string, key: string): Promise<string | null> {
    const k = this.cacheKey(service, key);
    const entry = this.cache.get(k);
    if (entry && Date.now() - entry.fetchedAt < this.ttlMs) {
      return entry.value;
    }
    const value = await this.inner.get(service, key);
    if (value !== null) {
      this.cache.set(k, { value, fetchedAt: Date.now() });
    } else {
      // Never cache misses: a just-added credential must be visible on the
      // next read, and a stale hit must not outlive a backend-side removal.
      this.cache.delete(k);
    }
    return value;
  }

  async set(service: string, key: string, value: string, metadata?: Record<string, string>): Promise<void> {
    await this.inner.set(service, key, value, metadata);
    this.cache.delete(this.cacheKey(service, key));
  }

  async delete(service: string, key: string): Promise<boolean> {
    const deleted = await this.inner.delete(service, key);
    this.cache.delete(this.cacheKey(service, key));
    return deleted;
  }

  async list(service?: string): Promise<Array<{ service: string; key: string }>> {
    return this.inner.list(service);
  }

  async exists(service: string, key: string): Promise<boolean> {
    return this.inner.exists(service, key);
  }

  /** Drop every cached value (next reads go to the backend). */
  flush(): void {
    this.cache.clear();
  }
}

/**
 * Wrap `store` in a CachingStore when `ttlSeconds > 0`; otherwise return it
 * untouched. Callers pass the resolved TTL from `resolveCacheTtl()`.
 */
export function wrapWithCache(store: CredentialStore, ttlSeconds: number): CredentialStore {
  return ttlSeconds > 0 ? new CachingStore(store, ttlSeconds) : store;
}
