/**
 * Bitwarden credential backend using the `bw` CLI
 * Requires: Bitwarden CLI installed and logged in
 *
 * Session management: `bw` opens the vault with a session key that
 * `bw unlock` prints after a person typed the master password. This store
 * takes one from `BW_SESSION` in the environment it starts in, and a serving
 * process (`serving: true`) can also be handed one later (`adoptSession`,
 * reached through `aquaman unlock`). The session is kept in memory only and
 * goes to `bw` in its environment, never in its arguments.
 *
 * A serving process treats a locked vault as a state: it starts without a
 * session, and a session `bw` stops accepting (`bw lock`, `bw logout`, a
 * later `bw unlock`) puts it back there. Every read then throws
 * `VaultLockedError`. A one-shot command still refuses to start locked.
 */

import { spawnSync } from 'node:child_process';
import type { CredentialStore } from '../store.js';
import type { ParsedLocator } from '../links.js';
import { VaultLockedError, isVaultLocked, type SessionAdoption, type VaultState } from '../vault-lock.js';

export interface BitwardenStoreOptions {
  /** Folder name to store aquaman credentials (created if missing) */
  folder?: string;
  /** Organization ID (optional, for org vaults) */
  organizationId?: string;
  /** Collection ID (optional, for org collections) */
  collectionId?: string;
  /**
   * For a process that serves requests: start even when the vault is locked
   * or `bw` is logged out, and accept a session later.
   */
  serving?: boolean;
}

const DEFAULT_FOLDER = 'aquaman';
const ITEM_PREFIX = 'aquaman';

// Metadata key validation: must start with letter, only alphanum/underscore/hyphen
const SAFE_METADATA_KEY = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const BW_ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A session key is base64 text. Anything else is refused before `bw` is run,
 * so a caller cannot make this process start `bw` once per junk request or
 * put a line break into its environment.
 */
const SESSION_SHAPE = /^[A-Za-z0-9+/]{16,512}={0,2}$/;

/** What `bw` prints when a command needs the vault and it is not open, or nobody is logged in. */
const BW_LOCKED_OUTPUT = /Vault is locked\.|You are not logged in\./;

const SHELL_UNLOCK_FIX = 'Run: export BW_SESSION=$(bw unlock --raw)';

interface BwStatus {
  status: 'unauthenticated' | 'locked' | 'unlocked';
  userId: string | null;
}

export class BitwardenStore implements CredentialStore {
  private folder: string;
  private folderId: string | null = null;
  private organizationId?: string;
  private collectionId?: string;
  private session: string | null = null;
  private bwPath: string | null = null;
  private serving: boolean;
  private locked = false;
  /**
   * The account `bw` was logged in to when this process first saw one. A
   * session is only adopted for that account: handing one over must not be a
   * way to point a running daemon at a different vault.
   */
  private userId: string | null = null;

  constructor(options?: BitwardenStoreOptions) {
    this.folder = options?.folder || DEFAULT_FOLDER;
    this.organizationId = options?.organizationId;
    this.collectionId = options?.collectionId;
    this.serving = options?.serving === true;
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

    const envSession = process.env['BW_SESSION'] || null;
    // A `bw` that fails or cannot be started says so in its own words.
    const printed = this.runStatus(envSession);
    let status: BwStatus;
    try {
      status = this.parseStatus(printed);
    } catch {
      throw new Error('Failed to check Bitwarden status. Is the CLI installed correctly?');
    }
    this.userId = status.userId;

    if (status.status === 'unlocked') {
      this.session = envSession;
      return;
    }
    if (status.status === 'locked' && envSession) {
      // `bw status` did not open the vault with this session; a sync is the second opinion.
      this.session = envSession;
      try {
        this.runBw(['sync']);
        return;
      } catch {
        this.session = null;
        if (!this.serving) throw new VaultLockedError('Bitwarden vault is locked and BW_SESSION is invalid. Run: bw unlock', SHELL_UNLOCK_FIX);
      }
    }
    if (!this.serving) {
      if (status.status === 'unauthenticated') throw new Error('Not logged in to Bitwarden. Run: bw login');
      throw new VaultLockedError('Bitwarden vault is locked. Run: bw unlock --raw and set BW_SESSION', SHELL_UNLOCK_FIX);
    }
    this.locked = true;
  }

