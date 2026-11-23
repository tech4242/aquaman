/**
 * Credential storage interface with multiple backend support
 * Supports: macOS Keychain, 1Password, HashiCorp Vault, encrypted file
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { encryptWithPassword, decryptWithPassword } from '../utils/hash.js';
import { getConfigDir, getConfigPath } from '../utils/config.js';
import type { CredentialBackend } from '../types.js';
import { KeePassXCStore } from './backends/keepassxc.js';
import { createLinkSource, type LinkChange, type ParsedLocator } from './links.js';
import { LinkedStore } from './linked-store.js';
import { SystemdCredsStore } from './backends/systemd-creds.js';
import type { SessionAdoption, VaultState } from './vault-lock.js';

export type { ParsedLocator, SessionAdoption, VaultState };

export interface Credential {
  service: string;
  key: string;
  value: string;
  metadata?: Record<string, string>;
  createdAt: Date;
  lastUsed?: Date;
  rotateAfter?: Date;
}

export interface CredentialStore {
  get(service: string, key: string): Promise<string | null>;
  set(service: string, key: string, value: string, metadata?: Record<string, string>): Promise<void>;
  delete(service: string, key: string): Promise<boolean>;
  /** `linked` is the locator of the vault item a reference is read from, when it is a link. */
  list(service?: string): Promise<Array<{ service: string; key: string; linked?: string }>>;
  exists(service: string, key: string): Promise<boolean>;
  /**
   * Read an item aquaman did not write, named by a parsed locator of this
   * backend's scheme. `null` when there is no such item or field. Backends
   * that hold only what aquaman wrote do not have this.
   */
  readLinked?(locator: ParsedLocator): Promise<string | null>;
  /** The locator a reference is linked to right now, or `''`. A cache uses it to notice a link that changed. */
  linkStamp?(service: string, key: string): string;
  /** Link approvals, on a store that honours links (`LinkedStore`) and on wrappers around one. */
  approveLink?(service: string, key: string, locator: string): Promise<void>;
  revokeLink?(service: string, key: string): Promise<boolean>;
  linkApproved?(name: string, locator: string): Promise<boolean>;
  /**
   * The backend's own name for the item it keeps a reference in, on a backend
   * where two references can be one item because service and key are joined
   * into a single name (`a-b` + `c` and `a` + `b-c`). Whatever decides by
   * `<service>/<key>` who may be handed a value compares this as well, so a
   * rule set on one name holds for every name of the same item. Answered
   * from memory, and never from `credentials.links`: a line in config.yaml
   * does not change what the backend calls its item. Absent where each
   * reference is its own item.
   */
  itemIdentity?(service: string, key: string): string;
  /**
   * On a store that honours links, the locators a reference has to do with:
   * `reads` is the item it is read from right now (linked in config.yaml and
   * approved in the vault; `''` when it is read from the backend's own item),
   * and `approved` is the locator a person approved for this reference,
   * whatever config.yaml says at the moment. An unapproved line is neither:
   * it reads nothing, so it does not make a reference into another item.
   */
  linkIdentities?(service: string, key: string): Promise<{ reads: string; approved: string }>;
  /**
   * On a backend that a person's session opens (`bitwarden`), and on
   * wrappers around one; see vault-lock.ts. Absent everywhere else.
   * `vaultState` answers from memory, `checkSession` asks the vault's CLI.
   */
  vaultState?(): VaultState;
  adoptSession?(session: string): Promise<SessionAdoption>;
  checkSession?(): Promise<VaultState>;
  forgetSession?(): void;
}

