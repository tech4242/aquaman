/**
 * systemd-creds credential backend for aquaman
 *
 * Stores credentials encrypted with systemd-creds using the user's credential
 * key (and TPM2 when available). Each credential is a separate .cred file.
 *
 * Requirements:
 *   - systemd >= 256 (for --user support)
 *   - Linux only
 *
 * No root/sudo required — uses `systemd-creds --user` which operates with
 * the per-user credential key stored by systemd-homed or generated on first use.
 */

import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { CredentialStore } from '../store.js';

export interface SystemdCredsStoreOptions {
  /** Directory to store .cred files. Defaults to ~/.aquaman/creds.d/ */
  credsDir?: string;
}

/**
 * Promise wrapper for execFile that properly handles stdin input.
 * Node's promisify(execFile) doesn't reliably pipe stdin.
 */
function execFileAsync(
  cmd: string,
  args: string[],
  opts: { input?: string; encoding?: BufferEncoding; maxBuffer?: number } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const { input, ...rest } = opts;
    const proc = execFile(cmd, args, rest as any, (err, stdout, stderr) => {
      if (err) {
        (err as any).stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout: stdout as string, stderr: stderr as string });
      }
    });
    if (input != null) {
      proc.stdin!.write(input);
      proc.stdin!.end();
    }
  });
}

const SAFE_CRED_NAME = /^[a-z0-9][a-z0-9._-]*$/;

export class SystemdCredsStore implements CredentialStore {
  private credsDir: string;
  private cache = new Map<string, string>();
  private indexLoaded = false;
  private index: Array<{ service: string; key: string }> = [];

  constructor(options: SystemdCredsStoreOptions = {}) {
    this.credsDir =
      options.credsDir ||
      path.join(os.homedir(), '.aquaman', 'creds.d');

    if (!fs.existsSync(this.credsDir)) {
      fs.mkdirSync(this.credsDir, { recursive: true, mode: 0o700 });
    }
  }

  private assertSafeName(label: 'service' | 'key', value: string): void {
    if (!SAFE_CRED_NAME.test(value)) {
      throw new Error(`Invalid ${label} name: ${value}. Allowed pattern: ${SAFE_CRED_NAME.source}`);
    }
  }

  /**
   * Build a filename-safe credential name from service + key.
   * Uses double-dash separator since service/key names may use single dashes.
   */
  private credName(service: string, key: string): string {
    this.assertSafeName('service', service);
    this.assertSafeName('key', key);
    return `${service}--${key}`;
  }

  private credPath(service: string, key: string): string {
    const candidate = path.resolve(this.credsDir, `${this.credName(service, key)}.cred`);
    const root = path.resolve(this.credsDir) + path.sep;
    if (!candidate.startsWith(root)) {
      throw new Error(`Credential path escaped credsDir: ${candidate}`);
    }
    return candidate;
  }

  private indexPath(): string {
    return path.join(this.credsDir, '_index.cred');
  }

  /**
   * Encrypt a value and write to a .cred file.
   * Uses `systemd-creds --user encrypt` — no root required.
   */
  private async encrypt(name: string, value: string, outPath: string): Promise<void> {
    const { stdout } = await execFileAsync(
      'systemd-creds',
      ['--user', 'encrypt', `--name=${name}`, '-', '-'],
      { input: value, encoding: 'utf-8', maxBuffer: 1024 * 1024 }
    );
    fs.writeFileSync(outPath, stdout, { mode: 0o600 });
  }

  /**
   * Decrypt a .cred file and return plaintext.
   * Uses `systemd-creds --user decrypt` — no root required.
   */
  private async decrypt(name: string, inPath: string): Promise<string | null> {
    if (!fs.existsSync(inPath)) return null;
    const { stdout } = await execFileAsync(
      'systemd-creds',
      ['--user', 'decrypt', `--name=${name}`, inPath, '-'],
      { encoding: 'utf-8', maxBuffer: 1024 * 1024 }
    );
    // systemd-creds may append a trailing newline
    return stdout.replace(/\n$/, '');
  }

  /**
   * Load the encrypted index of all stored credentials.
   */
  private async loadIndex(): Promise<Array<{ service: string; key: string }>> {
    if (this.indexLoaded) return this.index;
    try {
      const raw = await this.decrypt('_index', this.indexPath());
      if (raw) {
        this.index = JSON.parse(raw);
      }
    } catch {
      // No index yet or decrypt failed — start fresh
      this.index = [];
    }
    this.indexLoaded = true;
    return this.index;
  }

  /**
   * Save the credential index (also encrypted).
   */
  private async saveIndex(): Promise<void> {
    await this.encrypt('_index', JSON.stringify(this.index), this.indexPath());
  }

  async get(service: string, key: string): Promise<string | null> {
    const cacheKey = this.credName(service, key);

    // Check in-memory cache first
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    const credFile = this.credPath(service, key);
    if (!fs.existsSync(credFile)) return null;

    try {
      const value = await this.decrypt(cacheKey, credFile);
      if (value !== null) {
        this.cache.set(cacheKey, value);
      }
      return value;
    } catch (err) {
      throw new Error(
        `Failed to decrypt credential ${service}/${key}: ${(err as Error).message}`
      );
    }
  }

  async set(
    service: string,
    key: string,
    value: string,
    _metadata?: Record<string, string>
  ): Promise<void> {
    const cacheKey = this.credName(service, key);
    const credFile = this.credPath(service, key);

    try {
      await this.encrypt(cacheKey, value, credFile);
    } catch (err) {
      throw new Error(
        `Failed to encrypt credential ${service}/${key}: ${(err as Error).message}`
      );
    }

    // Update in-memory cache
    this.cache.set(cacheKey, value);

    // Update index
    const index = await this.loadIndex();
    const exists = index.some(
      (e) => e.service === service && e.key === key
    );
    if (!exists) {
      index.push({ service, key });
      await this.saveIndex();
    }
  }

  async delete(service: string, key: string): Promise<boolean> {
    const cacheKey = this.credName(service, key);
    const credFile = this.credPath(service, key);

    if (!fs.existsSync(credFile)) return false;

    fs.unlinkSync(credFile);
    this.cache.delete(cacheKey);

    // Update index
    const index = await this.loadIndex();
    const before = index.length;
    this.index = index.filter(
      (e) => !(e.service === service && e.key === key)
    );
    if (this.index.length !== before) {
      await this.saveIndex();
    }

    return true;
  }

  async list(
    service?: string
  ): Promise<Array<{ service: string; key: string }>> {
    const index = await this.loadIndex();
    if (service) {
      return index.filter((e) => e.service === service);
    }
    return [...index];
  }

  async exists(service: string, key: string): Promise<boolean> {
    const credFile = this.credPath(service, key);
    return fs.existsSync(credFile);
  }
}

/**
 * Check if systemd-creds --user is available on this system.
 * Returns true if systemd >= 256.
 */
export function isSystemdCredsAvailable(): boolean {
  try {
    const out = execFileSync('systemd-creds', ['--version'], { encoding: 'utf-8' });
    // Parse version: "systemd 258 (...)"
    const match = out.match(/systemd\s+(\d+)/);
    if (!match) return false;
    const version = parseInt(match[1], 10);
    return version >= 256;
  } catch {
    return false;
  }
}

export function createSystemdCredsStore(
  options?: SystemdCredsStoreOptions
): SystemdCredsStore {
  return new SystemdCredsStore(options);
}
