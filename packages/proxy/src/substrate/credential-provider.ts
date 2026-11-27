/**
 * Agent Substrate credential provider: the transport-free core.
 *
 * Agent Substrate runs sandboxed agents ("actors") on Kubernetes. Its egress
 * gateway terminates an actor's TLS and replaces a placeholder header with a
 * credential it fetches from a provider plugin: one call, `FetchSecret(uri,
 * actor_spiffe_id)`, on every request that carries the placeholder. Substrate
 * does the isolation and the injection; aquaman supplies the value from the
 * vault, decides which actor may have it and records each fetch.
 *
 * The order of the checks is the point. Everything that can refuse does so
 * before the vault is read, so a refusal says nothing about what the vault
 * holds: the URI, the actor's identity, the reserved service, the grant.
 * Then the vault, then the audit entry, and only then the value.
 *
 * The gateway turns `not_found` and `permission_denied` into a 403 for the
 * actor and `unavailable` into a 503, and writes the message into its own
 * log. Messages therefore name references and fixes, never a value.
 */

import type { CredentialStore } from '../core/credentials/store.js';
import { isVaultLocked, VAULT_UNLOCK_FIX } from '../core/credentials/vault-lock.js';
import { formatAquamanRef, reservedServiceRefusal } from '../broker-scope.js';
import { isGranted, parseActorSpiffeId, parseSecretUri, type ActorIdentity, type SubstrateGrants } from './grants.js';

export type ProviderErrorCode = 'invalid_argument' | 'permission_denied' | 'not_found' | 'failed_precondition' | 'unavailable';

