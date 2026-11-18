/**
 * LinkableStore: an in-memory backend with a "vault" of items aquaman did
 * not write, for link tests. Every touch of such an item is recorded, so a
 * test can assert that none was read (or changed) when it must not be.
 */

import { MemoryStore, type ParsedLocator } from 'aquaman-core';

export class LinkableStore extends MemoryStore {
  /** The user's own vault items, by locator text. */
  readonly items = new Map<string, string>();
  /** Locators read through `readLinked`, in order. */
  readonly linkedReads: string[] = [];
  /** Set to make the next linked reads fail the way a locked vault does. */
  failWith: string | undefined;

  constructor(items: Record<string, string> = {}) {
    super();
    for (const [locator, value] of Object.entries(items)) this.items.set(locator, value);
  }

  async readLinked(locator: ParsedLocator): Promise<string | null> {
    this.linkedReads.push(locator.text);
    if (this.failWith) throw new Error(this.failWith);
    return this.items.get(locator.text) ?? null;
  }
}
