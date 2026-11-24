/**
 * Hermes integration (v0.13.0+)
 *
 * Detects a local Hermes install and wires it to the aquaman loopback
 * listener: provider base URLs and a placeholder key, stored as Hermes
 * environment settings. Hermes owns its `.env`, so the settings are stored by
 * running `hermes config set`, for the profile Hermes selects or the one
 * named, and aquaman never edits the file. Unlike the OpenClaw path there is
 * no in-process plugin doing fetch interception — Hermes is a foreign (Python)
 * host, so the contract is purely: loopback listener on the proxy side +
 * native env vars on the Hermes side. See config-writer.ts for the path/auth
 * rationale.
 */

import * as os from 'node:os';
import { spawn } from 'node:child_process';
import {
  generateHermesEnv,
  formatHermesEnvForDisplay,
  formatHermesConfigSetCommands,
  getHermesEnvPath,
  hermesConfigSetArgs,
  hermesConfigSetWritesEnv,
  hermesEnvWiring,
  hermesProfileArgs,
  hermesRealKeysInEnv,
  hermesWiredServices,
} from './config-writer.js';
import type { HermesConfig } from '../core/index.js';

export interface HermesInfo {
  installed: boolean;
  version?: string;
  path?: string;
}

export interface HermesIntegrationOptions {
  /** Loopback listener port the env vars should point at. */
  port: number;
  /** Loopback token used as the placeholder api_key. */
  token: string;
  /** Loopback host. Defaults to 127.0.0.1. */
  host?: string;
  /** Services to wire (only anthropic/openai are emitted today). */
  services: string[];
  /** Hermes integration config (configMethod, binaryPath). */
  config?: HermesConfig;
}

/**
 * What became of storing the settings in Hermes.
 *
 * `applied`: every setting is in the profile's `.env`, read back from it.
 * `manual`: nothing was run, and `commands` or `lines` is what a person does
 * instead (`not_installed`: no Hermes program; `old_hermes`: its
 * `config set` would put some settings in `config.yaml`).
 * `refused`: nothing was run, because the file holds a real provider key that
 * `hermes config set` would replace.
 * `failed`: a Hermes command failed, or a setting did not arrive in the file.
 * Settings before the failing one are stored.
 */
export type HermesApplyResult =
  | { status: 'applied'; envPath: string; set: string[] }
  | { status: 'manual'; reason: 'not_installed' | 'old_hermes'; envPath: string; version?: string }
  | { status: 'refused'; envPath: string; realKeys: string[] }
  | { status: 'failed'; envPath: string; set: string[]; key?: string; detail: string };

/** One run of the Hermes program: exit code and what it printed, never thrown. */
function runHermes(
  binaryPath: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const proc = spawn(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      stderr += `timed out after ${timeoutMs / 1000}s`;
      proc.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => { stderr += err.message; finish(null); });
    proc.on('close', (code) => finish(code));
  });
}

/**
 * Detect whether the Hermes CLI is installed and parse its version.
 * Parses lines like "Hermes Agent v0.16.0 (2026.6.5)".
 */
