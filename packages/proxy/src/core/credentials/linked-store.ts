/**
 * The store layer of links (see links.ts for the locators).
 *
 * `LinkedStore` wraps a backend store. A reference listed in
 * `credentials.links` is read from the vault item its locator names; every
 * other reference goes to the backend unchanged. aquaman did not create a
 * linked item, so it never writes or deletes one: `set` and `delete` on a
 * linked reference are refused and say how to remove the link.
 *
 * A link in `credentials.links` is honoured only if the vault holds a matching
 * approval (`LinkApprovals`): the record that a person agreed to this
 * reference being read from this item. config.yaml can be edited by anything
 * running as the user; the approval sits in the vault, where a write needs
 * the vault's own access. A link without one reads nothing.
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
import { RESERVED_SERVICE, LINK_APPROVALS_KEY } from './reserved.js';

/**
 * The approvals a person gave for links, kept in the vault as one record:
 * `{ v: 1, links: { "<service>/<key>": "<locator>" } }` under the reserved
 * service. Written after a person agreed (the daemon's dialog, or the typed
 * confirmation where no dialog can be shown), never from config.yaml.
 */
export class LinkApprovals {
  private cached: Map<string, string> | undefined;

  /** `store` is the backend itself: the record is aquaman's own item, not a linked one. */
  constructor(private store: CredentialStore) {}

  private async load(): Promise<Map<string, string>> {
    const raw = await this.store.get(RESERVED_SERVICE, LINK_APPROVALS_KEY);
    const out = new Map<string, string>();
    if (raw !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      const links = (parsed as { v?: unknown; links?: unknown } | null)?.links;
      // A record that is not one approves nothing.
      if ((parsed as { v?: unknown } | null)?.v === 1 && links && typeof links === 'object' && !Array.isArray(links)) {
        for (const [name, locator] of Object.entries(links as Record<string, unknown>)) {
          if (typeof locator === 'string') out.set(name, locator);
        }
      }
    }
    this.cached = out;
    return out;
  }

  private async save(map: Map<string, string>): Promise<void> {
    await this.store.set(RESERVED_SERVICE, LINK_APPROVALS_KEY, JSON.stringify({ v: 1, links: Object.fromEntries(map) }));
    this.cached = map;
  }

  /**
   * Whether a person approved exactly this link. The record is read again
   * when the copy in memory does not have it, so an approval written by
   * another process is seen.
   */
  async has(name: string, locator: string): Promise<boolean> {
    if (this.cached?.get(name) === locator) return true;
    return (await this.load()).get(name) === locator;
  }

  async approve(name: string, locator: string): Promise<void> {
    const map = await this.load();
    map.set(name, locator);
    await this.save(map);
  }

  /** Returns whether there was an approval to remove. */
  async revoke(name: string): Promise<boolean> {
    const map = await this.load();
    if (!map.delete(name)) return false;
    await this.save(map);
    return true;
  }

  /** Drop the copy in memory, so the next question is answered from the vault. */
  forget(): void {
    this.cached = undefined;
  }
}

export class LinkedStore implements CredentialStore {
  constructor(
    private inner: CredentialStore,
    private backend: CredentialBackend,
    /** The current link map; called on every operation so a changed config is seen. */
    private links: () => ReadonlyMap<string, string>,
    readonly approvals: LinkApprovals = new LinkApprovals(inner),
  ) {}

  private seen: ReadonlyMap<string, string> | undefined;

  /**
   * The link map as it is in config.yaml. When the file changed, the
   * approvals in memory are dropped: another process may have removed a link
   * and its approval, and a link written back by hand must not be read on the
   * strength of an approval that is no longer in the vault.
   */
  private current(): ReadonlyMap<string, string> {
    const map = this.links();
    if (this.seen !== undefined && this.seen !== map) {
      this.approvals.forget();
      this.generation++;
    }
    this.seen = map;
    return map;
  }

  /** Counts the times config.yaml changed under this store. */
  private generation = 0;

  /** The locator a reference is linked to, or '' when it is not linked. */
  private locatorOf(service: string, key: string): string {
    return this.current().get(`${service}/${key}`) ?? '';
  }

  /**
   * What a cache keys a linked value on: the locator and the state of
   * config.yaml it was read under. A value read through a link is good only
   * until the file changes, because the change may be a link that was removed
   * and written back, whose approval has to be checked in the vault again.
   */
  linkStamp(service: string, key: string): string {
    const locator = this.locatorOf(service, key);
    return locator ? `${locator}\u0000${this.generation}` : '';
  }

  /** The backend's own item name, passed through. Links play no part in it. */
  get itemIdentity(): CredentialStore['itemIdentity'] {
    return this.inner.itemIdentity ? (service, key) => this.inner.itemIdentity!(service, key) : undefined;
  }

  async readLinked(locator: ParsedLocator): Promise<string | null> {
    if (locator.backend !== this.backend || !this.inner.readLinked) {
      throw new Error(`The ${this.backend} backend cannot read ${locator.text}`);
    }
    return this.inner.readLinked(locator);
  }

  /**
   * Read through a link. A locator the configured backend cannot read is an
   * error, never a miss, and so is a link nobody approved: the item is not
   * read, and the message says how a person approves it.
   */
  private async readLink(service: string, key: string, text: string): Promise<string | null> {
    if (!(await this.approvals.has(`${service}/${key}`, text))) {
      throw new Error(`${service}/${key} is linked to ${text} in config.yaml, and no approval for that link is recorded in the vault, so the item is not read. A person approves it with: aquaman credentials link ${service}/${key} '${text}' (or removes the link: aquaman credentials unlink ${service}/${key})`);
    }
    const parsed = parseLocatorFor(this.backend, text);
    if (!parsed.ok) {
      throw new Error(`${service}/${key} is linked to ${text}, which cannot be used: ${parsed.error}. Remove the link with: aquaman credentials unlink ${service}/${key}`);
    }
    return this.readLinked(parsed.locator);
  }

