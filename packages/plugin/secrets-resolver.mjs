#!/usr/bin/env node
/**
 * SecretRef exec resolver for the aquaman OpenClaw plugin (v0.14.0+).
 *
 * Speaks the OpenClaw secret-provider exec protocol (protocolVersion 1,
 * verified against openclaw 2026.6.10 `resolveExecRefs`/`runExecResolver`):
 *   stdin:  {"protocolVersion":1,"provider":"aquaman","ids":["anthropic/api_key",...]}
 *   stdout: {"protocolVersion":1,"values":{"<id>":"<value>",...},"errors":{...}}
 *
 * It returns the STATIC placeholder for every requested id — deliberately.
 * Real keys live in the aquaman vault; the proxy strips whatever key the
 * gateway presents and injects the real credential upstream. The SecretRef
 * only needs to resolve to a stable non-empty marker, and resolution must
 * succeed even when the aquaman daemon isn't running yet (the gateway
 * resolves its secrets snapshot eagerly at startup) — so this script
 * contacts nothing: no vault, no proxy, no network, no env reads.
 *
 * The gateway spawns it as `${node} ./dist/secrets-resolver.mjs` with an
 * EMPTY child env (no passEnv declared in the manifest) inside the plugin
 * root, entrypoint permission-checked. Keep this file dependency-free.
 */

const PLACEHOLDER = 'aquaman-proxy-managed';
const PROTOCOL_VERSION = 1;

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
  const values = {};
  const errors = {};
  for (const id of ids) {
    if (typeof id === 'string' && id.length > 0) {
      values[id] = PLACEHOLDER;
    } else {
      errors[String(id)] = { message: 'invalid ref id (expected a non-empty string like "anthropic/api_key")' };
    }
  }

  const response = { protocolVersion: PROTOCOL_VERSION, values };
  if (Object.keys(errors).length > 0) response.errors = errors;
  process.stdout.write(JSON.stringify(response));
}

main().catch((err) => fail(err && err.message ? err.message : String(err)));
