/**
 * Glue between `aquaman daemon` / the CLI and the Agent Substrate credential
 * provider: settings with their defaults, the audit entries, and the start.
 */

import type { WrapperConfig } from '../core/types.js';
import type { CredentialStore } from '../core/credentials/store.js';
import { getConfigPath } from '../core/utils/config.js';
import { createSubstrateProviderCore, DEFAULT_FETCHES_PER_SECOND, type ProviderAccessEvent } from './credential-provider.js';
import { watchedSubstrateGrants } from './grants.js';
import { startSubstrateProviderServer, type SubstrateProviderServer, type SubstrateTlsFiles } from './grpc-server.js';

/** The egress gateway's identity in a stock Substrate install. */
export const DEFAULT_CALLER_SPIFFE_ID = 'spiffe://cluster.local/ns/ate-system/sa/atenet-egress';
/** The trust domain Substrate gives actor identities. */
export const DEFAULT_ACTOR_TRUST_DOMAIN = 'substrate-actor.local';
export const DEFAULT_PROVIDER_NAME = 'aquaman';
export const DEFAULT_LISTEN = '0.0.0.0:50051';
/** Audit `agentId` of every entry this provider writes. */
export const SUBSTRATE_AGENT_ID = 'substrate';
/** Audit service of an entry that names no reference: an unreadable URI, a refused caller. */
export const SUBSTRATE_AUDIT_SERVICE = 'aquaman-substrate';

export interface SubstrateProviderSettings {
  listen: string;
  name: string;
  tls: SubstrateTlsFiles;
  callerSpiffeId: string;
  actorTrustDomain: string;
  fetchesPerSecond: number;
  atespaceFetchesPerSecond: number;
}

/**
 * The provider's settings with defaults applied, or the reason they cannot
 * be used. The TLS files have no default: a listener on the network does not
 * start on a guess about where its certificates are.
 */
export function substrateProviderSettings(config: WrapperConfig): SubstrateProviderSettings | { error: string } {
  const p = config.substrate?.provider;
  const certFile = p?.tls?.certFile;
  const clientCaFile = p?.tls?.clientCaFile;
  if (!certFile || !clientCaFile) {
    return { error: 'substrate.provider.tls.certFile and substrate.provider.tls.clientCaFile must be set in config.yaml' };
  }
  const name = p?.name ?? DEFAULT_PROVIDER_NAME;
  if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(name)) {
    return { error: `substrate.provider.name ${JSON.stringify(name)} is not a name Substrate accepts for a provider (lower-case letters, digits, "-" and ".")` };
  }
  const callerSpiffeId = p?.callerSpiffeId ?? DEFAULT_CALLER_SPIFFE_ID;
  if (!/^spiffe:\/\/[a-z0-9._-]+\/[\x21-\x7e]+$/.test(callerSpiffeId)) {
    return { error: `substrate.provider.callerSpiffeId ${JSON.stringify(callerSpiffeId)} is not a SPIFFE ID` };
  }
  const actorTrustDomain = p?.actorTrustDomain ?? DEFAULT_ACTOR_TRUST_DOMAIN;
  if (!/^[a-z0-9._-]+$/.test(actorTrustDomain)) {
    return { error: `substrate.provider.actorTrustDomain ${JSON.stringify(actorTrustDomain)} is not a trust domain` };
  }
  const listen = p?.listen ?? DEFAULT_LISTEN;
  if (!/^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):\d{1,5}$/.test(listen)) {
    return { error: `substrate.provider.listen ${JSON.stringify(listen)} is not host:port` };
  }
  const fetchesPerSecond = p?.fetchesPerSecond ?? DEFAULT_FETCHES_PER_SECOND;
  if (typeof fetchesPerSecond !== 'number' || !Number.isFinite(fetchesPerSecond) || fetchesPerSecond < 1 || fetchesPerSecond > 10_000) {
    return { error: `substrate.provider.fetchesPerSecond ${JSON.stringify(fetchesPerSecond)} is not a number between 1 and 10000` };
  }
  const atespaceFetchesPerSecond = p?.atespaceFetchesPerSecond ?? fetchesPerSecond * 4;
  if (typeof atespaceFetchesPerSecond !== 'number' || !Number.isFinite(atespaceFetchesPerSecond) || atespaceFetchesPerSecond < fetchesPerSecond || atespaceFetchesPerSecond > 100_000) {
    return { error: `substrate.provider.atespaceFetchesPerSecond ${JSON.stringify(atespaceFetchesPerSecond)} is not a number between fetchesPerSecond (${fetchesPerSecond}) and 100000` };
  }
  return { listen, name, tls: { certFile, keyFile: p?.tls?.keyFile ?? certFile, clientCaFile }, callerSpiffeId, actorTrustDomain, fetchesPerSecond, atespaceFetchesPerSecond };
}