export interface CredentialStoreOptions {
  backend: CredentialBackend;
  encryptionPassword?: string;
  // HashiCorp Vault options
  vaultAddress?: string;
  vaultToken?: string;
  vaultNamespace?: string;
  vaultMountPath?: string;
  // 1Password options
  onePasswordVault?: string;
  onePasswordAccount?: string;
  // KeePassXC options
  keepassxcDatabasePath?: string;
  keepassxcKeyFilePath?: string;
  // Bitwarden options
  bitwardenFolder?: string;
  bitwardenOrganizationId?: string;
  bitwardenCollectionId?: string;
  // systemd-creds options
  systemdCredsDir?: string;
  // Keeper options
  keeperFolderUid?: string;
  keeperConfigPath?: string;
  /**
   * Links (`credentials.links`): `'always'` for a process that outlives the
   * config it started with, so a link made later is honoured; `false` for the
   * bare backend. By default the store is link-aware when the config has links.
   */
  links?: 'always' | false;
  /**
   * For a process that serves requests. A backend that a person's session
   * opens then starts locked instead of refusing to start (vault-lock.ts).
   */
  serving?: boolean;
  /** The config.yaml that holds `credentials.links`. Default: the active config file. */
  linksConfigPath?: string;
  /** Told when a link appears, goes away or is re-pointed while the process runs. */
  onLinkChange?: (change: LinkChange) => void;
}

/**
 * macOS Keychain backend using the keytar library
 */
export class KeychainStore implements CredentialStore {
  private keytar: any = null;
  private servicePrefix = 'aquaman';
  private indexService = 'aquaman/_index';
  private indexAccount = 'services';

  private async getKeytar(): Promise<typeof import('keytar')> {
    if (!this.keytar) {
      try {
        const mod: any = await import('keytar');
        this.keytar = mod.default || mod;
      } catch {
        throw new Error('keytar not available - install with: npm install keytar');
      }
    }
    return this.keytar;
  }

  private getServiceName(service: string): string {
    return `${this.servicePrefix}/${service}`;
  }

  private async getIndex(): Promise<string[]> {
    const keytar = await this.getKeytar();
    const raw = await keytar.getPassword(this.indexService, this.indexAccount);
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
  }

  private async updateIndex(services: string[]): Promise<void> {
    const keytar = await this.getKeytar();
    await keytar.setPassword(this.indexService, this.indexAccount, JSON.stringify(services));
  }

  async get(service: string, key: string): Promise<string | null> {
    const keytar = await this.getKeytar();
    return keytar.getPassword(this.getServiceName(service), key);
  }

  async set(service: string, key: string, value: string): Promise<void> {
    const keytar = await this.getKeytar();
    await keytar.setPassword(this.getServiceName(service), key, value);

    const index = await this.getIndex();
    if (!index.includes(service)) {
      index.push(service);
      await this.updateIndex(index);
    }
  }

  async delete(service: string, key: string): Promise<boolean> {
    const keytar = await this.getKeytar();
    const deleted = await keytar.deletePassword(this.getServiceName(service), key);

    if (deleted) {
      const remaining = await keytar.findCredentials(this.getServiceName(service));
      if (remaining.length === 0) {
        const index = await this.getIndex();
        const updated = index.filter((s: string) => s !== service);
        await this.updateIndex(updated);
      }
    }

    return deleted;
  }

  async list(): Promise<Array<{ service: string; key: string }>> {
    const keytar = await this.getKeytar();
    const index = await this.getIndex();
    const results: Array<{ service: string; key: string }> = [];

    for (const service of index) {
      const creds = await keytar.findCredentials(this.getServiceName(service));
      for (const cred of creds) {
        results.push({ service, key: cred.account });
      }
    }

    return results;
  }

  async exists(service: string, key: string): Promise<boolean> {
    const value = await this.get(service, key);
    return value !== null;
  }

  /** A generic password aquaman did not write: `keychain://<service>/<account>`. */
  async readLinked(locator: ParsedLocator): Promise<string | null> {
    const keytar = await this.getKeytar();
    return keytar.getPassword(locator.path[0], locator.field);
  }
}

/**
 * Encrypted file backend - fallback option
 */
export class EncryptedFileStore implements CredentialStore {
  private filePath: string;
  private password: string;
  private cache: Map<string, Credential> | null = null;
  /** Identity of the file the cache was read from, so a write by another process is noticed. */
  private cacheStamp = '';

  constructor(password: string, filePath?: string) {
    this.password = password;
    this.filePath = filePath || path.join(os.homedir(), '.aquaman', 'credentials.enc');
  }

