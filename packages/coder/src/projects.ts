/**
 * Project resolver — maps a working directory to an aquaman project
 * config in `~/.aquaman/projects.yaml`.
 *
 * Each project declares:
 *   - one or more paths it owns (longest-prefix wins)
 *   - an env map: ENV_VAR_NAME → aquaman://service/key reference
 *
 * The resolver materializes references to real credentials by calling
 * the broker over UDS — see `./broker-client.ts`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';

export interface ProjectConfig {
  /** Filesystem paths this project owns. Longest-prefix wins. */
  paths: string[];
  /** Environment-variable name → aquaman:// reference (e.g. aquaman://anthropic/api_key). */
  env: Record<string, string>;
}

export interface ProjectsFile {
  version?: number;
  projects: Record<string, ProjectConfig>;
}

// Service must be lowercase (matches the daemon's SAFE_SERVICE_NAME).
// Key allows uppercase to match the daemon's broader SAFE_KEY_NAME so
// vault entries like `aws/SECRET_ACCESS_KEY` can be referenced.
const AQUAMAN_REF = /^aquaman:\/\/([a-z0-9][a-z0-9._-]*)\/([a-zA-Z0-9][a-zA-Z0-9._-]*)$/;
const POSIX_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function defaultProjectsPath(): string {
  return path.join(os.homedir(), '.aquaman', 'projects.yaml');
}

/**
 * Expand `~` and resolve to an absolute path.
 */
function expandPath(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

/**
 * Load and validate a projects.yaml file. Returns an empty config if
 * the file does not exist. Throws on malformed YAML or invalid refs.
 */
export function loadProjects(projectsPath: string = defaultProjectsPath()): ProjectsFile {
  if (!fs.existsSync(projectsPath)) {
    return { version: 1, projects: {} };
  }

  const raw = fs.readFileSync(projectsPath, 'utf-8');
  const parsed = yamlParse(raw) as ProjectsFile | null;
  if (!parsed || typeof parsed !== 'object' || !parsed.projects) {
    return { version: 1, projects: {} };
  }

  // Validate each project — surface bad refs as parse errors.
  for (const [name, cfg] of Object.entries(parsed.projects)) {
    if (!Array.isArray(cfg.paths) || cfg.paths.length === 0) {
      throw new Error(`Project "${name}" has no paths`);
    }
    if (!cfg.env || typeof cfg.env !== 'object') {
      cfg.env = {};
      continue;
    }
    for (const [envKey, ref] of Object.entries(cfg.env)) {
      if (!POSIX_ENV_NAME.test(envKey)) {
        throw new Error(
          `Project "${name}" has invalid env name "${envKey}". ` +
          `POSIX env names must match /^[A-Za-z_][A-Za-z0-9_]*$/`
        );
      }
      if (typeof ref !== 'string' || !AQUAMAN_REF.test(ref)) {
        throw new Error(
          `Project "${name}" env ${envKey} has invalid reference: "${ref}". ` +
          `Expected aquaman://<service>/<key>`
        );
      }
    }
  }

  return parsed;
}

/**
 * Write projects.yaml atomically. Creates parent directory if needed.
 */
export function saveProjects(
  file: ProjectsFile,
  projectsPath: string = defaultProjectsPath()
): void {
  const dir = path.dirname(projectsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const yaml = yamlStringify({ version: file.version ?? 1, projects: file.projects });
  const tmp = projectsPath + '.tmp';
  fs.writeFileSync(tmp, yaml, { mode: 0o600 });
  fs.renameSync(tmp, projectsPath);
}

/**
 * Try to resolve symlinks; fall back to literal path if the target
 * does not exist. macOS's /var → /private/var symlink trips up naive
 * string matching, hence this helper.
 */
function realpathOrLiteral(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Given a working directory, return the matching project config (or
 * null if none matches). Longest-prefix wins so nested projects work.
 */
export function findProjectForCwd(
  cwd: string,
  file: ProjectsFile
): { name: string; config: ProjectConfig } | null {
  const absCwd = realpathOrLiteral(path.resolve(cwd));
  let best: { name: string; config: ProjectConfig; prefixLen: number } | null = null;

  for (const [name, cfg] of Object.entries(file.projects)) {
    for (const declaredPath of cfg.paths) {
      const abs = realpathOrLiteral(expandPath(declaredPath));
      if (absCwd === abs || absCwd.startsWith(abs + path.sep)) {
        if (!best || abs.length > best.prefixLen) {
          best = { name, config: cfg, prefixLen: abs.length };
        }
      }
    }
  }

  if (!best) return null;
  return { name: best.name, config: best.config };
}

/**
 * Parse an aquaman:// reference into (service, key).
 */
export function parseRef(ref: string): { service: string; key: string } | null {
  const m = AQUAMAN_REF.exec(ref);
  if (!m) return null;
  return { service: m[1], key: m[2] };
}
