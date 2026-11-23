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

import type { CredentialStore, ParsedLocator, SessionAdoption, VaultState } from './store.js';

interface CacheEntry {
  value: string;
  fetchedAt: number;
  /** What the reference was linked to when the value was read (`''` for none). */
  link: string;
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
    // A value read through one link, or from aquaman's own item, is not the
    // value of the reference once its link is made, changed or removed.
    const link = this.inner.linkStamp?.(service, key) ?? '';
    if (entry && entry.link === link && Date.now() - entry.fetchedAt < this.ttlMs) {
      return entry.value;
    }
    let value: string | null;
    try {
      value = await this.inner.get(service, key);
    } catch (err) {
      // The vault locked under this process. What was read while it was open
      // is not served past that point.
      if ((err as { code?: unknown } | null)?.code === 'vault_locked') this.cache.clear();
      throw err;
    }
    if (value !== null) {
      this.cache.set(k, { value, fetchedAt: Date.now(), link });
    } else {
      // Never cache misses: a just-added credential must be visible on the
      // next read, and a stale hit must not outlive a backend-side removal.
      this.cache.delete(k);
    }
    return value;
  }

  /**
   * Read from the backend whatever the cache holds, and cache what comes
   * back. For a value another process may have written since this one last
   * read it: the audit anchor.
   */
  async getFresh(service: string, key: string): Promise<string | null> {
    this.cache.delete(this.cacheKey(service, key));
    return this.get(service, key);
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

  async list(service?: string): Promise<Array<{ service: string; key: string; linked?: string }>> {
    return this.inner.list(service);
  }

  async exists(service: string, key: string): Promise<boolean> {
    return this.inner.exists(service, key);
  }

  /** Passed through and never cached: this is the read that checks a link before it is made. */
  async readLinked(locator: ParsedLocator): Promise<string | null> {
    return this.inner.readLinked ? this.inner.readLinked(locator) : null;
  }

  linkStamp(service: string, key: string): string {
    return this.inner.linkStamp?.(service, key) ?? '';
  }

  async approveLink(service: string, key: string, locator: string): Promise<void> {
    if (!this.inner.approveLink) throw new Error('This credential store does not record link approvals');
    await this.inner.approveLink(service, key, locator);
  }

  async revokeLink(service: string, key: string): Promise<boolean> {
    return (await this.inner.revokeLink?.(service, key)) === true;
  }

  async linkApproved(name: string, locator: string): Promise<boolean> {
    return (await this.inner.linkApproved?.(name, locator)) === true;
  }

  /**
   * The session of a backend that a person unlocks, passed through. Only
   * present when the backend has it, so the proxy can tell which stores take
   * a session. Letting go of the session also drops every cached value, and
   * so does finding out that the vault's CLI no longer accepts it.
   */
  get vaultState(): (() => VaultState) | undefined {
    return this.inner.vaultState ? () => this.inner.vaultState!() : undefined;
  }

  get adoptSession(): ((session: string) => Promise<SessionAdoption>) | undefined {
    return this.inner.adoptSession ? (session) => this.inner.adoptSession!(session) : undefined;
  }

  get checkSession(): (() => Promise<VaultState>) | undefined {
    if (!this.inner.checkSession) return undefined;
    return async () => {
      const state = await this.inner.checkSession!();
      if (state === 'locked') this.cache.clear();
      return state;
    };
  }

  get forgetSession(): (() => void) | undefined {
    if (!this.inner.forgetSession) return undefined;
    return () => {
      this.inner.forgetSession!();
      this.cache.clear();
    };
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
