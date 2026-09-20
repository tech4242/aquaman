#!/usr/bin/env node
/**
 * SecretRef exec resolver for the aquaman OpenClaw plugin (v0.14.0+).
 *
 * Speaks the OpenClaw secret-provider exec protocol (protocolVersion 1,
 * verified against openclaw 2026.6.10 `resolveExecRefs`/`runExecResolver`;
 * re-verified 2026-08-03 against gateway/secrets docs — protocol unchanged
 * through 2026.7.2-beta):
 *   stdin:  {"protocolVersion":1,"provider":"aquaman","ids":["anthropic/api_key",...]}
 *   stdout: {"protocolVersion":1,"values":{"<id>":"<value>",...},"errors":{...}}
 *
 * It NEVER returns a real credential. It returns the aquaman loopback token
 * when one is configured, else the static placeholder. Both are markers the
 * proxy strips before injecting the real key from the vault:
 *   - loopback token: OpenClaw's model transport calls the proxy's loopback
 *     listener (models.providers.<svc>.baseUrl), which is token-gated, so the
 *     token has to travel as the provider api key — exactly as on the Hermes
 *     path. It is a capability to reach 127.0.0.1, not a credential.
 *   - placeholder: no listener configured (legacy sentinel/UDS path).
 *
 * The token is read from aquaman's config.yaml with a tiny hand-rolled
 * parser: this script must stay dependency-free, must never contact the vault
 * or the network, and must still resolve when the daemon isn't running (the
 * gateway resolves its secrets snapshot eagerly at startup). Any read problem
 * falls back to the placeholder rather than failing the gateway's startup.
 *
 * The gateway spawns it as `${node} ./dist/secrets-resolver.mjs` inside the
 * plugin root with a near-empty child env, entrypoint permission-checked —
 * so the config path is resolved from AQUAMAN_CONFIG_DIR when passed through,
 * else from the OS home directory (os.homedir() works without $HOME).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const PLACEHOLDER = 'aquaman-proxy-managed';
const PROTOCOL_VERSION = 1;

/**
 * `loopback.token` from aquaman's config.yaml, or null. Deliberately a
 * line scanner, not a YAML dependency: only the top-level `loopback:` block
 * is considered, and only when the listener is enabled.
 */
function readLoopbackToken() {
  try {
    const dir = process.env.AQUAMAN_CONFIG_DIR || path.join(os.homedir(), '.aquaman');
    const text = fs.readFileSync(path.join(dir, 'config.yaml'), 'utf-8');
    let inBlock = false;
    let enabled = false;
    let token = null;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (/^[A-Za-z_][\w-]*\s*:/.test(line)) {
        inBlock = /^loopback\s*:/.test(line);
        continue;
      }
      if (!inBlock) continue;
      const enabledMatch = line.match(/^\s+enabled\s*:\s*(true|false)\s*$/);
      if (enabledMatch) enabled = enabledMatch[1] === 'true';
      const tokenMatch = line.match(/^\s+token\s*:\s*["']?([A-Za-z0-9._-]+)["']?\s*$/);
      if (tokenMatch) token = tokenMatch[1];
    }
    return enabled && token ? token : null;
  } catch {
    return null; // absent/unreadable/malformed — fall back to the placeholder
  }
}

function fail(message) {
  process.stderr.write(`aquaman secrets-resolver: ${message}\n`);
  process.exit(1);
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 256 * 1024) fail('request exceeds 256 KiB');
  }

  let request;
  try {
    request = JSON.parse(raw);
  } catch (err) {
    fail(`stdin is not valid JSON: ${err.message}`);
  }

  if (request.protocolVersion !== PROTOCOL_VERSION) {
    fail(`unsupported protocolVersion: ${JSON.stringify(request.protocolVersion)} (expected ${PROTOCOL_VERSION})`);
  }

  const ids = Array.isArray(request.ids) ? request.ids : [];
  const marker = readLoopbackToken() || PLACEHOLDER;
  const values = {};
  const errors = {};
  for (const id of ids) {
    if (typeof id === 'string' && id.length > 0) {
      values[id] = marker;
    } else {
      errors[String(id)] = { message: 'invalid ref id (expected a non-empty string like "anthropic/api_key")' };
    }
  }

  const response = { protocolVersion: PROTOCOL_VERSION, values };
  if (Object.keys(errors).length > 0) response.errors = errors;
  process.stdout.write(JSON.stringify(response));
}

main().catch((err) => fail(err && err.message ? err.message : String(err)));