export interface AuditSink {
  logCredentialAccess(
    sessionId: string,
    agentId: string,
    access: { service: string; operation: 'read' | 'use' | 'rotate'; success: boolean; error?: string; note?: string },
  ): unknown;
}

/**
 * Decides which refusals get an entry of their own. The gateway asks on
 * every request an actor sends, so an actor that keeps asking for what it may
 * not have writes as fast as it asks, and a log that rotates and prunes would
 * lose its older entries to that. Three bounds per window:
 *
 *   - per session, the same refusal (same reference, same reason) is written once;
 *   - per session, at most `budget` different refusals are written;
 *   - over all sessions, at most `overallBudget` refusals are written, because
 *     a tenant can have as many actors, and so sessions, as it likes.
 *
 * A session is an actor, `system` for a request with no readable actor, or
 * `caller` for a connection that was not the gateway's. The last two are one
 * session each and stand outside the overall bound, so that actors, however
 * many, cannot use up the entries that would name a refused caller.
 *
 * What is left out is counted, and `flush()` hands the counts over to be
 * written as summary entries: how many, not which. Served fetches never come
 * here.
 */
export interface RefusalLimiter {
  /** Whether this refusal gets its own entry. */
  admit(session: string, kind: string): boolean;
  /**
   * The counts of what was left out since the last call, cleared: `caller`
   * and `system` by name, then at most `maxSummaries` actors by name, largest
   * first, and the other actors together as `OTHER_ACTORS`.
   */
  flush(): Array<{ session: string; leftOut: number }>;
  /** Put counts back that could not be written, so the next flush has them. */
  restore(counts: Array<{ session: string; leftOut: number }>): void;
}

export interface RefusalLimiterOptions {
  windowMs?: number;
  /** Different refusals written per session per window. */
  budget?: number;
  /** Refusals written per window over all sessions. */
  overallBudget?: number;
  maxSessions?: number;
  /** Sessions named in one flush. */
  maxSummaries?: number;
  now?: () => number;
}

export const DEFAULT_REFUSAL_WINDOW_MS = 60_000;
export const DEFAULT_REFUSAL_BUDGET = 20;
export const DEFAULT_REFUSAL_OVERALL_BUDGET = 240;
/** Audit session of a connection that was refused because it was not the gateway's. */
export const CALLER_SESSION = 'caller';
/** Audit session of a request whose actor could not be read. */
export const SYSTEM_SESSION = 'system';
/** Audit session of the summary for actors that are not named one by one. */
export const OTHER_ACTORS = 'actors';
const OUTSIDE_OVERALL = new Set([CALLER_SESSION, SYSTEM_SESSION]);

