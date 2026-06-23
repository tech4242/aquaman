/**
 * Environment configuration generator for Hermes integration (v0.13.0+)
 *
 * Hermes is a Python agent host that builds its own HTTP client
 * internally and exposes no transport/socket hook — so the aquaman UDS proxy
 * can't be injected the way it is for OpenClaw. Instead the proxy runs an
 * opt-in loopback TCP listener and Hermes is pointed at it via the SAME
 * provider env vars it already understands (`ANTHROPIC_BASE_URL`,
 * `OPENAI_BASE_URL`) plus a placeholder api_key that equals the loopback token.
 *
 * Hermes path conventions (verified against hermes_cli/runtime_provider.py and
 * agent/anthropic_adapter.py):
 *   - Anthropic: base_url must end with `/anthropic`. Hermes special-cases that
 *     suffix into `anthropic_messages` api_mode; the Anthropic SDK then appends
 *     `/v1/messages`, yielding `/anthropic/v1/messages` at the proxy.
 *   - OpenAI: base_url ends with `/openai/v1`; the OpenAI SDK appends
 *     `/chat/completions`, yielding `/openai/v1/chat/completions`. The proxy's
 *     `openai` upstream is `https://api.openai.com` (no `/v1`), so there's no
 *     double-`/v1`.
 *
 * First cut covers LLM-provider isolation only (anthropic, openai). Channels /
 * "platforms" are deferred — they have no base_url lever and hit the same
 * can't-intercept-a-foreign-client wall.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Matches the SAFE_SERVICE_NAME pattern from daemon.ts. */
const SAFE_SERVICE_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/** Providers Hermes can be pointed at the loopback listener today. */
export const HERMES_SUPPORTED_SERVICES = ['anthropic', 'openai'] as const;

export interface HermesEnvConfig {
  /** Loopback listener port. */
  port: number;
  /** Loopback token — becomes the placeholder api_key Hermes presents. */
  token: string;
  /** Loopback host. Defaults to 127.0.0.1. */
  host?: string;
  /** Services to wire. Only anthropic/openai are emitted today; others are ignored. */
  services: string[];
}

/**
 * Generate the env vars that point Hermes at the aquaman loopback listener.
 * For each supported provider in `services`, emits both the base URL and a
 * placeholder api_key set to the loopback token. The proxy strips the
 * placeholder and injects the real vault-stored credential.
 */
export function generateHermesEnv(config: HermesEnvConfig): Record<string, string> {
  const host = config.host || '127.0.0.1';
  const base = `http://${host}:${config.port}`;
  const env: Record<string, string> = {};

  for (const service of config.services) {
    if (!SAFE_SERVICE_NAME.test(service)) continue;

    switch (service) {
      case 'anthropic':
        env['ANTHROPIC_BASE_URL'] = `${base}/anthropic`;
        env['ANTHROPIC_API_KEY'] = config.token;
        break;
      case 'openai':
        env['OPENAI_BASE_URL'] = `${base}/openai/v1`;
        env['OPENAI_API_KEY'] = config.token;
        break;
      default:
        // Unsupported for Hermes today (channels/other providers). Skip
        // silently — the caller surfaces which services were wired.
        break;
    }
  }

  return env;
}

/** Services in the input list that this integration knows how to wire for Hermes. */
export function hermesWiredServices(services: string[]): string[] {
  return services.filter(s => (HERMES_SUPPORTED_SERVICES as readonly string[]).includes(s));
}

/**
 * Default path to the Hermes dotenv file (`~/.hermes/.env`). Honors the
 * `HERMES_HOME` override — the same var the Hermes CLI itself uses to relocate
 * its config dir (verified against `hermes config env-path`) — else falls back
 * to `~/.hermes`.
 */
export function getHermesEnvPath(homeDir: string): string {
  const stateDir = process.env['HERMES_HOME'] || path.join(homeDir, '.hermes');
  return path.join(stateDir, '.env');
}

/**
 * Write/merge the aquaman-managed block into `~/.hermes/.env`. Existing
 * non-aquaman lines are preserved; the managed block is delimited by markers
 * and rewritten in place on re-run (idempotent). File mode 0o600.
 */
export function writeHermesEnv(env: Record<string, string>, filePath: string): void {
  const marker = '# >>> aquaman managed >>>';
  const endMarker = '# <<< aquaman managed <<<';

  let content = '';
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, 'utf-8');
  }

  // Strip any prior aquaman block.
  const start = content.indexOf(marker);
  const end = content.indexOf(endMarker);
  if (start !== -1 && end !== -1 && end > start) {
    content = content.slice(0, start).replace(/\n+$/, '') + content.slice(end + endMarker.length);
  }

  const body = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const block = `${marker}\n${body}\n${endMarker}\n`;

  const merged = content.trim().length > 0
    ? content.replace(/\n+$/, '') + '\n\n' + block
    : block;

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(filePath, merged, { mode: 0o600 });
}

/** Format env vars for display (dry-run / export output). */
export function formatHermesEnvForDisplay(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `  ${k}=${v}`)
    .join('\n');
}
