/**
 * 1Password credential backend using the `op` CLI
 * Requires: 1Password CLI installed and signed in
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CredentialStore } from '../store.js';

export interface OnePasswordStoreOptions {
  vault?: string;
  account?: string;
}

const DEFAULT_VAULT = 'aquaman';
const ITEM_PREFIX = 'aquaman';

// Metadata key validation: must start with letter, only alphanum/underscore/hyphen
const SAFE_METADATA_KEY = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

// The `op` CLI reports missing items with a few different phrasings depending
// on version. Match all of them so get/delete/list return cleanly instead of
// throwing.
export function isItemNotFoundError(message: string): boolean {
  return message.includes('not found')
    || message.includes("isn't an item")
    || message.includes('no item');
}

// Writes `template` to a 0o600 file inside a freshly-made 0o700 tempdir and
// invokes `fn` with the path. Unlinks the file and rmdir's the directory
// after `fn` returns or throws, so the JSON template never lingers on disk.
export function writeTemplateAndRun<T>(template: string, fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'aquaman-op-'));
  const file = join(dir, 'template.json');
  writeFileSync(file, template, { mode: 0o600 });
  try {
    return fn(file);
  } finally {
    try { unlinkSync(file); } catch { /* best-effort */ }
    try { rmdirSync(dir); } catch { /* best-effort */ }
  }
}

export class OnePasswordStore implements CredentialStore {
  private vault: string;
  private account?: string;
  private opPath: string | null = null;

  constructor(options?: OnePasswordStoreOptions) {
    this.vault = options?.vault || DEFAULT_VAULT;
    this.account = options?.account;
    this.validateOpCli();
  }

  private validateOpCli(): void {
    // Check if op CLI is installed
    try {
      const result = spawnSync('which', ['op'], { encoding: 'utf-8' });
      if (result.status !== 0) {
        throw new Error('1Password CLI (op) not found. Install from: https://1password.com/downloads/command-line/');
      }
      this.opPath = result.stdout.trim();
    } catch {
      throw new Error('1Password CLI (op) not found. Install from: https://1password.com/downloads/command-line/');
    }

    // Check if signed in
    try {
      this.runOp(['account', 'get']);
    } catch (error) {
      throw new Error('Not signed in to 1Password. Run: op signin');
    }
  }

  private runOp(args: string[], input?: string): string {
    const accountArgs = this.account ? ['--account', this.account] : [];
    const fullArgs = [...args, ...accountArgs];

    try {
      const result = spawnSync('op', fullArgs, {
        encoding: 'utf-8',
        input,
        maxBuffer: 10 * 1024 * 1024
      });

      if (result.status !== 0) {
        const error = result.stderr || result.stdout || 'Unknown error';
        throw new Error(`op command failed: ${error}`);
      }

      return result.stdout;
    } catch (error) {
      if (error instanceof Error && error.message.includes('op command failed')) {
        throw error;
      }
      throw new Error(`Failed to run op command: ${error}`);
    }
  }

  private getItemName(service: string, key: string): string {
    return `${ITEM_PREFIX}-${service}-${key}`;
  }

  private parseItemName(itemName: string): { service: string; key: string } | null {
    if (!itemName.startsWith(`${ITEM_PREFIX}-`)) {
      return null;
    }
    const parts = itemName.slice(ITEM_PREFIX.length + 1).split('-');
    if (parts.length < 2) {
      return null;
    }
    // Handle service names with dashes by taking first part as service
    const service = parts[0];
    const key = parts.slice(1).join('-');
    return { service, key };
  }

  private ensureVaultExists(): void {
    try {
      this.runOp(['vault', 'get', this.vault]);
    } catch {
      // Vault doesn't exist, create it
      try {
        this.runOp(['vault', 'create', this.vault]);
        console.log(`Created 1Password vault: ${this.vault}`);
      } catch (createError) {
        throw new Error(`Failed to create vault "${this.vault}": ${createError}`);
      }
    }
  }

