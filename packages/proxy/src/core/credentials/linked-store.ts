/**
 * The store layer of links (see links.ts for the locators).
 *
 * `LinkedStore` wraps a backend store. A reference listed in
 * `credentials.links` is read from the vault item its locator names; every
 * other reference goes to the backend unchanged. aquaman did not create a
 * linked item, so it never writes or deletes one: `set` and `delete` on a
 * linked reference are refused and say how to remove the link.
 *
 * Everything above the store (broker scope, policy, injection, audit) sees an
 * ordinary credential store, so a linked reference is scoped, injected and
 * audited like any other.
 *
 * `createCredentialLinker` is the one place a link is made, for the CLI and
 * for the daemon's request dialog alike. It never replaces a value aquaman
 * stored, and it reads the item before writing the link, so a link that is
 * written is one that resolved.
 */

import type { CredentialBackend } from '../types.js';
import type { CredentialStore } from './store.js';
import { parseLocatorFor, writeCredentialLink, createLinkSource, type ParsedLocator, type LocatorResult } from './links.js';

export class LinkedStore implements CredentialStore {
  constructor(
    private inner: CredentialStore,
    private backend: CredentialBackend,
    /** The current link map; called on every operation so a changed config is seen. */
    private links: () => ReadonlyMap<string, string>,
  ) {}

  linkStamp(service: string, key: string): string {
    return this.links().get(`${service}/${key}`) ?? '';
  }

  async readLinked(locator: ParsedLocator): Promise<string | null> {
    if (locator.backend !== this.backend || !this.inner.readLinked) {
      throw new Error(`The ${this.backend} backend cannot read ${locator.text}`);
    }
    return this.inner.readLinked(locator);
  }

  /** Read through a link. A locator the configured backend cannot read is an error, never a miss. */
  private async readLink(service: string, key: string, text: string): Promise<string | null> {
    const parsed = parseLocatorFor(this.backend, text);
    if (!parsed.ok) {
      throw new Error(`${service}/${key} is linked to ${text}, which cannot be used: ${parsed.error}. Remove the link with: aquaman credentials unlink ${service}/${key}`);
    }
    return this.readLinked(parsed.locator);
  }

  async get(service: string, key: string): Promise<string | null> {
    const link = this.linkStamp(service, key);
    return link ? this.readLink(service, key, link) : this.inner.get(service, key);
  }

  async exists(service: string, key: string): Promise<boolean> {
    const link = this.linkStamp(service, key);
    return link ? (await this.readLink(service, key, link)) !== null : this.inner.exists(service, key);
  }

  async set(service: string, key: string, value: string, metadata?: Record<string, string>): Promise<void> {
    const link = this.linkStamp(service, key);
    if (link) {
      throw new Error(`${service}/${key} is linked to ${link}, an item aquaman did not create and does not write to. To store a value here instead, first run: aquaman credentials unlink ${service}/${key}`);
    }
    return this.inner.set(service, key, value, metadata);
  }

  async delete(service: string, key: string): Promise<boolean> {
    const link = this.linkStamp(service, key);
    if (link) {
      throw new Error(`${service}/${key} is linked to ${link}, an item aquaman did not create and does not delete. To remove the link, run: aquaman credentials unlink ${service}/${key}`);
    }
    return this.inner.delete(service, key);
  }

  async list(service?: string): Promise<Array<{ service: string; key: string; linked?: string }>> {
    const links = this.links();
    const out: Array<{ service: string; key: string; linked?: string }> = [];
    for (const cred of await this.inner.list(service)) {
      if (!links.has(`${cred.service}/${cred.key}`)) out.push(cred);
    }
    for (const [name, linked] of links) {
      const slash = name.indexOf('/');
      const linkedService = name.slice(0, slash);
      if (!service || linkedService === service) out.push({ service: linkedService, key: name.slice(slash + 1), linked });
    }
    return out;
  }
}

export type LinkPlan =
  /** `linked` is true when the reference already points at exactly this locator. */
  | { ok: true; locator: string; linked: boolean }
  | { ok: false; code: string; error: string; fix: string };

export type LinkOutcome =
  | { ok: true }
  | { ok: false; code: string; error: string; fix: string };

export interface CredentialLinker {
  /** The locator a reference is linked to, if any. Reads config only. */
  linkOf(service: string, key: string): string | undefined;
  /**
   * Whether a link could be asked for: the locator parses for the configured
   * backend and the reference is not linked elsewhere. Reads config only,
   * never the vault, so the answer says nothing about which items exist.
   */
  plan(service: string, key: string, locator: unknown): LinkPlan;
  /** Read the item and, if it resolves and nothing is stored under the reference, write the link. */
  establish(service: string, key: string, locator: string): Promise<LinkOutcome>;
  /** Remove a link. The vault item is not touched. Returns whether there was one. */
  remove(service: string, key: string): boolean;
}

export function createCredentialLinker(options: {
  /** The store links are read through. Any wrapper is fine as long as it passes `readLinked` on. */
  store: CredentialStore;
  backend: CredentialBackend;
  configPath: string;
}): CredentialLinker {
  const { store, backend, configPath } = options;
  const links = createLinkSource(configPath);

  const check = (service: string, key: string, text: unknown): LocatorResult | { ok: false; code: 'link_exists'; error: string; fix: string } => {
    const parsed = parseLocatorFor(backend, text);
    if (!parsed.ok) return parsed;
    const current = links().get(`${service}/${key}`);
    if (current !== undefined && current !== parsed.locator.text) {
      return {
        ok: false,
        code: 'link_exists',
        error: `${service}/${key} is already linked to another item`,
        fix: `Remove that link first: aquaman credentials unlink ${service}/${key}`,
      };
    }
    return parsed;
  };

  return {
    linkOf(service, key) {
      return links().get(`${service}/${key}`);
    },

    plan(service, key, text) {
      const checked = check(service, key, text);
      if (!checked.ok) return checked;
      return { ok: true, locator: checked.locator.text, linked: links().has(`${service}/${key}`) };
    },

    async establish(service, key, text) {
      const checked = check(service, key, text);
      if (!checked.ok) return checked;
      if (links().has(`${service}/${key}`)) return { ok: true };
      let value: string | null;
      try {
        // A value aquaman stored is never replaced by a link, and the other way round.
        if (await store.exists(service, key)) {
          return {
            ok: false,
            code: 'link_value_stored',
            error: `${service}/${key} already has a value stored by aquaman, and a link does not replace it`,
            fix: `To use the vault item instead, first run: aquaman credentials delete ${service} ${key}`,
          };
        }
        value = store.readLinked ? await store.readLinked(checked.locator) : null;
      } catch (err) {
        return {
          ok: false,
          code: 'link_unreadable',
          error: `Could not read ${checked.locator.text}: ${err instanceof Error ? err.message : String(err)}`,
          fix: 'Check that the vault is unlocked and reachable (aquaman doctor), then ask again',
        };
      }
      if (value === null || value.length === 0) {
        return {
          ok: false,
          code: 'link_unreadable',
          error: `Nothing could be read at ${checked.locator.text}`,
          fix: 'Check the item and field names in your vault, then ask again with the corrected locator',
        };
      }
      writeCredentialLink(configPath, `${service}/${key}`, checked.locator.text);
      return { ok: true };
    },

    remove(service, key) {
      return writeCredentialLink(configPath, `${service}/${key}`, null);
    },
  };
}
