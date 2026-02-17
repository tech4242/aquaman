/**
 * Bitwarden credential backend using the `bw` CLI
 * Requires: Bitwarden CLI installed and logged in
 *
 * Session management: Bitwarden requires an active session (BW_SESSION env var)
 * obtained via `bw unlock`. The session token is cached for the process lifetime.
 */

import { spawnSync } from 'node:child_process';
import type { CredentialStore } from '../store.js';

export interface BitwardenStoreOptions {
  /** Folder name to store aquaman credentials (created if missing) */
  folder?: string;
  /** Organization ID (optional, for org vaults) */
  organizationId?: string;
  /** Collection ID (optional, for org collections) */
  collectionId?: string;
}

const DEFAULT_FOLDER = 'aquaman';
const ITEM_PREFIX = 'aquaman';

// Metadata key validation: must start with letter, only alphanum/underscore/hyphen
const SAFE_METADATA_KEY = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export class BitwardenStore implements CredentialStore {
  private folder: string;
  private folderId: string | null = null;
  private organizationId?: string;
  private collectionId?: string;
  private session: string | null = null;
  private bwPath: string | null = null;

  constructor(options?: BitwardenStoreOptions) {
    this.folder = options?.folder || DEFAULT_FOLDER;
    this.organizationId = options?.organizationId;
    this.collectionId = options?.collectionId;
    this.validateBwCli();
  }

  private validateBwCli(): void {
    // Check if bw CLI is installed
    try {
      const result = spawnSync('which', ['bw'], { encoding: 'utf-8' });
      if (result.status !== 0) {
        throw new Error('Bitwarden CLI (bw) not found. Install from: https://bitwarden.com/help/cli/');
      }
      this.bwPath = result.stdout.trim();
    } catch {
      throw new Error('Bitwarden CLI (bw) not found. Install from: https://bitwarden.com/help/cli/');
    }

    // Check login status
    const statusResult = this.runBwRaw(['status']);
    try {
      const status = JSON.parse(statusResult);
      if (status.status === 'unauthenticated') {
        throw new Error('Not logged in to Bitwarden. Run: bw login');
      }
      if (status.status === 'locked') {
        // Try to get session from env
        const envSession = process.env['BW_SESSION'];
        if (envSession) {
          this.session = envSession;
          // Verify session is valid
          try {
            this.runBw(['sync']);
          } catch {
            throw new Error('Bitwarden vault is locked and BW_SESSION is invalid. Run: bw unlock');
          }
        } else {
          throw new Error('Bitwarden vault is locked. Run: bw unlock --raw and set BW_SESSION');
        }
      }
      // status === 'unlocked' means we're good
      if (status.status === 'unlocked') {
        // Session might still be needed for some operations
        this.session = process.env['BW_SESSION'] || null;
      }
    } catch (error) {
      if (error instanceof Error && (
        error.message.includes('Not logged in') ||
        error.message.includes('locked') ||
        error.message.includes('BW_SESSION')
      )) {
        throw error;
      }
      throw new Error('Failed to check Bitwarden status. Is the CLI installed correctly?');
    }
  }

  /**
   * Run bw command without session (for status checks)
   */
  private runBwRaw(args: string[]): string {
    try {
      const result = spawnSync('bw', args, {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024
      });

      if (result.status !== 0) {
        const error = result.stderr || result.stdout || 'Unknown error';
        throw new Error(`bw command failed: ${error}`);
      }

      return result.stdout;
    } catch (error) {
      if (error instanceof Error && error.message.includes('bw command failed')) {
        throw error;
      }
      throw new Error(`Failed to run bw command: ${error}`);
    }
  }

  /**
   * Run bw command with session token
   */
  private runBw(args: string[], input?: string): string {
    const env = { ...process.env };
    if (this.session) {
      env['BW_SESSION'] = this.session;
    }

    try {
      const result = spawnSync('bw', args, {
        encoding: 'utf-8',
        input,
        env,
        maxBuffer: 10 * 1024 * 1024
      });

      if (result.status !== 0) {
        const error = result.stderr || result.stdout || 'Unknown error';
        throw new Error(`bw command failed: ${error}`);
      }

      return result.stdout;
    } catch (error) {
      if (error instanceof Error && error.message.includes('bw command failed')) {
        throw error;
      }
      throw new Error(`Failed to run bw command: ${error}`);
    }
  }

  private getItemName(service: string, key: string): string {
    return `${ITEM_PREFIX}::${service}::${key}`;
  }

  private parseItemName(itemName: string): { service: string; key: string } | null {
    if (!itemName.startsWith(`${ITEM_PREFIX}::`)) {
      return null;
    }
    const parts = itemName.slice(ITEM_PREFIX.length + 2).split('::');
    if (parts.length < 2) {
      return null;
    }
    // Service and key can contain any characters except ::
    const service = parts[0];
    const key = parts.slice(1).join('::');
    return { service, key };
  }

  private async ensureFolderExists(): Promise<string> {
    if (this.folderId) {
      return this.folderId;
    }

    // List existing folders
    try {
      const foldersJson = this.runBw(['list', 'folders']);
      const folders = JSON.parse(foldersJson) as Array<{ id: string; name: string }>;

      const existing = folders.find(f => f.name === this.folder);
      if (existing) {
        this.folderId = existing.id;
        return this.folderId;
      }
    } catch {
      // Folder list failed, try to create anyway
    }

    // Create folder
    try {
      // Bitwarden requires base64-encoded JSON for folder creation
      const folderData = JSON.stringify({ name: this.folder });
      const encoded = Buffer.from(folderData).toString('base64');
      const result = this.runBw(['create', 'folder', encoded]);
      const created = JSON.parse(result) as { id: string };
      this.folderId = created.id;
      console.log(`Created Bitwarden folder: ${this.folder}`);
      return this.folderId;
    } catch (createError) {
      throw new Error(`Failed to create folder "${this.folder}": ${createError}`);
    }
  }

  /**
   * Find an item by name in the aquaman folder
   */
  private findItem(itemName: string): { id: string; login?: { password?: string } } | null {
    try {
      // Search for item by name
      const result = this.runBw(['list', 'items', '--search', itemName]);
      const items = JSON.parse(result) as Array<{
        id: string;
        name: string;
        folderId?: string;
        login?: { password?: string };
      }>;

      // Find exact match in our folder
      const match = items.find(item =>
        item.name === itemName &&
        (this.folderId ? item.folderId === this.folderId : true)
      );

      return match || null;
    } catch {
      return null;
    }
  }

  async get(service: string, key: string): Promise<string | null> {
    const itemName = this.getItemName(service, key);
    const item = this.findItem(itemName);

    if (!item) {
      return null;
    }

    // Get full item details (search doesn't include password by default)
    try {
      const result = this.runBw(['get', 'item', item.id]);
      const fullItem = JSON.parse(result) as {
        login?: { password?: string };
        notes?: string;
      };

      // Prefer login.password, fall back to notes
      return fullItem.login?.password || fullItem.notes || null;
    } catch {
      return null;
    }
  }

  async set(service: string, key: string, value: string, metadata?: Record<string, string>): Promise<void> {
    const folderId = await this.ensureFolderExists();
    const itemName = this.getItemName(service, key);

    // Check if item already exists
    const existing = this.findItem(itemName);

    // Build notes from metadata
    let notes = '';
    if (metadata) {
      for (const [k, v] of Object.entries(metadata)) {
        if (!SAFE_METADATA_KEY.test(k)) {
          throw new Error(`Invalid metadata key "${k}": must match /^[a-zA-Z][a-zA-Z0-9_-]*$/`);
        }
        notes += `${k}: ${v}\n`;
      }
    }

    if (existing) {
      // Update existing item
      // First get full item, modify, then edit
      try {
        const fullItemJson = this.runBw(['get', 'item', existing.id]);
        const fullItem = JSON.parse(fullItemJson);

        // Update the password
        if (!fullItem.login) {
          fullItem.login = {};
        }
        fullItem.login.password = value;
        if (notes) {
          fullItem.notes = notes;
        }

        // Encode and edit — use stdin to avoid exposing credential in process arguments
        const encoded = Buffer.from(JSON.stringify(fullItem)).toString('base64');
        this.runBw(['edit', 'item', existing.id], encoded);
      } catch (error) {
        throw new Error(`Failed to update credential: ${error}`);
      }
    } else {
      // Create new item
      const newItem: any = {
        type: 1, // Login type
        name: itemName,
        folderId,
        login: {
          password: value
        },
        notes: notes || undefined
      };

      // Add organization/collection if configured
      if (this.organizationId) {
        newItem.organizationId = this.organizationId;
      }
      if (this.collectionId) {
        newItem.collectionIds = [this.collectionId];
      }

      try {
        const encoded = Buffer.from(JSON.stringify(newItem)).toString('base64');
        // Use stdin to avoid exposing credential in process arguments
        this.runBw(['create', 'item'], encoded);
      } catch (error) {
        throw new Error(`Failed to create credential: ${error}`);
      }
    }

    // Sync to ensure changes are persisted
    try {
      this.runBw(['sync']);
    } catch {
      // Sync failure is non-fatal
    }
  }

  async delete(service: string, key: string): Promise<boolean> {
    const itemName = this.getItemName(service, key);
    const item = this.findItem(itemName);

    if (!item) {
      return false;
    }

    try {
      this.runBw(['delete', 'item', item.id]);

      // Sync to ensure deletion is persisted
      try {
        this.runBw(['sync']);
      } catch {
        // Sync failure is non-fatal
      }

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
      // List all items, filter by folder if we have one
      let args = ['list', 'items'];
      if (this.folderId) {
        args.push('--folderid', this.folderId);
      }

      const result = this.runBw(args);
      const items = JSON.parse(result) as Array<{ name: string }>;

      const credentials: Array<{ service: string; key: string }> = [];

      for (const item of items) {
        const parsed = this.parseItemName(item.name);
        if (parsed) {
          if (!service || parsed.service === service) {
            credentials.push(parsed);
          }
        }
      }

      return credentials;
    } catch (error) {
      // Empty folder or no access
      if (error instanceof Error && error.message.includes('not found')) {
        return [];
      }
      throw error;
    }
  }

  async exists(service: string, key: string): Promise<boolean> {
    const itemName = this.getItemName(service, key);
    return this.findItem(itemName) !== null;
  }

  /**
   * Get the folder name being used
   */
  getFolder(): string {
    return this.folder;
  }

  /**
   * Check if Bitwarden CLI is available and unlocked
   */
  static isAvailable(): boolean {
    try {
      const whichResult = spawnSync('which', ['bw'], { encoding: 'utf-8' });
      if (whichResult.status !== 0) {
        return false;
      }

      const statusResult = spawnSync('bw', ['status'], { encoding: 'utf-8' });
      if (statusResult.status !== 0) {
        return false;
      }

      const status = JSON.parse(statusResult.stdout);
      // Available if logged in (locked or unlocked)
      return status.status !== 'unauthenticated';
    } catch {
      return false;
    }
  }

  /**
   * Check if vault is unlocked (ready for use)
   */
  static isUnlocked(): boolean {
    try {
      const statusResult = spawnSync('bw', ['status'], { encoding: 'utf-8' });
      if (statusResult.status !== 0) {
        return false;
      }

      const status = JSON.parse(statusResult.stdout);

      if (status.status === 'unlocked') {
        return true;
      }

      // Check if BW_SESSION is set and valid
      if (status.status === 'locked' && process.env['BW_SESSION']) {
        const syncResult = spawnSync('bw', ['sync'], {
          encoding: 'utf-8',
          env: { ...process.env }
        });
        return syncResult.status === 0;
      }

      return false;
    } catch {
      return false;
    }
  }
}

export function createBitwardenStore(options?: BitwardenStoreOptions): BitwardenStore {
  return new BitwardenStore(options);
}
