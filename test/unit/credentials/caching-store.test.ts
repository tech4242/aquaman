/**
 * CachingStore unit tests (v0.13.1+)
 *
 * The cache exists so the daemon hits prompting/slow backends (1Password,
 * Bitwarden, Vault) at most once per TTL window per credential. These tests
 * pin down every behavioral guarantee the compliance story relies on:
 * delegation counts, TTL semantics, invalidation on writes, no negative
 * caching, error transparency, and strict passthrough of list/exists.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CachingStore, wrapWithCache, MemoryStore } from 'aquaman-core';
import type { CredentialStore } from 'aquaman-core';
import { CountingStore } from '../../helpers/counting-store.js';

const TTL = 900; // seconds

describe('CachingStore', () => {
  let inner: CountingStore;
  let memory: MemoryStore;
  let store: CachingStore;

  beforeEach(async () => {
    vi.useFakeTimers();
    memory = new MemoryStore();
    inner = new CountingStore(memory);
    store = new CachingStore(inner, TTL);
    await memory.set('anthropic', 'api_key', 'sk-ant-original');
  });

  afterEach(() => {
    vi.useRealTimers();
    memory.clear();
  });

  describe('read path', () => {
    it('delegates the first get to the backend and returns its value', async () => {
      expect(await store.get('anthropic', 'api_key')).toBe('sk-ant-original');
      expect(inner.gets).toBe(1);
    });

    it('serves repeated gets within the TTL from the cache (one backend hit)', async () => {
      for (let i = 0; i < 25; i++) {
        expect(await store.get('anthropic', 'api_key')).toBe('sk-ant-original');
      }
      expect(inner.gets).toBe(1);
    });

    it('stays cached just before the TTL boundary', async () => {
      await store.get('anthropic', 'api_key');
      vi.advanceTimersByTime(TTL * 1000 - 1);
      await store.get('anthropic', 'api_key');
      expect(inner.gets).toBe(1);
    });

    it('refetches at exactly the TTL boundary', async () => {
      await store.get('anthropic', 'api_key');
      vi.advanceTimersByTime(TTL * 1000);
      await store.get('anthropic', 'api_key');
      expect(inner.gets).toBe(2);
    });

    it('picks up a backend-side value change after expiry', async () => {
      expect(await store.get('anthropic', 'api_key')).toBe('sk-ant-original');
      await memory.set('anthropic', 'api_key', 'sk-ant-rotated'); // external rotation
      expect(await store.get('anthropic', 'api_key')).toBe('sk-ant-original'); // still cached
      vi.advanceTimersByTime(TTL * 1000);
      expect(await store.get('anthropic', 'api_key')).toBe('sk-ant-rotated');
    });

    it('returns null after expiry when the backend entry was removed externally, and does not resurrect the old value', async () => {
      await store.get('anthropic', 'api_key');
      await memory.delete('anthropic', 'api_key');
      vi.advanceTimersByTime(TTL * 1000);
      expect(await store.get('anthropic', 'api_key')).toBeNull();
      // The stale entry must be gone: another get goes to the backend again.
      expect(await store.get('anthropic', 'api_key')).toBeNull();
      expect(inner.gets).toBe(3);
    });

    it('resets the TTL window on refetch, not on cache hit', async () => {
      await store.get('anthropic', 'api_key');           // t=0 fetch
      vi.advanceTimersByTime(TTL * 1000 - 1);
      await store.get('anthropic', 'api_key');           // hit — must NOT extend
      vi.advanceTimersByTime(1);                          // t=TTL
      await store.get('anthropic', 'api_key');           // expired → refetch
      expect(inner.gets).toBe(2);
    });

    it('caches an empty-string value (falsy but valid)', async () => {
      await memory.set('svc', 'empty', '');
      expect(await store.get('svc', 'empty')).toBe('');
      expect(await store.get('svc', 'empty')).toBe('');
      expect(inner.gets).toBe(1);
    });

    it('resolves concurrent cold-cache gets to the correct value', async () => {
      const [a, b, c] = await Promise.all([
        store.get('anthropic', 'api_key'),
        store.get('anthropic', 'api_key'),
        store.get('anthropic', 'api_key'),
      ]);
      expect([a, b, c]).toEqual(['sk-ant-original', 'sk-ant-original', 'sk-ant-original']);
      // No single-flight dedup is promised; correctness is.
      expect(await store.get('anthropic', 'api_key')).toBe('sk-ant-original');
    });
  });

  describe('no negative caching', () => {
    it('does not cache a miss — every get for a missing key hits the backend', async () => {
      expect(await store.get('missing', 'key')).toBeNull();
      expect(await store.get('missing', 'key')).toBeNull();
      expect(inner.gets).toBe(2);
    });

    it('sees a just-added credential immediately (no stale miss)', async () => {
      expect(await store.get('github', 'token')).toBeNull();
      await memory.set('github', 'token', 'ghp_fresh');
      expect(await store.get('github', 'token')).toBe('ghp_fresh');
    });
  });

  describe('write-path invalidation', () => {
    it('set() writes through to the backend with metadata', async () => {
      await store.set('svc', 'key', 'value-1', { note: 'meta' });
      expect(inner.sets).toBe(1);
      expect(await memory.get('svc', 'key')).toBe('value-1');
    });

    it('set() invalidates the cached entry — next get returns the new value without waiting for TTL', async () => {
      expect(await store.get('anthropic', 'api_key')).toBe('sk-ant-original');
      await store.set('anthropic', 'api_key', 'sk-ant-new');
      expect(await store.get('anthropic', 'api_key')).toBe('sk-ant-new');
      expect(inner.gets).toBe(2); // refetched after invalidation
    });

    it('delete() removes from the backend, returns its result, and invalidates', async () => {
      await store.get('anthropic', 'api_key'); // populate cache
      expect(await store.delete('anthropic', 'api_key')).toBe(true);
      expect(await store.get('anthropic', 'api_key')).toBeNull(); // not served from cache
      expect(await store.delete('anthropic', 'api_key')).toBe(false); // backend's answer passes through
    });

    it('set()/delete() on one key does not evict other cached keys', async () => {
      await memory.set('anthropic', 'other_key', 'keep-me');
      await memory.set('openai', 'api_key', 'sk-openai');
      await store.get('anthropic', 'api_key');
      await store.get('anthropic', 'other_key');
      await store.get('openai', 'api_key');
      inner.resetCounts();

      await store.set('anthropic', 'api_key', 'sk-ant-new');
      await store.delete('openai', 'api_key');

      expect(await store.get('anthropic', 'other_key')).toBe('keep-me');
      expect(inner.gets).toBe(0); // untouched sibling still cached
    });
  });

  describe('key isolation', () => {
    it('caches per (service, key) pair independently', async () => {
      await memory.set('anthropic', 'other_key', 'v2');
      await memory.set('openai', 'api_key', 'v3');
      await store.get('anthropic', 'api_key');
      await store.get('anthropic', 'other_key');
      await store.get('openai', 'api_key');
      expect(inner.gets).toBe(3);
      await store.get('anthropic', 'api_key');
      await store.get('anthropic', 'other_key');
      await store.get('openai', 'api_key');
      expect(inner.gets).toBe(3);
    });

    it('never collides composite names — ("a", "b:c") vs ("a:b", "c")', async () => {
      // MemoryStore itself keys on `service:key` and WOULD collide here, so use
      // a tuple-keyed inner store to isolate the cache layer's behavior.
      const values = new Map<string, Map<string, string>>([
        ['a', new Map([['b:c', 'first']])],
        ['a:b', new Map([['c', 'second']])],
      ]);
      const tupleStore: CredentialStore = {
        async get(s, k) { return values.get(s)?.get(k) ?? null; },
        async set(s, k, v) { (values.get(s) ?? values.set(s, new Map()).get(s)!).set(k, v); },
        async delete(s, k) { return values.get(s)?.delete(k) ?? false; },
        async list() { return []; },
        async exists(s, k) { return values.get(s)?.has(k) ?? false; },
      };
      const cached = new CachingStore(tupleStore, TTL);
      expect(await cached.get('a', 'b:c')).toBe('first');
      expect(await cached.get('a:b', 'c')).toBe('second');
      expect(await cached.get('a', 'b:c')).toBe('first'); // cached hit, still distinct
      expect(await cached.get('a:b', 'c')).toBe('second');
    });

    it('handles dots, hyphens, and underscores in names', async () => {
      await memory.set('cloudflare-ai.gateway', 'api_key-v2', 'cf-key');
      expect(await store.get('cloudflare-ai.gateway', 'api_key-v2')).toBe('cf-key');
      expect(await store.get('cloudflare-ai.gateway', 'api_key-v2')).toBe('cf-key');
      expect(inner.gets).toBe(1);
    });
  });

  describe('passthrough operations', () => {
    it('list() always delegates (never cached)', async () => {
      await store.list();
      await store.list('anthropic');
      expect(inner.lists).toBe(2);
    });

    it('exists() always delegates and does not populate the value cache', async () => {
      expect(await store.exists('anthropic', 'api_key')).toBe(true);
      expect(inner.existsCalls).toBe(1);
      await store.get('anthropic', 'api_key');
      expect(inner.gets).toBe(1); // get still had to fetch — exists() cached nothing
    });
  });

  describe('flush()', () => {
    it('drops all cached values — next gets refetch', async () => {
      await memory.set('openai', 'api_key', 'sk-openai');
      await store.get('anthropic', 'api_key');
      await store.get('openai', 'api_key');
      store.flush();
      await store.get('anthropic', 'api_key');
      await store.get('openai', 'api_key');
      expect(inner.gets).toBe(4);
    });
  });

  describe('error transparency', () => {
    function failingStore(failGets: boolean): CredentialStore {
      return {
        async get(s, k) {
          if (failGets) throw new Error('backend unavailable');
          return memory.get(s, k);
        },
        async set() { throw new Error('write failed'); },
        async delete() { throw new Error('delete failed'); },
        async list() { return []; },
        async exists() { return false; },
      };
    }

    it('propagates backend get() errors and caches nothing', async () => {
      let fail = true;
      const flaky: CredentialStore = {
        async get(s, k) {
          if (fail) throw new Error('backend unavailable');
          return memory.get(s, k);
        },
        async set(s, k, v, m) { return memory.set(s, k, v, m); },
        async delete(s, k) { return memory.delete(s, k); },
        async list(s) { return memory.list(s); },
        async exists(s, k) { return memory.exists(s, k); },
      };
      const counting = new CountingStore(flaky);
      const cached = new CachingStore(counting, TTL);

      await expect(cached.get('anthropic', 'api_key')).rejects.toThrow('backend unavailable');
      fail = false;
      expect(await cached.get('anthropic', 'api_key')).toBe('sk-ant-original');
      expect(counting.gets).toBe(2); // the error was not cached
    });

    it('propagates refresh errors after expiry instead of serving a stale value', async () => {
      let fail = false;
      const flaky: CredentialStore = {
        async get(s, k) {
          if (fail) throw new Error('backend unavailable');
          return memory.get(s, k);
        },
        async set(s, k, v, m) { return memory.set(s, k, v, m); },
        async delete(s, k) { return memory.delete(s, k); },
        async list(s) { return memory.list(s); },
        async exists(s, k) { return memory.exists(s, k); },
      };
      const cached = new CachingStore(flaky, TTL);

      expect(await cached.get('anthropic', 'api_key')).toBe('sk-ant-original');
      fail = true;
      vi.advanceTimersByTime(TTL * 1000);
      await expect(cached.get('anthropic', 'api_key')).rejects.toThrow('backend unavailable');
    });

    it('keeps the cached value when set() fails (backend still holds the old value)', async () => {
      const cached = new CachingStore(failingStore(false), TTL);
      expect(await cached.get('anthropic', 'api_key')).toBe('sk-ant-original');
      await expect(cached.set('anthropic', 'api_key', 'new')).rejects.toThrow('write failed');
      // Backend write failed → old value is still correct; cache may serve it.
      expect(await cached.get('anthropic', 'api_key')).toBe('sk-ant-original');
    });
  });

  describe('wrapWithCache()', () => {
    it('wraps when ttlSeconds > 0', () => {
      const wrapped = wrapWithCache(inner, 1);
      expect(wrapped).toBeInstanceOf(CachingStore);
      expect(wrapped).not.toBe(inner);
    });

    it('returns the store untouched when ttlSeconds is 0', () => {
      expect(wrapWithCache(inner, 0)).toBe(inner);
    });

    it('returns the store untouched for negative ttlSeconds', () => {
      expect(wrapWithCache(inner, -5)).toBe(inner);
    });

    it('a ttl=0 passthrough hits the backend on every read', async () => {
      const passthrough = wrapWithCache(inner, 0);
      await passthrough.get('anthropic', 'api_key');
      await passthrough.get('anthropic', 'api_key');
      expect(inner.gets).toBe(2);
    });

    it('a 1-second TTL expires on schedule', async () => {
      const shortLived = wrapWithCache(inner, 1);
      await shortLived.get('anthropic', 'api_key');
      vi.advanceTimersByTime(999);
      await shortLived.get('anthropic', 'api_key');
      expect(inner.gets).toBe(1);
      vi.advanceTimersByTime(1);
      await shortLived.get('anthropic', 'api_key');
      expect(inner.gets).toBe(2);
    });
  });
});