  async get(service: string, key: string): Promise<string | null> {
    const itemName = this.getItemName(service, key);

    try {
      const result = this.runOp([
        'item', 'get', itemName,
        '--vault', this.vault,
        '--fields', 'credential',
        '--format', 'json'
      ]);

      const parsed = JSON.parse(result);
      return parsed.value || null;
    } catch (error) {
      // Item not found is not an error. The `op` CLI uses different phrasings
      // depending on version / locale, so we match all known variants.
      if (error instanceof Error && isItemNotFoundError(error.message)) {
        return null;
      }
      throw error;
    }
  }

  async set(service: string, key: string, value: string, metadata?: Record<string, string>): Promise<void> {
    this.ensureVaultExists();

    const itemName = this.getItemName(service, key);
    const tags = [ITEM_PREFIX, service];

    if (metadata) {
      for (const k of Object.keys(metadata)) {
        if (!SAFE_METADATA_KEY.test(k)) {
          throw new Error(`Invalid metadata key "${k}": must match /^[a-zA-Z][a-zA-Z0-9_-]*$/`);
        }
      }
    }

    const existing = await this.get(service, key);
    const fields: Array<Record<string, string>> = [
      { id: 'credential', type: 'CONCEALED', value }
    ];
    if (metadata) {
      for (const [k, v] of Object.entries(metadata)) {
        fields.push({ id: k, type: 'STRING', value: v });
      }
    }

    // The `op` CLI's stdin path for JSON templates (`op item create -`) is
    // unreliable when invoked via Node child_process (op parses argv before
    // the spawn pipe flushes, then errors with "provide the item category").
    // The only Node-spawn-safe way to set field values without leaking them
    // on argv (visible via /proc/<pid>/cmdline on Linux) is to write the
    // template to a 0o600 file in a 0o700 mkdtemp dir, then pass --template.
    const template = existing !== null
      ? JSON.stringify({ fields })
      : JSON.stringify({
          title: itemName,
          category: 'API_CREDENTIAL',
          tags,
          fields
        });

    writeTemplateAndRun(template, (tmplPath) => {
      if (existing !== null) {
        this.runOp(['item', 'edit', itemName, '--vault', this.vault, '--template', tmplPath]);
      } else {
        // When --template provides the category in JSON, do NOT pass --category
        // on the CLI — op rejects it as a duplicate.
        this.runOp(['item', 'create', '--vault', this.vault, '--template', tmplPath]);
      }
    });
  }

  async delete(service: string, key: string): Promise<boolean> {
    const itemName = this.getItemName(service, key);

    try {
      this.runOp([
        'item', 'delete', itemName,
        '--vault', this.vault
      ]);
      return true;
    } catch (error) {
      if (error instanceof Error && isItemNotFoundError(error.message)) {
        return false;
      }
      throw error;
    }
  }

  async list(service?: string): Promise<Array<{ service: string; key: string }>> {
    try {
      const listArgs = [
        'item', 'list',
        '--vault', this.vault,
        '--tags', service ? `${ITEM_PREFIX},${service}` : ITEM_PREFIX,
        '--format', 'json'
      ];

      const result = this.runOp(listArgs);
      const items = JSON.parse(result) as Array<{ title: string }>;

      const credentials: Array<{ service: string; key: string }> = [];

      for (const item of items) {
        const parsed = this.parseItemName(item.title);
        if (parsed) {
          if (!service || parsed.service === service) {
            credentials.push(parsed);
          }
        }
      }

      return credentials;
    } catch (error) {
      // Vault or no items matching tag — both surface as "not found"-style.
      if (error instanceof Error && isItemNotFoundError(error.message)) {
        return [];
      }
      throw error;
    }
  }

  async exists(service: string, key: string): Promise<boolean> {
    const value = await this.get(service, key);
    return value !== null;
  }

  /**
   * Get the vault name being used
   */
  getVault(): string {
    return this.vault;
  }

  /**
   * Check if 1Password CLI is available and signed in
   */
  static isAvailable(): boolean {
    try {
      const whichResult = spawnSync('which', ['op'], { encoding: 'utf-8' });
      if (whichResult.status !== 0) {
        return false;
      }

      const accountResult = spawnSync('op', ['account', 'get'], { encoding: 'utf-8' });
      return accountResult.status === 0;
    } catch {
      return false;
    }
  }
}

export function createOnePasswordStore(options?: OnePasswordStoreOptions): OnePasswordStore {
  return new OnePasswordStore(options);
}
