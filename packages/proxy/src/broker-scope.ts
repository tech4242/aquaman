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

/** `aquaman://service/key` — same grammar as the daemon's service/key validation. */
const AQUAMAN_REF = /^aquaman:\/\/([a-z0-9][a-z0-9._-]*)\/([a-zA-Z0-9][a-zA-Z0-9._-]*)$/;

export function parseAquamanRef(ref: string): { service: string; key: string } | null {
  const m = AQUAMAN_REF.exec(ref);
  return m ? { service: m[1], key: m[2] } : null;
}

export function formatAquamanRef(service: string, key: string): string {
  return `aquaman://${service}/${key}`;
}

/** Default location of the coding-agent project map (honors AQUAMAN_CONFIG_DIR). */
export function defaultProjectsPath(): string {
  return path.join(getConfigDir(), 'projects.yaml');
}

export interface DeclaredRefsResult {
  /** Set of `aquaman://service/key` strings. */
  refs: Set<string>;
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
  const projects = parsed && typeof parsed === 'object' ? parsed.projects : undefined;
  if (!projects || typeof projects !== 'object') return { refs };

  for (const cfg of Object.values(projects) as any[]) {
    const env = cfg && typeof cfg === 'object' ? cfg.env : undefined;
    if (!env || typeof env !== 'object') continue;
    for (const ref of Object.values(env)) {
      if (typeof ref === 'string' && parseAquamanRef(ref)) refs.add(ref);
    }
  }
  return { refs };
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
    for (const ref of list) if (typeof ref === 'string' && parseAquamanRef(ref)) refs.add(ref);
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
  | { allowed: false; code: 'broker_ref_not_declared' | 'broker_ref_isolated'; reason: string; fix: string };

export interface BrokerScopeOptions {
  /** projects.yaml to read declared refs from. Default: `<configDir>/projects.yaml`. */
  projectsPath?: string;
  /** config.yaml whose `broker.allowedRefs` are declared refs (re-read on change). */
  configPath?: string;
  /** Additional static declared refs. Invalid entries are ignored. */
  allowedRefs?: readonly string[];
  /** Services never materialized over the loopback listener (the Hermes LLM-provider tier). */
  loopbackDeniedServices?: readonly string[];
}

export interface BrokerScope {
  check(service: string, key: string, caller: BrokerCaller): BrokerDecision;
  /** Every currently declared ref, with where it came from. For `aquaman broker list` and startup logs. */
  declared(): { ref: string; source: 'projects.yaml' | 'config.yaml' }[];
  /** Parse problems with the declaring files, if any (the broker fails closed for their refs). */
  declarationError(): string | undefined;
}

export function createBrokerScope(opts: BrokerScopeOptions = {}): BrokerScope {
  const projectRefs = mtimeCached(opts.projectsPath ?? defaultProjectsPath(), loadProjectRefs);
  const configFileRefs = opts.configPath ? mtimeCached(opts.configPath, loadConfigAllowedRefs) : () => ({ refs: new Set<string>() }) as DeclaredRefsResult;
  const staticRefs = new Set((opts.allowedRefs ?? []).filter(r => typeof r === 'string' && parseAquamanRef(r)));
  const loopbackDenied = new Set(opts.loopbackDeniedServices ?? []);

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

      if (caller === 'loopback' && loopbackDenied.has(service)) {
        return {
          allowed: false,
          code: 'broker_ref_isolated',
          reason: `${ref} is not materialized over the loopback listener: ${service} keys stay process-isolated on the proxy path`,
          fix: `Keep ${service} on the proxy path (base URL + placeholder key in ~/.hermes/.env) and remove the binding from your Hermes secrets config`,
        };
      }

      if (projectRefs().refs.has(ref) || configRefs().refs.has(ref)) return { allowed: true };

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
  };
}