  async get(service: string, key: string): Promise<string | null> {
    const link = this.locatorOf(service, key);
    return link ? this.readLink(service, key, link) : this.inner.get(service, key);
  }

  async exists(service: string, key: string): Promise<boolean> {
    const link = this.locatorOf(service, key);
    if (!link) return this.inner.exists(service, key);
    // A link nobody approved is not a credential that exists.
    if (!(await this.approvals.has(`${service}/${key}`, link))) return false;
    return (await this.readLink(service, key, link)) !== null;
  }

  /** Record a person's approval of a link. Called by the linker, after the item resolved. */
  async approveLink(service: string, key: string, locator: string): Promise<void> {
    await this.approvals.approve(`${service}/${key}`, locator);
  }

  async linkApproved(name: string, locator: string): Promise<boolean> {
    return this.approvals.has(name, locator);
  }

  /** Remove the approval of a link. Returns whether there was one. */
  async revokeLink(service: string, key: string): Promise<boolean> {
    return this.approvals.revoke(`${service}/${key}`);
  }

  /** The backend's session, passed through; absent when the backend takes none (vault-lock.ts). */
  get vaultState(): CredentialStore['vaultState'] {
    return this.inner.vaultState ? () => this.inner.vaultState!() : undefined;
  }

  get adoptSession(): CredentialStore['adoptSession'] {
    return this.inner.adoptSession ? (session) => this.inner.adoptSession!(session) : undefined;
  }

  get checkSession(): CredentialStore['checkSession'] {
    return this.inner.checkSession ? () => this.inner.checkSession!() : undefined;
  }

  get forgetSession(): CredentialStore['forgetSession'] {
    return this.inner.forgetSession ? () => this.inner.forgetSession!() : undefined;
  }

  async set(service: string, key: string, value: string, metadata?: Record<string, string>): Promise<void> {
    const link = this.locatorOf(service, key);
    if (link) {
      throw new Error(`${service}/${key} is linked to ${link}, an item aquaman did not create and does not write to. To store a value here instead, first run: aquaman credentials unlink ${service}/${key}`);
    }
    return this.inner.set(service, key, value, metadata);
  }

  async delete(service: string, key: string): Promise<boolean> {
    const link = this.locatorOf(service, key);
    if (link) {
      throw new Error(`${service}/${key} is linked to ${link}, an item aquaman did not create and does not delete. To remove the link, run: aquaman credentials unlink ${service}/${key}`);
    }
    return this.inner.delete(service, key);
  }

  async list(service?: string): Promise<Array<{ service: string; key: string; linked?: string }>> {
    const links = this.current();
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
  /** Whether a person's approval of this link is recorded. Reads aquaman's own record in the vault, never the item. */
  approved(service: string, key: string, locator: string): Promise<boolean>;
  /**
   * Whether a link could be asked for: the locator parses for the configured
   * backend and the reference is not linked elsewhere. Reads config only,
   * never the vault, so the answer says nothing about which items exist.
   */
  plan(service: string, key: string, locator: unknown): LinkPlan;
  /**
   * For the moment after a person agreed: read the item and, if it resolves
   * and nothing is stored under the reference, record the approval in the
   * vault and write the link.
   */
  establish(service: string, key: string, locator: string): Promise<LinkOutcome>;
  /** Remove a link and its approval. The vault item is not touched. Returns whether there was a link. */
  remove(service: string, key: string): Promise<boolean>;
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

  const approved = async (name: string, locator: string): Promise<boolean> => {
    try {
      return (await store.linkApproved?.(name, locator)) === true;
    } catch {
      return false;
    }
  };

  return {
    linkOf(service, key) {
      return links().get(`${service}/${key}`);
    },

    approved(service, key, locator) {
      return approved(`${service}/${key}`, locator);
    },

    plan(service, key, text) {
      const checked = check(service, key, text);
      if (!checked.ok) return checked;
      return { ok: true, locator: checked.locator.text, linked: links().has(`${service}/${key}`) };
    },

    async establish(service, key, text) {
      const checked = check(service, key, text);
      if (!checked.ok) return checked;
      const name = `${service}/${key}`;
      if (links().has(name) && store.approveLink && await approved(name, checked.locator.text)) return { ok: true };
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
      if (!store.approveLink) {
        return {
          ok: false,
          code: 'links_unavailable',
          error: 'This credential store does not record link approvals',
          fix: 'Run: aquaman doctor',
        };
      }
      try {
        // The approval first: a link in config.yaml without one reads nothing,
        // an approval without a link does nothing.
        await store.approveLink(service, key, checked.locator.text);
      } catch (err) {
        return {
          ok: false,
          code: 'link_unreadable',
          error: `Could not record the approval in the vault: ${err instanceof Error ? err.message : String(err)}`,
          fix: 'Check that the vault is unlocked and writable (aquaman doctor), then ask again',
        };
      }
      writeCredentialLink(configPath, name, checked.locator.text);
      return { ok: true };
    },

    async remove(service, key) {
      const had = writeCredentialLink(configPath, `${service}/${key}`, null);
      // Without its link an approval does nothing; it is removed so that
      // writing the link back by hand does not bring the reading back.
      await store.revokeLink?.(service, key);
      return had;
    },
  };
}
