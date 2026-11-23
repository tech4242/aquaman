/**
 * Credential-broker scoping (v0.15.0).
 *
 * `POST /broker/resolve` is the one endpoint where the proxy hands a
 * credential VALUE to its caller instead of injecting it on egress. Through
 * v0.14.x it served any service/key in the vault, in every mode, to any
 * process that could reach the socket — including an OpenClaw agent's exec
 * tool (`curl --unix-socket ~/.aquaman/proxy.sock ...`), which is the ClawScan
 * finding against aquaman-plugin 0.14.x. The rules now:
 *
 *   1. OpenClaw-hosted proxies (`openclaw plugin-mode`, `openclaw start`) are
 *      built without a scope, so the broker is off: the OpenClaw path never
 *      materializes a credential.
 *   2. `aquaman daemon` materializes only refs the user DECLARED for
 *      materialization: the env refs in projects.yaml (coding agents) plus
 *      `broker.allowedRefs` in config.yaml (e.g. Hermes secret-source
 *      bindings). Everything else is refused.
 *   3. Over the loopback listener, the LLM-provider services Hermes reaches
 *      through the proxy are never materialized, declared or not. They stay
 *      on the proxy path. This is the same two-tier rule the Hermes client
 *      enforces, but checked server-side.
 *
 * The scope is checked before any vault lookup, so a refusal says nothing
 * about what the vault holds. Declared refs are re-read when projects.yaml or
 * config.yaml changes (mtime-cached), so `aquaman coder project add` and
 * `aquaman broker allow` take effect without restarting the daemon.
 *
 * Threat model, honestly stated: every process running as the same user can
 * reach the socket and can edit ~/.aquaman/*. Declaring a ref is an explicit
 * opt-in to handing that credential to same-user processes. The broker scope
 * keeps undeclared credentials, and the ones the proxy isolates for agent
 * hosts, out of reach. It is not a boundary between processes of one user.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { getConfigDir } from './core/utils/config.js';
import { isReservedService, RESERVED_SERVICE } from './core/credentials/reserved.js';

/** `aquaman://service/key` — same grammar as the daemon's service/key validation. */
const AQUAMAN_REF = /^aquaman:\/\/([a-z0-9][a-z0-9._-]*)\/([a-zA-Z0-9][a-zA-Z0-9._-]*)$/;

export function parseAquamanRef(ref: string): { service: string; key: string } | null {
  const m = AQUAMAN_REF.exec(ref);
  return m ? { service: m[1], key: m[2] } : null;
}

export function formatAquamanRef(service: string, key: string): string {
  return `aquaman://${service}/${key}`;
}

/**
 * The service name aquaman keeps its own records under in the credential
 * store (the audit log's anchor). It has no hyphen: 1Password item names
 * join service and key with one, and a hyphen in the service name would be
 * read back as part of the key.
 */
export { RESERVED_SERVICE };

/**
 * Whether a service name is reserved for aquaman's own records. A reserved
 * service is never declared, resolved, requested, routed, forwarded for,
 * added or deleted on a caller's behalf: a caller that could write it could
 * move the audit anchor, and one that could read it has no use for it.
 *
 * Every entry point that takes a service name from a caller asks this one
 * function. The look-alike spellings are reserved too, so nothing a caller
 * stores can be mistaken for the real record.
 */
export { isReservedService };

/**
 * The refusal for a reference to a reserved service, or `null` for any other.
 * The broker scope answers with it, and so does each endpoint that takes a
 * reference without going through the scope.
 */
export function reservedServiceRefusal(service: string, key: string):
  { allowed: false; code: 'broker_ref_reserved'; reason: string; fix: string } | null {
  if (!isReservedService(service)) return null;
  return {
    allowed: false,
    code: 'broker_ref_reserved',
    reason: `${formatAquamanRef(service, key)} is not handed out: "${service}" ${RESERVED_SERVICE_REASON}`,
    fix: 'Use a different service name. To check the audit log against its anchor, run: aquaman audit verify',
  };
}

/** The rest of a sentence that starts with the name, for every refusal. */
export const RESERVED_SERVICE_REASON = "is reserved for aquaman's own records and cannot be used as a credential";

/** A well-formed ref that names a service a caller may declare. */
function isDeclarableRef(ref: unknown): ref is string {
  const parsed = typeof ref === 'string' ? parseAquamanRef(ref) : null;
  return parsed !== null && !isReservedService(parsed.service);
}

/** Default location of the coding-agent project map (honors AQUAMAN_CONFIG_DIR). */
export function defaultProjectsPath(): string {
  return path.join(getConfigDir(), 'projects.yaml');
}