export function createRefusalLimiter(options: RefusalLimiterOptions = {}): RefusalLimiter {
  const windowMs = options.windowMs ?? DEFAULT_REFUSAL_WINDOW_MS;
  const budget = options.budget ?? DEFAULT_REFUSAL_BUDGET;
  const overallBudget = options.overallBudget ?? DEFAULT_REFUSAL_OVERALL_BUDGET;
  const maxSessions = options.maxSessions ?? 4096;
  const maxSummaries = options.maxSummaries ?? 50;
  const now = options.now ?? Date.now;
  type State = { since: number; kinds: Set<string>; leftOut: number };
  // Actors, forgotten oldest first when there are too many.
  const sessions = new Map<string, State>();
  // `caller` and `system` are kept apart from the actors, so that no number of actors can make them be forgotten.
  const fixed = new Map<string, State>([...OUTSIDE_OVERALL].map((name) => [name, { since: now(), kinds: new Set<string>(), leftOut: 0 }]));
  let overall = { since: now(), written: 0 };
  // What sessions dropped from memory had left out; it is reported, without their names.
  let forgotten = 0;
  // A window that has run its time, or whose start is in the future because the clock was set back.
  const over = (since: number, t: number) => t < since || t - since >= windowMs;
  return {
    admit(session, kind) {
      const t = now();
      if (over(overall.since, t)) overall = { since: t, written: 0 };
      let s = fixed.get(session);
      const shared = s === undefined;
      if (!s) {
        s = sessions.get(session) ?? { since: t, kinds: new Set(), leftOut: 0 };
        // Re-inserted, so the map stays ordered by who was seen last.
        sessions.delete(session);
        sessions.set(session, s);
        while (sessions.size > maxSessions) {
          const [oldest, state] = sessions.entries().next().value as [string, State];
          sessions.delete(oldest);
          forgotten += state.leftOut;
        }
      }
      if (over(s.since, t)) {
        s.since = t;
        s.kinds.clear();
      }
      if (s.kinds.has(kind) || s.kinds.size >= budget || (shared && overall.written >= overallBudget)) {
        s.leftOut++;
        return false;
      }
      s.kinds.add(kind);
      if (shared) overall.written++;
      return true;
    },
    flush() {
      const t = now();
      const named: Array<{ session: string; leftOut: number }> = [];
      for (const [session, s] of fixed) {
        if (s.leftOut > 0) named.push({ session, leftOut: s.leftOut });
        s.leftOut = 0;
      }
      const actors: Array<{ session: string; leftOut: number }> = [];
      for (const [session, s] of sessions) {
        if (s.leftOut > 0) {
          actors.push({ session, leftOut: s.leftOut });
          s.leftOut = 0;
        } else if (over(s.since, t)) {
          sessions.delete(session);
        }
      }
      actors.sort((a, b) => b.leftOut - a.leftOut);
      const rest = actors.slice(maxSummaries).reduce((n, c) => n + c.leftOut, 0) + forgotten;
      forgotten = 0;
      return [...named, ...actors.slice(0, maxSummaries), ...(rest > 0 ? [{ session: OTHER_ACTORS, leftOut: rest }] : [])];
    },
    restore(counts) {
      for (const { session, leftOut } of counts) {
        const s = fixed.get(session) ?? sessions.get(session);
        if (s) s.leftOut += leftOut;
        else forgotten += leftOut;
      }
    },
  };
}

const sessionOf = (e: ProviderAccessEvent): string => (e.actor ? `actor/${e.actor.atespace}/${e.actor.actor}` : SYSTEM_SESSION);

/**
 * One entry per served fetch, and per refusal as the limiter admits them. The
 * actor is the entry's session, so the log says who a value was fetched for,
 * and `note` names the reference: the service alone would not say which key.
 */
export function auditProviderAccess(audit: AuditSink, e: ProviderAccessEvent, refusals?: RefusalLimiter): unknown {
  const session = sessionOf(e);
  const error = e.success ? undefined : (e.error ?? 'refused');
  if (!e.success && refusals && !refusals.admit(session, `${e.ref ?? ''}\n${error}`)) return undefined;
  // Returned so the provider can tell whether the entry was written.
  return audit.logCredentialAccess(session, SUBSTRATE_AGENT_ID, {
    service: e.service ?? SUBSTRATE_AUDIT_SERVICE,
    operation: 'read',
    success: e.success,
    error,
    note: e.ref,
  });
}

/**
 * One entry per count, for refusals that got none of their own: how many for
 * which session, not which references. Returns the counts that could not be
 * written, each tried on its own.
 */
export async function auditLeftOutRefusals(
  audit: AuditSink, counts: Array<{ session: string; leftOut: number }>,
): Promise<Array<{ session: string; leftOut: number }>> {
  const unwritten: Array<{ session: string; leftOut: number }> = [];
  for (const count of counts) {
    try {
      await audit.logCredentialAccess(count.session, SUBSTRATE_AGENT_ID, {
        service: SUBSTRATE_AUDIT_SERVICE,
        operation: 'read',
        success: false,
        error: `${count.leftOut} more refusals were not written one by one`,
      });
    } catch {
      unwritten.push(count);
    }
  }
  return unwritten;
}