  private getKey(service: string, key: string): string {
    return `${service}:${key}`;
  }

  /** Size, modification time and inode of the file, or `''` when it does not exist. */
  private fileStamp(): string {
    try {
      const st = fs.statSync(this.filePath);
      return `${st.size}:${st.mtimeMs}:${st.ino}`;
    } catch {
      return '';
    }
  }

  // A long-running daemon and the CLI are separate processes sharing this
  // file. The decrypted copy is kept only while the file is the one it was
  // read from, so `aquaman credentials add` takes effect in a running daemon
  // and a write here starts from what another process last saved. There is
  // no lock: two writes in the same instant can still lose one of them.
  private async load(): Promise<Map<string, Credential>> {
    const stamp = this.fileStamp();
    if (this.cache && stamp === this.cacheStamp) {
      return this.cache;
    }

    if (stamp === '') {
      this.cache = new Map();
      this.cacheStamp = '';
      return this.cache;
    }

    try {
      const encrypted = fs.readFileSync(this.filePath, 'utf-8');
      const decrypted = decryptWithPassword(encrypted, this.password);
      const data = JSON.parse(decrypted) as Record<string, Credential>;

      this.cache = new Map(Object.entries(data));
      this.cacheStamp = stamp;
      return this.cache;
    } catch {
      throw new Error('Failed to decrypt credentials file - wrong password?');
    }
  }