export interface DeclaredRefsResult {
  /** Set of `aquaman://service/key` strings. */
  refs: Set<string>;
  /**
   * Refs a project binds through the proxy (a `routes` entry in projects.yaml).
   * A program bound this way is given the proxy's address, never the value, so
   * these are not declared for materialization unless something else declares them.
   */
  routedRefs?: Set<string>;
  /** Parse problem, if the file exists but can't be read as a project map. Fails closed. */
  error?: string;
}

/**
 * Collect every `aquaman://` ref declared in a projects.yaml env map. A
 * missing file declares nothing. A malformed file declares nothing and
 * reports why, so the broker fails closed instead of guessing.
 */
export function loadProjectRefs(projectsPath: string = defaultProjectsPath()): DeclaredRefsResult {
  let raw: string;
  try {
    raw = fs.readFileSync(projectsPath, 'utf-8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { refs: new Set() };
    return { refs: new Set(), error: `cannot read ${projectsPath}: ${err?.message ?? err}` };
  }

  let parsed: any;
  try {
    parsed = parseYaml(raw);
  } catch (err: any) {
    return { refs: new Set(), error: `cannot parse ${projectsPath}: ${err?.message ?? err}` };
  }

  const refs = new Set<string>();
  const routedRefs = new Set<string>();
  const projects = parsed && typeof parsed === 'object' ? parsed.projects : undefined;
  if (!projects || typeof projects !== 'object') return { refs };

  for (const cfg of Object.values(projects) as any[]) {
    const env = cfg && typeof cfg === 'object' ? cfg.env : undefined;
    if (!env || typeof env !== 'object') continue;
    const routes = cfg.routes && typeof cfg.routes === 'object' && !Array.isArray(cfg.routes) ? cfg.routes : {};
    for (const [envName, ref] of Object.entries(env)) {
      // A reserved ref in a project map declares nothing and routes nothing.
      if (!isDeclarableRef(ref)) continue;
      const route = Object.hasOwn(routes, envName) ? routes[envName] : undefined;
      if (route && typeof route === 'object' && typeof route.url_env === 'string') routedRefs.add(ref);
      else refs.add(ref);
    }
  }
  return { refs, routedRefs };
}

/**
 * Read `broker.allowedRefs` straight from a config.yaml file (not via
 * loadConfig, which would also apply env overrides and defaults). Missing
 * file or key declares nothing. A malformed file declares nothing and says why.
 */
export function loadConfigAllowedRefs(configPath: string): DeclaredRefsResult {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { refs: new Set() };
    return { refs: new Set(), error: `cannot read ${configPath}: ${err?.message ?? err}` };
  }
  let parsed: any;
  try {
    parsed = parseYaml(raw);
  } catch (err: any) {
    return { refs: new Set(), error: `cannot parse ${configPath}: ${err?.message ?? err}` };
  }
  const list = parsed?.broker?.allowedRefs;
  const refs = new Set<string>();
  if (Array.isArray(list)) {
    for (const ref of list) if (isDeclarableRef(ref)) refs.add(ref);
  }
  return { refs };
}

/** Re-load a declared-refs file only when its mtime changes. */
function mtimeCached(file: string, load: (file: string) => DeclaredRefsResult): () => DeclaredRefsResult {
  let cachedMtimeMs: number | null | undefined; // undefined = never loaded; null = file absent
  let cached: DeclaredRefsResult = { refs: new Set() };
  return () => {
    let mtimeMs: number | null;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      mtimeMs = null;
    }
    if (mtimeMs !== cachedMtimeMs) {
      cached = mtimeMs === null ? { refs: new Set() } : load(file);
      cachedMtimeMs = mtimeMs;
    }
    return cached;
  };
}

export type BrokerCaller = 'uds' | 'loopback';

export type BrokerDecision =
  | { allowed: true }
  | { allowed: false; code: 'broker_ref_not_declared' | 'broker_ref_isolated' | 'broker_ref_reserved'; reason: string; fix: string };

export interface BrokerScopeOptions {
  /** projects.yaml to read declared refs from. Default: `<configDir>/projects.yaml`. */
  projectsPath?: string;
  /** config.yaml whose `broker.allowedRefs` are declared refs (re-read on change). */
  configPath?: string;
  /** Additional static declared refs. Invalid entries are ignored. */
  allowedRefs?: readonly string[];
  /** Services never materialized over the loopback listener (the Hermes LLM-provider tier). */
  loopbackDeniedServices?: readonly string[];
  /**
   * The credential store's `itemIdentity`, where it has one: the backend's
   * own name for the item a reference is kept in, which links play no part
   * in. On such a store two references can be one item, so a rule about a
   * service has to hold for every name its items can be asked for under.
   */
  itemIdentity?: (service: string, key: string) => string | undefined;
}