export async function detectHermes(binaryPath = 'hermes'): Promise<HermesInfo> {
  return new Promise((resolve) => {
    const proc = spawn(binaryPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';

    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.on('error', () => resolve({ installed: false }));
    proc.on('close', (code) => {
      if (code === 0 && stdout) {
        const match = stdout.match(/Hermes(?:\s+Agent)?\s+v?(\d+\.\d+\.\d+)/i);
        resolve({
          installed: true,
          version: match ? match[1] : stdout.trim().split('\n')[0],
          path: binaryPath,
        });
      } else {
        resolve({ installed: false });
      }
    });
  });
}

export class HermesIntegration {
  private options: HermesIntegrationOptions;

  constructor(options: HermesIntegrationOptions) {
    this.options = options;
  }

  /** Build the env vars that point Hermes at the loopback listener. */
  configureHermes(): Record<string, string> {
    return generateHermesEnv({
      port: this.options.port,
      token: this.options.token,
      host: this.options.host,
      services: this.options.services,
    });
  }

  /** Which of the requested services actually get wired (anthropic/openai today). */
  wiredServices(): string[] {
    return hermesWiredServices(this.options.services);
  }

  private binary(): string {
    return this.options.config?.binaryPath || 'hermes';
  }

  /** Where the profile's dotenv file is by Hermes's layout, without asking Hermes. */
  envPath(profile?: string): string {
    return getHermesEnvPath(os.homedir(), profile);
  }

  /**
   * The dotenv file of the profile, as Hermes reports it
   * (`hermes [-p <name>] config env-path`). Hermes knows which profile is the
   * active one when none is named; without a Hermes program, or when it does
   * not answer with a path, the layout is assumed.
   */
  async resolveEnvPath(profile?: string): Promise<string> {
    const r = await runHermes(this.binary(), [...hermesProfileArgs(profile), 'config', 'env-path']);
    const last = r.stdout.trim().split('\n').pop()?.trim() ?? '';
    if (r.code === 0 && last.startsWith('/') && last.endsWith('.env')) return last;
    return this.envPath(profile);
  }

  /** The `hermes config set` commands that store `env`, for a person to run. */
  commandsForDisplay(env: Record<string, string>, profile?: string): string {
    return formatHermesConfigSetCommands(env, profile);
  }

  /**
   * Store `env` as Hermes environment settings by running `hermes config set`
   * once per setting, then read the profile's `.env` to see that each one is
   * there. Nothing is run when Hermes is missing, when its `config set` would
   * store part of the settings elsewhere, or when the file holds a real
   * provider key that the command would replace (`replaceKeys` allows that).
   * The value of a setting is never part of what is returned.
   */
  async applyConfiguration(
    env: Record<string, string>,
    opts: { profile?: string; replaceKeys?: boolean } = {},
  ): Promise<HermesApplyResult> {
    const info = await this.detect();
    if (!info.installed) {
      return { status: 'manual', reason: 'not_installed', envPath: this.envPath(opts.profile) };
    }
    const envPath = await this.resolveEnvPath(opts.profile);
    if (!hermesConfigSetWritesEnv(info.version)) {
      return { status: 'manual', reason: 'old_hermes', envPath, version: info.version };
    }
    if (!opts.replaceKeys) {
      const realKeys = hermesRealKeysInEnv(envPath, env);
      if (realKeys.length > 0) return { status: 'refused', envPath, realKeys };
    }

    const scrub = (text: string) => {
      let out = text;
      for (const v of new Set(Object.values(env))) out = out.split(v).join('[value]');
      return out.trim().split('\n').slice(-3).join(' ').slice(0, 400);
    };
    const set: string[] = [];
    for (const args of hermesConfigSetArgs(env, opts.profile)) {
      const key = args[args.length - 2];
      const r = await runHermes(this.binary(), args);
      if (r.code !== 0) {
        const said = scrub(r.stderr || r.stdout) || (r.code === null ? 'could not be run' : `exit ${r.code}`);
        return { status: 'failed', envPath, set, key, detail: said };
      }
      set.push(key);
    }

    const wiring = hermesEnvWiring(envPath, env);
    const absent = [...wiring.missing, ...wiring.differing];
    if (absent.length > 0) {
      return {
        status: 'failed', envPath, set,
        detail: `Hermes reported success, but ${absent.join(', ')} ${absent.length === 1 ? 'is' : 'are'} not in ${envPath} with the value that was set`,
      };
    }
    return { status: 'applied', envPath, set };
  }

  getEnvForDisplay(): string {
    return formatHermesEnvForDisplay(this.configureHermes());
  }

  async detect(): Promise<HermesInfo> {
    return detectHermes(this.binary());
  }
}

export function createHermesIntegration(options: HermesIntegrationOptions): HermesIntegration {
  return new HermesIntegration(options);
}