/** A refusal or failure carried back to the gateway (mapped to a gRPC status by the transport). */
export class ProviderError extends Error {
  constructor(readonly code: ProviderErrorCode, message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** One fetch, for the audit log. Never carries a credential value. */
export interface ProviderAccessEvent {
  /** The reference, when the URI named one. */
  ref?: string;
  service?: string;
  /** The actor, when its identity could be read. */
  actor?: ActorIdentity;
  success: boolean;
  error?: string;
}

export interface SubstrateProviderOptions {
  store: CredentialStore;
  /** The provider's name in secret URIs: `ate-secret://<name>/...`. */
  providerName: string;
  /** Trust domain of actor identities. */
  actorTrustDomain: string;
  /** The grants as they are now; called on every fetch. */
  grants: () => SubstrateGrants;
  /**
   * How many fetches one actor may be served per second. The gateway fetches
   * on every request an actor sends, each served fetch waits for its audit
   * entry, and the log is one file for all actors: without a bound, one actor
   * that sends as fast as it can holds up everyone else's fetches.
   */
  fetchesPerSecond?: number;
  /**
   * The same bound for all actors of one atespace together. An actor's name
   * is whatever its atespace made it, so a tenant with many actors would
   * otherwise have the rate once per actor. Default: four times the actor's.
   */
  atespaceFetchesPerSecond?: number;
  now?: () => number;
  /**
   * Writes the audit entry. If it throws or rejects for a successful fetch,
   * the entry was not written and the value is not returned.
   */
  onAccess?: (event: ProviderAccessEvent) => unknown;
}

export interface FetchSecretRequest {
  uri?: string;
  actor_spiffe_id?: string;
}

export interface SubstrateProviderCore {
  fetchSecret(req: FetchSecretRequest): Promise<Buffer>;
}

/** A value the gateway will put into a header: not empty, and no control characters. */
function isInjectable(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Default for `fetchesPerSecond`; a burst of twice that is let through. */
export const DEFAULT_FETCHES_PER_SECOND = 20;

/**
 * A token bucket per actor: `rate` fetches a second, `2 * rate` at once. At
 * most `maxActors` are remembered; the one that asked longest ago goes first,
 * and starts again with a full bucket if it comes back.
 */
export function createFetchRateLimit(rate: number, now: () => number = Date.now, maxActors = 4096): (actor: string) => boolean {
  const burst = Math.max(1, rate * 2);
  const buckets = new Map<string, { tokens: number; at: number }>();
  return (actor) => {
    const t = now();
    const b = buckets.get(actor) ?? { tokens: burst, at: t };
    // A clock that was set back adds nothing; it must not take tokens away.
    b.tokens = Math.min(burst, b.tokens + (Math.max(0, t - b.at) / 1000) * rate);
    b.at = t;
    buckets.delete(actor);
    buckets.set(actor, b);
    while (buckets.size > maxActors) buckets.delete(buckets.keys().next().value as string);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

/** Text that is not aquaman's own, for a message or a log line: printable ASCII, bounded. */
export function shown(text: unknown): string {
  const s = typeof text === 'string' ? text : '';
  return JSON.stringify(s.replace(/[^\x20-\x7e]/g, '?').slice(0, 120));
}

export function createSubstrateProviderCore(opts: SubstrateProviderOptions): SubstrateProviderCore {
  const { store, onAccess } = opts;
  const rate = opts.fetchesPerSecond ?? DEFAULT_FETCHES_PER_SECOND;
  const atespaceRate = opts.atespaceFetchesPerSecond ?? rate * 4;
  const actorWithinRate = createFetchRateLimit(rate, opts.now);
  // Only an atespace that has a grant gets this far, so these are as many as the grants file names.
  const atespaceWithinRate = createFetchRateLimit(atespaceRate, opts.now);

  const record = async (e: ProviderAccessEvent): Promise<boolean> => {
    try {
      await onAccess?.(e);
      return true;
    } catch (err) {
      console.error(`AUDIT FAILURE: could not record the Agent Substrate fetch of ${e.ref ?? 'an unreadable URI'}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  // A refusal hands nothing out, so it stands even when its entry cannot be written.
  const refuse = async (code: ProviderErrorCode, message: string, e: Omit<ProviderAccessEvent, 'success' | 'error'>): Promise<never> => {
    await record({ ...e, success: false, error: message });
    throw new ProviderError(code, `aquaman: ${message}`);
  };

  return {
    async fetchSecret(req) {
      // The actor first: a request that cannot be read otherwise is then on that actor's account.
      const actor = parseActorSpiffeId(req.actor_spiffe_id ?? '', opts.actorTrustDomain);
      const parsed = parseSecretUri(req.uri ?? '', opts.providerName);
      if (!parsed) {
        return refuse('invalid_argument',
          `${shown(req.uri)} is not a secret URI of the form ate-secret://${opts.providerName}/<service>/<key>`, actor ? { actor } : {});
      }
      const { service, key } = parsed;
      const ref = formatAquamanRef(service, key);
      if (!actor) {
        return refuse('permission_denied',
          `${shown(req.actor_spiffe_id)} is not an actor identity of the form spiffe://${opts.actorTrustDomain}/actor/<atespace>/<actor>, so ${ref} is not handed out`,
          { ref, service });
      }
      const who = { ref, service, actor };

      const reserved = reservedServiceRefusal(service, key);
      if (reserved) return refuse('permission_denied', `${reserved.reason}. Fix: ${reserved.fix}`, who);

      if (!isGranted(opts.grants(), actor, ref)) {
        return refuse('permission_denied',
          `${ref} is not granted to atespace ${actor.atespace} or to its actor ${actor.actor}. ` +
          `Fix: list it under substrate.provider.grants.${actor.atespace} in aquaman's config.yaml`,
          who);
      }

      // Counted only for what is granted: a refusal above costs no vault read and no place in the log's queue.
      // The actor's own bound first: what it is refused here does not count
      // against its atespace, so one actor over its rate cannot use up what
      // its neighbours in the atespace are entitled to.
      if (!actorWithinRate(`${actor.atespace}/${actor.actor}`)) {
        return refuse('unavailable',
          `actor ${actor.actor} in atespace ${actor.atespace} is over ${rate} fetches a second, so this one was not served. ` +
          'Fix: send fewer requests that carry the placeholder, or raise substrate.provider.fetchesPerSecond',
          who);
      }
      if (!atespaceWithinRate(actor.atespace)) {
        return refuse('unavailable',
          `atespace ${actor.atespace} is over ${atespaceRate} fetches a second across its actors, so this one was not served. ` +
          'Fix: send fewer requests that carry the placeholder, or raise substrate.provider.atespaceFetchesPerSecond',
          who);
      }

      let value: string | null;
      try {
        value = await store.get(service, key);
      } catch (err) {
        if (isVaultLocked(err)) {
          return refuse('unavailable', `the vault is locked, so ${ref} cannot be read. Fix: ${err.fix ?? VAULT_UNLOCK_FIX}`, who);
        }
        // What a backend says is its own text (a server's response body, for one), so it is shown as caller text is.
        return refuse('unavailable', `the vault could not be read for ${ref}: ${shown(err instanceof Error ? err.message : String(err))}`, who);
      }
      if (value === null) {
        return refuse('not_found', `${ref} is not in the vault. Fix: aquaman credentials add ${service} ${key}`, who);
      }
      if (!isInjectable(value)) {
        return refuse('failed_precondition',
          `the stored value of ${ref} is empty or has a control character (a line break, for one), and the gateway does not put such a value into a header. Fix: store it again without the line break: aquaman credentials add ${service} ${key}`,
          who);
      }

      // A value leaves the provider only once its read is on record.
      if (!(await record({ ...who, success: true }))) {
        throw new ProviderError('unavailable',
          `aquaman: the audit log could not be written, so ${ref} was not handed out. Fix: check that the audit directory is writable and the disk is not full, then run: aquaman doctor`);
      }
      return Buffer.from(value, 'utf-8');
    },
  };
}
