/**
 * Keeper credential backend using Keeper Commander (the `keeper` CLI).
 * Requires: Commander installed (`pip install keepercommander`) with
 * persistent login set up once (`this-device register`,
 * `this-device persistent-login on`), and a folder for aquaman's records.
 *
 * Commander works with the standard Keeper password manager on any plan.
 * Keeper Secrets Manager (the KSM SDK) would avoid the CLI but needs the
 * Business Secrets Manager add-on, so it is not used here (issue #67).
 *
 * Behavior verified against Commander source (v18.1.5, faef1b3), not yet
 * against a live account:
 *   - `keeper --batch-mode get <UID> --format json|password`: folder JSON lists
 *     `records[{record_uid, record_name}]`; `password` prints only the password.
 *   - `keeper --batch-mode -` reads commands from stdin and exits non-zero on
 *     the first failure. Batch mode logs at WARNING, so commands are not echoed.
 *   - Field values starting with `$GEN`/`$JSON` are macros and a leading `=`
 *     is folded into the field name, so every value is written as
 *     `$BASE64:<encoded>`, which record-add/record-update decode.
 *
 * Secret values never go on argv or to disk: writes travel over stdin only.
 * If the persistent login has lapsed, Commander's login prompt would read the
 * first stdin line as the account email, so every write first runs a
 * stdin-closed read of the folder and aborts if that fails.
 *
 * Records are titled `aquaman::<service>::<key>` (the Bitwarden naming, which
 * cannot collide on hyphens) and live in one folder, addressed by UID so a
 * same-titled record elsewhere in the vault is never read.
 */

import { spawnSync } from 'node:child_process';
import type { CredentialStore } from '../store.js';

export interface KeeperStoreOptions {
  /** UID of the Keeper folder (or shared folder) holding aquaman's records. */
  folderUid: string;
  /** Commander config file (`keeper --config`). Default: Commander's own. */
  configPath?: string;
  /** Commander executable. Default: `keeper` on PATH. */
  command?: string;
  /** Per-invocation timeout in ms. Commander logs in and syncs on every run. */
  timeoutMs?: number;
}

const TITLE_PREFIX = 'aquaman';
const DEFAULT_TIMEOUT_MS = 60_000;
// Keeper UIDs are 22-char URL-safe base64; accept that alphabet only so a
// folder "UID" can never smuggle a second command into a batch line.
const KEEPER_UID = /^[A-Za-z0-9_-]{16,32}$/;

export function keeperTitle(service: string, key: string): string {
  return `${TITLE_PREFIX}::${service}::${key}`;
}

function parseTitle(title: string): { service: string; key: string } | null {
  const parts = title.split('::');
  if (parts.length !== 3 || parts[0] !== TITLE_PREFIX || !parts[1] || !parts[2]) return null;
  return { service: parts[1], key: parts[2] };
}

