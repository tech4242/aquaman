/**
 * CountingStore — CredentialStore decorator that counts calls to the inner
 * backend. Used by the caching tests to assert exactly how many times the
 * (expensive, possibly prompting) backend was actually hit.
 */

import type { CredentialStore } from 'aquaman-core';

export class CountingStore implements CredentialStore {
  gets = 0;
  sets = 0;
  deletes = 0;
  lists = 0;
  existsCalls = 0;

  constructor(private inner: CredentialStore) {}

  async get(service: string, key: string): Promise<string | null> {
    this.gets++;
    return this.inner.get(service, key);
  }

  async set(service: string, key: string, value: string, metadata?: Record<string, string>): Promise<void> {
    this.sets++;
    return this.inner.set(service, key, value, metadata);
  }

  async delete(service: string, key: string): Promise<boolean> {
    this.deletes++;
    return this.inner.delete(service, key);
  }

  async list(service?: string): Promise<Array<{ service: string; key: string }>> {
    this.lists++;
    return this.inner.list(service);
  }

  async exists(service: string, key: string): Promise<boolean> {
    this.existsCalls++;
    return this.inner.exists(service, key);
  }

  resetCounts(): void {
    this.gets = 0;
    this.sets = 0;
    this.deletes = 0;
    this.lists = 0;
    this.existsCalls = 0;
  }
}