export async function startSubstrateProvider(opts: {
  config: WrapperConfig;
  store: CredentialStore;
  audit: AuditSink;
  configPath?: string;
  /** How long the same refusal is left out of the audit log after one entry. Default one minute. */
  refusalWindowMs?: number;
}): Promise<SubstrateProviderServer> {
  const settings = substrateProviderSettings(opts.config);
  if ('error' in settings) throw new Error(settings.error);
  // Every fetch this provider serves is to be on record. With the log switched
  // off the logger answers as if it had written, so the provider does not start.
  if (opts.config.audit && !opts.config.audit.enabled) {
    throw new Error('audit.enabled is not true, and the provider hands out a value only after its audit entry is written. Set audit.enabled: true in config.yaml');
  }
  const refusals = createRefusalLimiter({ windowMs: opts.refusalWindowMs });
  let stopped = false;
  let flushing: Promise<void> | null = null;
  const writeLeftOutOnce = async (): Promise<void> => {
    const unwritten = await auditLeftOutRefusals(opts.audit, refusals.flush());
    if (unwritten.length === 0) return;
    const total = unwritten.reduce((n, c) => n + c.leftOut, 0);
    // Kept for the next try, unless there is none: then the number at least is on stderr.
    if (!stopped) refusals.restore(unwritten);
    console.error(`AUDIT FAILURE: could not record ${total} Agent Substrate refusals that were left out${stopped ? '' : '; they are kept for the next try'}`);
  };
  // One at a time: a tick that finds the last one still writing does nothing, so slow writes cannot pile up.
  const writeLeftOut = (): Promise<void> => {
    flushing ??= writeLeftOutOnce().finally(() => { flushing = null; });
    return flushing;
  };
  const grants = watchedSubstrateGrants(opts.configPath ?? getConfigPath());
  const grantsProblem = grants().error;
  if (grantsProblem) console.error(`  ⚠ Agent Substrate credential provider: ${grantsProblem}`);
  const core = createSubstrateProviderCore({
    store: opts.store,
    providerName: settings.name,
    actorTrustDomain: settings.actorTrustDomain,
    grants,
    fetchesPerSecond: settings.fetchesPerSecond,
    atespaceFetchesPerSecond: settings.atespaceFetchesPerSecond,
    onAccess: (e) => auditProviderAccess(opts.audit, e, refusals),
  });
  const server = await startSubstrateProviderServer(core, {
    listen: settings.listen,
    tls: settings.tls,
    callerSpiffeId: settings.callerSpiffeId,
    // The identity it presented decides whether this is a new refusal; its address is in the entry but
    // not in that decision, or one caller would be a new refusal with every connection it opens.
    onCallerRefused: async (reason, from) => {
      if (!refusals.admit(CALLER_SESSION, reason)) return;
      try {
        await opts.audit.logCredentialAccess(CALLER_SESSION, SUBSTRATE_AGENT_ID, {
          service: SUBSTRATE_AUDIT_SERVICE, operation: 'read', success: false, error: `${reason}, from ${from}`,
        });
      } catch (err) {
        console.error(`AUDIT FAILURE: could not record a refused Agent Substrate caller (${reason}, from ${from}): ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
  const timer = setInterval(() => { void writeLeftOut(); }, opts.refusalWindowMs && opts.refusalWindowMs > 0 ? opts.refusalWindowMs : DEFAULT_REFUSAL_WINDOW_MS);
  timer.unref();
  return {
    ...server,
    async stop() {
      clearInterval(timer);
      // The listener first: a call still being answered can add to the counts.
      await server.stop();
      // A flush already writing finishes (and may put counts back) before the last one starts. The last
      // one is given a few seconds and no more: an audit log that does not answer must not hold up a shutdown.
      let late: ReturnType<typeof setTimeout> | undefined;
      const patience = new Promise<void>((resolve) => { late = setTimeout(resolve, 5000); late.unref(); });
      await Promise.race([
        (async () => {
          if (flushing) await flushing;
          stopped = true;
          await writeLeftOut();
        })(),
        patience,
      ]);
      if (late) clearTimeout(late);
      stopped = true;
    },
  };
}
