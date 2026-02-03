/**
 * Credential storage interface with multiple backend support
 * Supports: macOS Keychain, 1Password, HashiCorp Vault, encrypted file
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { encryptWithPassword, decryptWithPassword } from '../utils/hash.js';

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
  list(service?: string): Promise<Array<{ service: string; key: string }>>;
  exists(service: string, key: string): Promise<boolean>;
}

export type CredentialBackend = 'keychain' | '1password' | 'vault' | 'encrypted-file';

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
}

/**
 * macOS Keychain backend using the keytar library
 */
export class KeychainStore implements CredentialStore {
  private keytar: typeof import('keytar') | null = null;
  private serviceName = 'aquaman-clawed';

  private async getKeytar(): Promise<typeof import('keytar')> {
    if (!this.keytar) {
      try {
        this.keytar = await import('keytar');
      } catch {
        throw new Error('keytar not available - install with: npm install keytar');
      }
    }
    return this.keytar;
  }

  async get(service: string, key: string): Promise<string | null> {
    const keytar = await this.getKeytar();
    const account = `${service}:${key}`;
    return keytar.getPassword(this.serviceName, account);
  }

  async set(service: string, key: string, value: string): Promise<void> {
    const keytar = await this.getKeytar();
    const account = `${service}:${key}`;
    await keytar.setPassword(this.serviceName, account, value);
  }

  async delete(service: string, key: string): Promise<boolean> {
    const keytar = await this.getKeytar();
    const account = `${service}:${key}`;
    return keytar.deletePassword(this.serviceName, account);
  }

  async list(): Promise<Array<{ service: string; key: string }>> {
    const keytar = await this.getKeytar();
    const credentials = await keytar.findCredentials(this.serviceName);
    return credentials.map(cred => {
      const [service, key] = cred.account.split(':');
      return { service: service || cred.account, key: key || '' };
    });
  }

  async exists(service: string, key: string): Promise<boolean> {
    const value = await this.get(service, key);
    return value !== null;
  }
}

/**
 * Encrypted file backend - fallback option
 */
export class EncryptedFileStore implements CredentialStore {
  private filePath: string;
  private password: string;
  private cache: Map<string, Credential> | null = null;

  constructor(password: string, filePath?: string) {
    this.password = password;
    this.filePath = filePath || path.join(os.homedir(), '.aquaman', 'credentials.enc');
  }

  private getKey(service: string, key: string): string {
    return `${service}:${key}`;
  }

  private async load(): Promise<Map<string, Credential>> {
    if (this.cache) {
      return this.cache;
    }

    if (!fs.existsSync(this.filePath)) {
      this.cache = new Map();
      return this.cache;
    }

    try {
      const encrypted = fs.readFileSync(this.filePath, 'utf-8');
      const decrypted = decryptWithPassword(encrypted, this.password);
      const data = JSON.parse(decrypted) as Record<string, Credential>;

      this.cache = new Map(Object.entries(data));
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

    fs.writeFileSync(this.filePath, encrypted, { mode: 0o600 });
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

export function createCredentialStore(options: CredentialStoreOptions): CredentialStore {
  switch (options.backend) {
    case 'keychain':
      return new KeychainStore();

    case 'encrypted-file':
      if (!options.encryptionPassword) {
        throw new Error('encryptionPassword required for encrypted-file backend');
      }
      return new EncryptedFileStore(options.encryptionPassword);

    case '1password': {
      // Dynamically import to avoid loading if not used
      const { OnePasswordStore } = require('./backends/onepassword.js');
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

      // Dynamically import to avoid loading if not used
      const { VaultStore } = require('./backends/vault.js');
      return new VaultStore({
        address: options.vaultAddress,
        token: options.vaultToken,
        namespace: options.vaultNamespace,
        mountPath: options.vaultMountPath
      });
    }

    default:
      throw new Error(`Unknown credential backend: ${options.backend}`);
  }
}
