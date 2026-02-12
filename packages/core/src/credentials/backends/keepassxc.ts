/**
 * KeePassXC credential backend using kdbxweb
 *
 * Stores credentials in a KDBX database file, compatible with KeePassXC,
 * KeePass, and other KDBX-compatible password managers.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CredentialStore } from '../store.js';

export interface KeePassXCStoreOptions {
  dbPath: string;
  password?: string;
  keyFilePath?: string;
  group?: string;
}

export class KeePassXCStore implements CredentialStore {
  private db: any = null;
  private kdbxweb: any = null;
  private dbPath: string;
  private password?: string;
  private keyFilePath?: string;
  private groupName: string;
  private watcher?: fs.FSWatcher;

  constructor(options: KeePassXCStoreOptions) {
    this.dbPath = options.dbPath;
    this.password = options.password;
    this.keyFilePath = options.keyFilePath;
    this.groupName = options.group || 'aquaman';

    if (!this.password && !this.keyFilePath) {
      throw new Error(
        'KeePassXC backend requires a master password (AQUAMAN_KEEPASS_PASSWORD) or key file (keepassxcKeyFilePath)'
      );
    }
  }

  private async getKdbxweb(): Promise<any> {
    if (!this.kdbxweb) {
      try {
        const mod: any = await import('kdbxweb');
        this.kdbxweb = mod.default || mod;
      } catch {
        throw new Error('kdbxweb not available - install with: npm install kdbxweb argon2');
      }

      // Wire up argon2 for KDBX 4 support
      try {
        const argon2Mod: any = await import('argon2');
        const argon2 = argon2Mod.default || argon2Mod;
        this.kdbxweb.CryptoEngine.setArgon2Impl(async (
          password: ArrayBuffer,
          salt: ArrayBuffer,
          memory: number,
          iterations: number,
          length: number,
          parallelism: number,
          type: number,
          version: number
        ): Promise<ArrayBuffer> => {
          const result = await argon2.hash(Buffer.from(password), {
            salt: Buffer.from(salt),
            hashLength: length,
            timeCost: iterations,
            memoryCost: memory,
            parallelism,
            type,
            version,
            raw: true
          });
          const buf = result as Buffer;
          return new Uint8Array(buf).buffer as ArrayBuffer;
        });
      } catch {
        // argon2 not available — KDBX 3 files will still work
      }
    }
    return this.kdbxweb;
  }

  private async openDb(): Promise<any> {
    if (this.db) return this.db;

    const kdbxweb = await this.getKdbxweb();

    // Build credentials
    const passwordValue = this.password
      ? kdbxweb.ProtectedValue.fromString(this.password)
      : null;

    let keyFileData: ArrayBuffer | null = null;
    if (this.keyFilePath) {
      const buf = fs.readFileSync(this.keyFilePath);
      keyFileData = new Uint8Array(buf).buffer as ArrayBuffer;
    }

    const credentials = new kdbxweb.Credentials(passwordValue, keyFileData);

    if (!fs.existsSync(this.dbPath)) {
      // Auto-create a new database
      this.db = kdbxweb.Kdbx.create(credentials, 'aquaman');
      // Ensure our group exists in the new db
      this.db.createGroup(this.db.getDefaultGroup(), this.groupName);
      // Use KDBX 3 format for saving (kdbxweb KDBX 4 write bug #49)
      this.db.setVersion(3);
      await this.saveDb();
      this.startWatching();
      return this.db;
    }

    // Open existing database
    const fileBuf = fs.readFileSync(this.dbPath);
    const arrayBuffer = new Uint8Array(fileBuf).buffer as ArrayBuffer;

    try {
      this.db = await kdbxweb.Kdbx.load(arrayBuffer, credentials);
    } catch {
      throw new Error('Failed to open KeePassXC database - wrong password or key file?');
    }

    this.startWatching();
    return this.db;
  }

  private async saveDb(): Promise<void> {
    if (!this.db) return;

    const arrayBuffer = await this.db.save();
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.dbPath, Buffer.from(arrayBuffer), { mode: 0o600 });
  }

  private startWatching(): void {
    if (this.watcher) return;
    try {
      this.watcher = fs.watch(this.dbPath, () => {
        // External modification — invalidate cache so next access reloads
        this.db = null;
      });
    } catch {
      // Watch not supported on this filesystem — acceptable fallback
    }
  }

  private findGroup(db: any): any {
    const defaultGroup = db.getDefaultGroup();
    for (const g of defaultGroup.allGroups()) {
      if (g.name === this.groupName) return g;
    }
    return null;
  }

  private findOrCreateGroup(db: any): any {
    let group = this.findGroup(db);
    if (!group) {
      group = db.createGroup(db.getDefaultGroup(), this.groupName);
    }
    return group;
  }

  private getEntryTitle(service: string, key: string): string {
    return `${service}/${key}`;
  }

  private findEntry(group: any, service: string, key: string): any {
    const title = this.getEntryTitle(service, key);
    for (const entry of group.entries) {
      const entryTitle = entry.fields.get('Title');
      if (entryTitle === title) return entry;
    }
    return null;
  }

  async get(service: string, key: string): Promise<string | null> {
    const db = await this.openDb();
    const group = this.findGroup(db);
    if (!group) return null;

    const entry = this.findEntry(group, service, key);
    if (!entry) return null;

    const password = entry.fields.get('Password');
    if (!password) return null;

    // ProtectedValue has .getText() for plaintext
    return typeof password === 'string' ? password : password.getText();
  }

  async set(
    service: string,
    key: string,
    value: string,
    _metadata?: Record<string, string>
  ): Promise<void> {
    const kdbxweb = await this.getKdbxweb();
    const db = await this.openDb();
    const group = this.findOrCreateGroup(db);

    let entry = this.findEntry(group, service, key);
    if (!entry) {
      entry = db.createEntry(group);
      entry.fields.set('Title', this.getEntryTitle(service, key));
      entry.fields.set('UserName', `${service}/${key}`);
    }

    entry.fields.set('Password', kdbxweb.ProtectedValue.fromString(value));

    // Use KDBX 3 format for saving (kdbxweb KDBX 4 write bug #49)
    if (typeof db.setVersion === 'function') {
      db.setVersion(3);
    }
    await this.saveDb();
  }

  async delete(service: string, key: string): Promise<boolean> {
    const db = await this.openDb();
    const group = this.findGroup(db);
    if (!group) return false;

    const entry = this.findEntry(group, service, key);
    if (!entry) return false;

    db.remove(entry);
    await this.saveDb();
    return true;
  }

  async list(service?: string): Promise<Array<{ service: string; key: string }>> {
    const db = await this.openDb();
    const group = this.findGroup(db);
    if (!group) return [];

    const results: Array<{ service: string; key: string }> = [];
    for (const entry of group.entries) {
      const title = entry.fields.get('Title');
      if (typeof title !== 'string') continue;

      const slashIdx = title.indexOf('/');
      if (slashIdx === -1) continue;

      const svc = title.substring(0, slashIdx);
      const k = title.substring(slashIdx + 1);

      if (!service || svc === service) {
        results.push({ service: svc, key: k });
      }
    }

    return results;
  }

  async exists(service: string, key: string): Promise<boolean> {
    const value = await this.get(service, key);
    return value !== null;
  }

  /**
   * Close the database and stop watching for changes.
   */
  close(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
    this.db = null;
  }
}

export function createKeePassXCStore(options: KeePassXCStoreOptions): KeePassXCStore {
  return new KeePassXCStore(options);
}