  private async save(): Promise<void> {
    if (!this.cache) return;

    const data: Record<string, Credential> = {};
    for (const [key, cred] of this.cache.entries()) {
      data[key] = cred;
    }

    const json = JSON.stringify(data, null, 2);
    const encrypted = encryptWithPassword(json, this.password);

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Written beside the file and renamed over it, so a reader in another
    // process sees the old contents or the new, never part of each.
    // The name is unguessable and the open fails if anything is already
    // there, so the write cannot be steered through a planted link.
    const tmp = `${this.filePath}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, encrypted, { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    this.cacheStamp = this.fileStamp();
  }

  async get(service: string, key: string): Promise<string | null> {
    const store = await this.load();
    const cred = store.get(this.getKey(service, key));
    return cred?.value ?? null;
  }

  async set(
    service: string,
    key: string,
    value: string,
    metadata?: Record<string, string>
  ): Promise<void> {
    const store = await this.load();
    const credential: Credential = {
      service,
      key,
      value,
      metadata,
      createdAt: new Date()
    };
    store.set(this.getKey(service, key), credential);
    await this.save();
  }

  async delete(service: string, key: string): Promise<boolean> {
    const store = await this.load();
    const deleted = store.delete(this.getKey(service, key));
    if (deleted) {
      await this.save();
    }
    return deleted;
  }

  async list(service?: string): Promise<Array<{ service: string; key: string }>> {
    const store = await this.load();
    const results: Array<{ service: string; key: string }> = [];

    for (const cred of store.values()) {
      if (!service || cred.service === service) {
        results.push({ service: cred.service, key: cred.key });
      }
    }

    return results;
  }

  async exists(service: string, key: string): Promise<boolean> {
    const store = await this.load();
    return store.has(this.getKey(service, key));
  }
}

/**
 * In-memory store for testing
 */
export class MemoryStore implements CredentialStore {
  private store = new Map<string, Credential>();

  private getKey(service: string, key: string): string {
    return `${service}:${key}`;
  }

  async get(service: string, key: string): Promise<string | null> {
    return this.store.get(this.getKey(service, key))?.value ?? null;
  }

  async set(
    service: string,
    key: string,
    value: string,
    metadata?: Record<string, string>
  ): Promise<void> {
    this.store.set(this.getKey(service, key), {
      service,
      key,
      value,
      metadata,
      createdAt: new Date()
    });
  }

  async delete(service: string, key: string): Promise<boolean> {
    return this.store.delete(this.getKey(service, key));
  }

  async list(service?: string): Promise<Array<{ service: string; key: string }>> {
    const results: Array<{ service: string; key: string }> = [];
    for (const cred of this.store.values()) {
      if (!service || cred.service === service) {
        results.push({ service: cred.service, key: cred.key });
      }
    }
    return results;
  }

  async exists(service: string, key: string): Promise<boolean> {
    return this.store.has(this.getKey(service, key));
  }

  clear(): void {
    this.store.clear();
  }
}

/**
 * Validate encryption password strength for encrypted-file backend.
 */
export function validatePasswordStrength(password: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!password) {
    errors.push('Password must not be empty');
  } else if (password.length < 12) {
    errors.push(`Password must be at least 12 characters (got ${password.length})`);
  }
  return { valid: errors.length === 0, errors };
}

/**
 * The store for the configured backend, link-aware when it needs to be: a
 * reference listed in `credentials.links` is read from the vault item it
 * names, and is never written or deleted through aquaman.
 */
export async function createCredentialStore(options: CredentialStoreOptions): Promise<CredentialStore> {
  const store = await createBackendStore(options);
  if (options.links === false) return store;
  const links = createLinkSource(options.linksConfigPath ?? getConfigPath(), options.onLinkChange);
  if (options.links !== 'always' && links().size === 0) return store;
  return new LinkedStore(store, options.backend, links);
}

async function createBackendStore(options: CredentialStoreOptions): Promise<CredentialStore> {
  switch (options.backend) {
    case 'keychain':
      return new KeychainStore();

    case 'encrypted-file':
      if (!options.encryptionPassword) {
        throw new Error('encryptionPassword required for encrypted-file backend');
      }
      {
        const strength = validatePasswordStrength(options.encryptionPassword);
        if (!strength.valid) {
          throw new Error(`Weak encryption password: ${strength.errors.join('; ')}`);
        }
      }
      return new EncryptedFileStore(
        options.encryptionPassword,
        path.join(getConfigDir(), 'credentials.enc')
      );

    case '1password': {
      const { OnePasswordStore } = await import('./backends/onepassword.js');
      return new OnePasswordStore({
        vault: options.onePasswordVault,
        account: options.onePasswordAccount
      });
    }

    case 'vault': {
      if (!options.vaultAddress) {
        // Try env var
        const envAddress = process.env['VAULT_ADDR'];
        if (!envAddress) {
          throw new Error('vaultAddress required for vault backend. Set via config or VAULT_ADDR env var.');
        }
        options.vaultAddress = envAddress;
      }

      const { VaultStore } = await import('./backends/vault.js');
      return new VaultStore({
        address: options.vaultAddress,
        token: options.vaultToken,
        namespace: options.vaultNamespace,
        mountPath: options.vaultMountPath
      });
    }

    case 'keepassxc': {
      const dbPath = options.keepassxcDatabasePath
        || path.join(getConfigDir(), 'credentials.kdbx');
      const password = options.encryptionPassword
        || process.env['AQUAMAN_KEEPASS_PASSWORD'];
      const keyFile = options.keepassxcKeyFilePath;
      if (!password && !keyFile) {
        throw new Error('KeePassXC backend requires a master password (AQUAMAN_KEEPASS_PASSWORD) or key file (keepassxcKeyFilePath)');
      }
      return new KeePassXCStore({ dbPath, password, keyFilePath: keyFile });
    }

    case 'bitwarden': {
      // Dynamically import to avoid loading if not used
      const { BitwardenStore } = await import('./backends/bitwarden.js');
      return new BitwardenStore({
        folder: options.bitwardenFolder,
        organizationId: options.bitwardenOrganizationId,
        collectionId: options.bitwardenCollectionId,
        serving: options.serving
      });
    }

    case 'keeper': {
      const { KeeperStore } = await import('./backends/keeper.js');
      return new KeeperStore({
        folderUid: options.keeperFolderUid || process.env['AQUAMAN_KEEPER_FOLDER_UID'] || '',
        configPath: options.keeperConfigPath || process.env['AQUAMAN_KEEPER_CONFIG'],
      });
    }

    case 'systemd-creds': {
      return new SystemdCredsStore({
        credsDir: options.systemdCredsDir,
      });
    }

    default:
      throw new Error(`Unknown credential backend: ${options.backend}`);
  }
}