/** POSIX single-quote for Commander's shlex-parsed command lines. */
function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export class KeeperStore implements CredentialStore {
  private folderUid: string;
  private configPath?: string;
  private command: string;
  private timeoutMs: number;

  constructor(options: KeeperStoreOptions) {
    if (!options.folderUid || !KEEPER_UID.test(options.folderUid)) {
      throw new Error(
        'Keeper backend needs the UID of the folder that holds aquaman records (credentials.keeperFolderUid or AQUAMAN_KEEPER_FOLDER_UID). ' +
        'Find it with: keeper get "<folder name>" --format json'
      );
    }
    this.folderUid = options.folderUid;
    this.configPath = options.configPath;
    this.command = options.command || 'keeper';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!KeeperStore.isAvailable(this.command)) {
      throw new Error('Keeper Commander (keeper) not found. Install: pip install keepercommander');
    }
  }

  static isAvailable(command = 'keeper'): boolean {
    try {
      return spawnSync('which', [command], { encoding: 'utf-8' }).status === 0;
    } catch {
      return false;
    }
  }

  private baseArgs(): string[] {
    const args = ['--batch-mode'];
    if (this.configPath) args.push('--config', this.configPath);
    return args;
  }

  /**
   * Run one Commander command with stdin closed, so a lapsed login fails fast
   * instead of prompting. Only UIDs and flags go on argv here.
   */
  private run(args: string[]): string {
    const result = spawnSync(this.command, [...this.baseArgs(), ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: this.timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.error) throw new Error(`keeper failed to run: ${result.error.message}`);
    if (result.status !== 0) {
      throw new Error(`keeper ${args[0]} failed: ${(result.stderr || result.stdout || 'unknown error').trim()}. ` +
        'If the session lapsed, run `keeper shell`, log in, and re-enable `this-device persistent-login on`.');
    }
    return result.stdout;
  }

  /** Run commands fed over stdin. Used for anything carrying a secret value. */
  private runStdin(commands: string[]): void {
    const result = spawnSync(this.command, [...this.baseArgs(), '-'], {
      input: commands.join('\n') + '\nq\n',
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: this.timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.error) throw new Error(`keeper failed to run: ${result.error.message}`);
    if (result.status !== 0) {
      // Never echo stdout/stderr here wholesale: a failing record line could be
      // reflected back, and it carries the (encoded) value.
      throw new Error(`keeper write failed (exit ${result.status}). Run \`aquaman doctor\` to check the Keeper session.`);
    }
  }

  /** Records in the aquaman folder, by title. */
  private records(): Map<string, string[]> {
    const out = this.run(['get', this.folderUid, '--format', 'json']);
    let parsed: any;
    try {
      parsed = JSON.parse(out);
    } catch {
      throw new Error(`keeper get ${this.folderUid}: expected folder JSON. Is keeperFolderUid a folder UID?`);
    }
    const byTitle = new Map<string, string[]>();
    for (const r of Array.isArray(parsed?.records) ? parsed.records : []) {
      if (typeof r?.record_uid !== 'string' || typeof r?.record_name !== 'string') continue;
      const list = byTitle.get(r.record_name) ?? [];
      list.push(r.record_uid);
      byTitle.set(r.record_name, list);
    }
    return byTitle;
  }

  private findUid(service: string, key: string, records = this.records()): string | null {
    const uids = records.get(keeperTitle(service, key)) ?? [];
    if (uids.length > 1) {
      throw new Error(`Keeper folder has ${uids.length} records titled "${keeperTitle(service, key)}"; delete the duplicates`);
    }
    return uids[0] ?? null;
  }

  async get(service: string, key: string): Promise<string | null> {
    const uid = this.findUid(service, key);
    if (!uid) return null;
    const out = this.run(['get', uid, '--format', 'password']);
    // Commander prints the password followed by a newline.
    const value = out.replace(/\r?\n$/, '');
    return value.length > 0 ? value : null;
  }

  async set(service: string, key: string, value: string, _metadata?: Record<string, string>): Promise<void> {
    if (!value) throw new Error('Keeper backend cannot store an empty value');
    // Proves the session is live with stdin closed before any secret is piped.
    const uid = this.findUid(service, key);
    const encoded = `$BASE64:${Buffer.from(value, 'utf-8').toString('base64')}`;
    const line = uid
      ? `record-update -r ${uid} ${quote(`password=${encoded}`)}`
      : `record-add --folder=${this.folderUid} -t ${quote(keeperTitle(service, key))} -rt login ${quote(`password=${encoded}`)}`;
    this.runStdin([line]);

    if ((await this.get(service, key)) !== value) {
      throw new Error(`Keeper did not store ${service}/${key} as written; check the record in Keeper`);
    }
  }

  async delete(service: string, key: string): Promise<boolean> {
    const uid = this.findUid(service, key);
    if (!uid) return false;
    this.run(['rm', '-f', uid]);
    return true;
  }

  async list(service?: string): Promise<Array<{ service: string; key: string }>> {
    const out: Array<{ service: string; key: string }> = [];
    for (const title of this.records().keys()) {
      const parsed = parseTitle(title);
      if (parsed && (!service || parsed.service === service)) out.push(parsed);
    }
    return out;
  }

  async exists(service: string, key: string): Promise<boolean> {
    return this.findUid(service, key) !== null;
  }
}