  /**
   * The environment `bw` runs in. The session is the one this store holds and
   * nothing else: a `BW_SESSION` left in the process environment is not
   * passed on once the store has let go of it. `BW_NOINTERACTION` is what
   * bw's `--nointeraction` option sets: with it a locked vault is an error
   * ("Vault is locked.") instead of a master password prompt nobody can see.
   */
  private bwEnv(session: string | null): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, BW_NOINTERACTION: 'true' };
    delete env['BW_SESSION'];
    if (session) env['BW_SESSION'] = session;
    return env;
  }

  /** `bw status` under the given session. Throws when `bw` cannot be run or does not answer with a status. */
  private readStatus(session: string | null): BwStatus {
    return this.parseStatus(this.runStatus(session));
  }

  /** What `bw status` printed under the given session. */
  private runStatus(session: string | null): string {
    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync('bw', ['status'], {
        encoding: 'utf-8',
        env: this.bwEnv(session),
        maxBuffer: 1024 * 1024
      });
    } catch (error) {
      throw new Error(`Failed to run bw command: ${error}`);
    }
    if (result.status !== 0) {
      throw new Error(`bw command failed: ${String(result.stderr || result.stdout || 'Unknown error')}`);
    }
    return String(result.stdout);
  }

  private parseStatus(printed: string): BwStatus {
    const parsed = JSON.parse(printed) as { status?: unknown; userId?: unknown };
    if (parsed.status !== 'unauthenticated' && parsed.status !== 'locked' && parsed.status !== 'unlocked') {
      throw new Error('bw status returned no status');
    }
    return { status: parsed.status, userId: typeof parsed.userId === 'string' && parsed.userId ? parsed.userId : null };
  }

  private lockedError(): VaultLockedError {
    return this.serving
      ? new VaultLockedError('The Bitwarden vault is locked, so the proxy cannot read credentials. Run: aquaman unlock')
      : new VaultLockedError('Bitwarden vault is locked. Run: bw unlock --raw and set BW_SESSION', SHELL_UNLOCK_FIX);
  }

  /** Let go of the session and everything read under it. */
  private markLocked(): void {
    this.session = null;
    this.folderId = null;
    this.locked = true;
  }

  /** Whether reads would be refused right now. It does not ask `bw`: see `checkSession()`. */
  vaultState(): VaultState {
    return this.locked ? 'locked' : 'unlocked';
  }

  /**
   * Take a session. It is checked with `bw status` first: only a session
   * under which `bw` reports the vault unlocked, for the account this
   * process started with, replaces what the store holds. A refused session
   * changes nothing, so a caller cannot lock a working daemon with junk.
   */
  async adoptSession(session: string): Promise<SessionAdoption> {
    const again = 'Run: aquaman unlock';
    if (typeof session !== 'string' || !SESSION_SHAPE.test(session)) {
      return { ok: false, code: 'session_malformed', error: 'That is not a Bitwarden session key', fix: again };
    }
    let status: BwStatus;
    try {
      status = this.readStatus(session);
    } catch {
      return { ok: false, code: 'vault_cli_failed', error: 'The Bitwarden CLI could not be asked about the session', fix: 'Check that `bw status` works in a terminal, then run: aquaman unlock' };
    }
    if (status.status === 'unauthenticated') {
      return { ok: false, code: 'not_logged_in', error: 'The Bitwarden CLI is not logged in', fix: 'Run: bw login  and then: aquaman unlock' };
    }
    if (status.status !== 'unlocked') {
      return { ok: false, code: 'session_refused', error: 'The Bitwarden CLI does not open the vault with that session', fix: again };
    }
    // A status that names no account cannot be told from another account's.
    if (this.userId !== null && status.userId !== this.userId) {
      return {
        ok: false,
        code: 'account_changed',
        error: 'The Bitwarden CLI is logged in to a different account than the one this proxy started with',
        fix: 'Restart the proxy (aquaman stop, then start it again) and run: aquaman unlock',
      };
    }
    if (this.userId === null) this.userId = status.userId;
    this.session = session;
    this.folderId = null;
    this.locked = false;
    return { ok: true };
  }

  /**
   * Ask `bw` whether the session this store holds still opens the vault, and
   * become locked if it does not. Throws when `bw` cannot be asked.
   */
  async checkSession(): Promise<VaultState> {
    if (this.locked) return 'locked';
    if (this.readStatus(this.session).status !== 'unlocked') this.markLocked();
    return this.vaultState();
  }

  /**
   * Drop the session from this process, including the copy it was started
   * with. `bw` is not told: the session key stays valid for anything else
   * that holds it until `bw lock` or `bw logout`.
   */
  forgetSession(): void {
    this.markLocked();
    delete process.env['BW_SESSION'];
  }

  /**
   * Run bw command with session token
   */
  private runBw(args: string[], input?: string): string {
    if (this.locked) throw this.lockedError();

    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync('bw', args, {
        encoding: 'utf-8',
        input,
        env: this.bwEnv(this.session),
        maxBuffer: 10 * 1024 * 1024
      });
    } catch (error) {
      throw new Error(`Failed to run bw command: ${error}`);
    }

    if (result.status !== 0) {
      const error = String(result.stderr || result.stdout || 'Unknown error');
      // The session this store holds no longer opens the vault. From here on
      // that is the locked state, with its own fix, not a failed command.
      if (BW_LOCKED_OUTPUT.test(error)) {
        this.markLocked();
        throw this.lockedError();
      }
      throw new Error(`bw command failed: ${error}`);
    }

    return String(result.stdout);
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
    } catch (error) {
      if (isVaultLocked(error)) throw error;
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
      if (isVaultLocked(createError)) throw createError;
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
    } catch (error) {
      // A locked vault is not a missing item.
      if (isVaultLocked(error)) throw error;
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
    } catch (error) {
      if (isVaultLocked(error)) throw error;
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
        if (isVaultLocked(error)) throw error;
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
        if (isVaultLocked(error)) throw error;
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
   * An item aquaman did not write: by id, or by a name that exactly one item
   * has. The name is one argument after `--search`, never part of a command.
   */
  async readLinked(locator: ParsedLocator): Promise<string | null> {
    const [item] = locator.path;
    let id = item;
    if (!BW_ITEM_ID.test(item)) {
      const found = JSON.parse(this.runBw(['list', 'items', '--search', item])) as Array<{ id: string; name: string }>;
      const exact = found.filter((i) => i.name === item);
      if (exact.length === 0) return null;
      if (exact.length > 1) {
        throw new Error(`${exact.length} Bitwarden items are named "${item}". Link by item id instead: bw://<item id>/${locator.field}`);
      }
      id = exact[0].id;
    }
    let full: { name?: unknown; login?: Record<string, unknown>; notes?: unknown; fields?: Array<{ name?: unknown; value?: unknown }> };
    try {
      full = JSON.parse(this.runBw(['get', 'item', id]));
    } catch (error) {
      if (error instanceof Error && /not found/i.test(error.message)) return null;
      throw error;
    }
    // Items named `aquaman::...` are the ones aquaman wrote. They are reached
    // by their own reference, never under a second name.
    if (typeof full.name === 'string' && full.name.startsWith(`${ITEM_PREFIX}::`)) {
      throw new Error(`${locator.text} names an item aquaman itself wrote; use that credential by its own reference`);
    }
    let value: unknown;
    if (locator.field === 'password' || locator.field === 'username') value = full.login?.[locator.field];
    else if (locator.field === 'notes') value = full.notes;
    else value = (Array.isArray(full.fields) ? full.fields : []).find((f) => f?.name === locator.field)?.value;
    return typeof value === 'string' && value.length > 0 ? value : null;
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