export interface BrokerScope {
  check(service: string, key: string, caller: BrokerCaller): BrokerDecision;
  /** Every currently declared ref, with where it came from. For `aquaman broker list` and startup logs. */
  declared(): { ref: string; source: 'projects.yaml' | 'config.yaml' }[];
  /** Parse problems with the declaring files, if any (the broker fails closed for their refs). */
  declarationError(): string | undefined;
  /**
   * Refs some project binds through the proxy. The daemon forwards for their
   * services to a program holding the route token, and hands their values to
   * nobody: `check()` answers for these only if they are declared some other way.
   */
  routedRefs?(): ReadonlySet<string>;
}

export function createBrokerScope(opts: BrokerScopeOptions = {}): BrokerScope {
  const projectRefs = mtimeCached(opts.projectsPath ?? defaultProjectsPath(), loadProjectRefs);
  const configFileRefs = opts.configPath ? mtimeCached(opts.configPath, loadConfigAllowedRefs) : () => ({ refs: new Set<string>() }) as DeclaredRefsResult;
  const staticRefs = new Set((opts.allowedRefs ?? []).filter(isDeclarableRef));
  const loopbackDenied = new Set(opts.loopbackDeniedServices ?? []);

  /**
   * The isolated service whose items `<service>/<key>` is read from, if any.
   * By name, and where the store joins service and key into one item name
   * also by that name: `<isolated>/<any key>` begins with the same text
   * whatever the key, and a reference of another service whose item name
   * begins with it is one of that service's items under a second name.
   */
  const isolatedService = (service: string, key: string): string | undefined => {
    if (loopbackDenied.has(service)) return service;
    const item = opts.itemIdentity?.(service, key);
    if (item === undefined) return undefined;
    for (const denied of loopbackDenied) {
      const probe = opts.itemIdentity?.(denied, 'k');
      if (probe !== undefined && probe.endsWith('k') && item.startsWith(probe.slice(0, -1))) return denied;
    }
    return undefined;
  };

  const configRefs = (): DeclaredRefsResult => {
    const fromFile = configFileRefs();
    return { refs: new Set([...staticRefs, ...fromFile.refs]), error: fromFile.error };
  };
  const errors = (): string | undefined => {
    const e = [projectRefs().error, configRefs().error].filter(Boolean);
    return e.length ? e.join('; ') : undefined;
  };

  return {
    check(service, key, caller) {
      const ref = formatAquamanRef(service, key);

      // First, and whatever the declaring files say.
      const reserved = reservedServiceRefusal(service, key);
      if (reserved) return reserved;

      const isolated = caller === 'loopback' ? isolatedService(service, key) : undefined;
      if (isolated !== undefined) {
        return {
          allowed: false,
          code: 'broker_ref_isolated',
          reason: isolated === service
            ? `${ref} is not materialized over the loopback listener: ${service} keys stay process-isolated on the proxy path`
            : `${ref} is not materialized over the loopback listener: it is read from the same vault item as a ${isolated} key, and ${isolated} keys stay process-isolated on the proxy path`,
          fix: `Keep ${isolated} on the proxy path (base URL + placeholder key in ~/.hermes/.env) and remove the binding from your Hermes secrets config`,
        };
      }

      if (projectRefs().refs.has(ref) || configRefs().refs.has(ref)) return { allowed: true };

      if (projectRefs().routedRefs?.has(ref)) {
        return {
          allowed: false,
          code: 'broker_ref_not_declared',
          reason: `${ref} is bound through the proxy, so its value is not handed out`,
          fix: `Send requests to the proxy URL the binding provides. To have the value itself set instead, bind it again without --via-proxy`,
        };
      }

      const err = errors();
      const parseNote = err ? ` (${err} — fix it to restore its refs)` : '';
      return {
        allowed: false,
        code: 'broker_ref_not_declared',
        reason: `${ref} is not declared for materialization${parseNote}`,
        fix: `Declare it for a coding-agent project (aquaman coder project add <name> --path <dir> --env VAR=${ref}) or allow it explicitly (aquaman broker allow ${ref})`,
      };
    },

    declared() {
      const out: { ref: string; source: 'projects.yaml' | 'config.yaml' }[] = [];
      for (const ref of [...projectRefs().refs].sort()) out.push({ ref, source: 'projects.yaml' });
      for (const ref of [...configRefs().refs].sort()) out.push({ ref, source: 'config.yaml' });
      return out;
    },

    declarationError() {
      return errors();
    },

    routedRefs() {
      return projectRefs().routedRefs ?? new Set<string>();
    },
  };
}
