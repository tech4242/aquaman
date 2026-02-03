/**
 * 1Password credential backend using the `op` CLI
 * Requires: 1Password CLI installed and signed in
 */

import { execSync, spawnSync } from 'node:child_process';
import type { CredentialStore } from '../store.js';

export interface OnePasswordStoreOptions {
  vault?: string;
  account?: string;
}

const DEFAULT_VAULT = 'aquaman-clawed';
const ITEM_PREFIX = 'aquaman';

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
      // Item not found is not an error
      if (error instanceof Error && error.message.includes('not found')) {
        return null;
      }
      throw error;
    }
  }

  async set(service: string, key: string, value: string, metadata?: Record<string, string>): Promise<void> {
    this.ensureVaultExists();

    const itemName = this.getItemName(service, key);
    const tags = [ITEM_PREFIX, service];

    // Check if item already exists
    const existing = await this.get(service, key);

    if (existing !== null) {
      // Update existing item
      this.runOp([
        'item', 'edit', itemName,
        '--vault', this.vault,
        `credential=${value}`
      ]);
    } else {
      // Create new item
      const createArgs = [
        'item', 'create',
        '--category', 'API Credential',
        '--vault', this.vault,
        '--title', itemName,
        `credential=${value}`,
        '--tags', tags.join(',')
      ];

      // Add metadata as fields
      if (metadata) {
        for (const [k, v] of Object.entries(metadata)) {
          createArgs.push(`${k}=${v}`);
        }
      }

      this.runOp(createArgs);
    }
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
      if (error instanceof Error && error.message.includes('not found')) {
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
      // Vault might not exist yet
      if (error instanceof Error && error.message.includes('not found')) {
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
