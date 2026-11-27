/**
 * What an Agent Substrate actor may be given: the two names a request
 * carries (the secret URI and the actor's identity) and the grants that
 * connect them.
 *
 * Substrate's egress gateway asks for `ate-secret://<provider>/<service>/<key>`
 * on behalf of `spiffe://<trust domain>/actor/<atespace>/<actor>`. Nobody is
 * there to approve a request, so the decision is written down beforehand:
 * `substrate.provider.grants` in config.yaml maps an atespace, or one actor in
 * it (`<atespace>/<actor>`), to the references it may be given. Anything not
 * listed is refused.
 *
 * A grant is for this provider only. It does not declare the reference for
 * `/broker/resolve`, so software running beside the daemon gains nothing
 * from it.
 */

import * as fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { parseAquamanRef } from '../broker-scope.js';
import { isReservedService } from '../core/credentials/reserved.js';

/** An atespace or actor name: a DNS-1123 subdomain, as Kubernetes names are. */
const SUBSTRATE_NAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

export function isSubstrateName(name: string): boolean {
  return SUBSTRATE_NAME.test(name) && !name.includes('..');
}

/**
 * The reference a secret URI names, or `null`. The URI is exactly
 * `ate-secret://<provider>/<service>/<key>` with aquaman's own grammar for
 * service and key, so there is no escape, query or extra segment to read in
 * two ways.
 */
export function parseSecretUri(uri: string, providerName: string): { service: string; key: string } | null {
  const prefix = `ate-secret://${providerName}/`;
  if (typeof uri !== 'string' || uri.length > 512 || !uri.startsWith(prefix)) return null;
  return parseAquamanRef(`aquaman://${uri.slice(prefix.length)}`);
}

export interface ActorIdentity {
  atespace: string;
  actor: string;
}

/** The atespace and actor of `spiffe://<trustDomain>/actor/<atespace>/<actor>`, or `null`. */
export function parseActorSpiffeId(id: string, trustDomain: string): ActorIdentity | null {
  const prefix = `spiffe://${trustDomain}/actor/`;
  if (typeof id !== 'string' || id.length > 1024 || !id.startsWith(prefix)) return null;
  const parts = id.slice(prefix.length).split('/');
  if (parts.length !== 2 || !isSubstrateName(parts[0]) || !isSubstrateName(parts[1])) return null;
  return { atespace: parts[0], actor: parts[1] };
}

export interface SubstrateGrants {
  /** Grant key (`<atespace>` or `<atespace>/<actor>`) to the references it may be given. */
  grants: Map<string, Set<string>>;
  /** Why the file grants less than it says, when an entry or the file itself could not be used. */
  error?: string;
}

function isGrantKey(key: string): boolean {
  const parts = key.split('/');
  return parts.length >= 1 && parts.length <= 2 && parts.every(isSubstrateName);
}

/**
 * Read `substrate.provider.grants` straight from a config.yaml file. A
 * missing file or key grants nothing; so does a file that does not parse. An
 * entry that is not a grant key, or a reference that is not one aquaman
 * hands out, is left out and named in `error`.
 */
export function loadSubstrateGrants(configPath: string): SubstrateGrants {
  const grants = new Map<string, Set<string>>();
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { grants };
    return { grants, error: `cannot read ${configPath}: ${err?.message ?? err}` };
  }
  let parsed: any;
  try {
    // Every scalar as it is written. With YAML's usual types a key such as
    // 0x10 or 1e3, both of which are names an atespace can have, would be
    // read as a number and the grant would land on atespace "16" or "1000".
    parsed = parseYaml(raw, { schema: 'failsafe' });
  } catch (err: any) {
    return { grants, error: `cannot parse ${configPath}: ${err?.message ?? err}` };
  }
  const table = parsed?.substrate?.provider?.grants;
  if (table === undefined || table === null) return { grants };
  if (typeof table !== 'object' || Array.isArray(table)) {
    return { grants, error: `substrate.provider.grants in ${configPath} is not a map of atespace to references` };
  }
  const skipped: string[] = [];
  for (const [key, list] of Object.entries(table as Record<string, unknown>)) {
    if (!isGrantKey(key) || !Array.isArray(list)) {
      skipped.push(key);
      continue;
    }
    const refs = new Set<string>();
    for (const ref of list) {
      const p = typeof ref === 'string' ? parseAquamanRef(ref) : null;
      if (p && !isReservedService(p.service)) refs.add(ref as string);
      else skipped.push(`${key}: ${String(ref)}`);
    }
    grants.set(key, refs);
  }
  return skipped.length > 0
    ? { grants, error: `substrate.provider.grants in ${configPath} has entries that grant nothing: ${skipped.slice(0, 5).join(', ')}` }
    : { grants };
}

/** Re-read the grants only when the file changes, so an edit reaches a running daemon. */
export function watchedSubstrateGrants(configPath: string): () => SubstrateGrants {
  let stamp: string | null | undefined;
  let cached: SubstrateGrants = { grants: new Map() };
  return () => {
    let now: string | null;
    try {
      const s = fs.statSync(configPath);
      now = `${s.mtimeMs}:${s.size}:${s.ino}`;
    } catch {
      now = null;
    }
    if (now !== stamp) {
      cached = now === null ? { grants: new Map() } : loadSubstrateGrants(configPath);
      stamp = now;
    }
    return cached;
  };
}

/** Whether the grants give `ref` to this actor: through its atespace or through the actor itself. */
export function isGranted(grants: SubstrateGrants, who: ActorIdentity, ref: string): boolean {
  return (grants.grants.get(who.atespace)?.has(ref) ?? false)
    || (grants.grants.get(`${who.atespace}/${who.actor}`)?.has(ref) ?? false);
}
