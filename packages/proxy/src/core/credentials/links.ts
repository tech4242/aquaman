/**
 * Links: an aquaman reference read from an item that already exists in the
 * user's vault, instead of from an item aquaman wrote.
 *
 * `credentials.links` in config.yaml maps `<service>/<key>` to a locator, one
 * scheme per backend:
 *
 *   1password   op://<vault>/<item>/[<section>/]<field>
 *   bitwarden   bw://<item id or exact item name>/<field>
 *   vault       vault://<mount>/<path>#<field>            (KV v2)
 *   keychain    keychain://<service>/<account>
 *   keepassxc   keepassxc://<Group/.../Entry title>[#<field>]
 *   keeper      keeper://<record UID>[/<field>]
 *
 * A locator is text an agent may have chosen, and parts of it reach vendor
 * command lines and a dialog a person decides on. So the grammar is strict:
 * bounded length, no control or format characters, no backslash, no part that
 * starts with `-` (it would read as an option), no `.` or `..` part, and
 * percent-escapes decoded exactly once, with a decoded part that still holds
 * an escape refused. What the parser accepts is shown in the dialog
 * character for character.
 *
 * aquaman only reads a linked item. It never writes or deletes one.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { CredentialBackend } from '../types.js';
import { isReservedService } from './reserved.js';

export type LinkScheme = 'op' | 'bw' | 'vault' | 'keychain' | 'keepassxc' | 'keeper';

export const LOCATOR_MAX_LENGTH = 200;

/** The one scheme each backend reads. Backends not listed hold only what aquaman wrote. */
export const LINK_SCHEME_BY_BACKEND: Partial<Record<CredentialBackend, LinkScheme>> = {
  '1password': 'op',
  bitwarden: 'bw',
  vault: 'vault',
  keychain: 'keychain',
  keepassxc: 'keepassxc',
  keeper: 'keeper',
};

const BACKEND_BY_SCHEME: Record<LinkScheme, CredentialBackend> = {
  op: '1password',
  bw: 'bitwarden',
  vault: 'vault',
  keychain: 'keychain',
  keepassxc: 'keepassxc',
  keeper: 'keeper',
};

const LOCATOR_FORM: Record<LinkScheme, string> = {
  op: 'op://<vault>/<item>/[<section>/]<field>',
  bw: 'bw://<item id or exact item name>/<field>',
  vault: 'vault://<mount>/<path>#<field>',
  keychain: 'keychain://<service>/<account>',
  keepassxc: 'keepassxc://<Group/.../Entry title>[#<field>]',
  keeper: 'keeper://<record UID>[/<field>]',
};

export interface ParsedLocator {
  scheme: LinkScheme;
  /** The backend that reads this scheme. */
  backend: CredentialBackend;
  /** The locator exactly as given. */
  text: string;
  /**
   * Decoded path parts: `[vault, item, section?]` (op), `[item]` (bw),
   * `[...mount parts]` then the secret path (vault, see `mountParts`),
   * `[service]` (keychain), `[...groups, title]` (keepassxc), `[uid]` (keeper).
   */
  path: string[];
  /** The field to read. For `keychain` this is the account. */
  field: string;
  /** vault only: how many leading `path` entries name the mount. */
  mountParts?: number;
}

export type LocatorResult =
  | { ok: true; locator: ParsedLocator }
  | { ok: false; code: 'link_invalid_locator' | 'link_backend_mismatch' | 'link_unsupported_backend'; error: string; fix: string };

/** `<service>/<key>` with the same grammar as an `aquaman://` reference. */
const LINK_NAME = /^([a-z0-9][a-z0-9._-]*)\/([a-zA-Z0-9][a-zA-Z0-9._-]*)$/;

/** Accepts `service/key` or `aquaman://service/key`. */
export function parseLinkName(text: string): { service: string; key: string; name: string } | null {
  const bare = text.startsWith('aquaman://') ? text.slice('aquaman://'.length) : text;
  const m = LINK_NAME.exec(bare);
  // aquaman's own records are never read from, or redirected to, another item.
  if (!m || isReservedService(m[1])) return null;
  return { service: m[1], key: m[2], name: `${m[1]}/${m[2]}` };
}

// 1Password secret references take these characters only; an item whose name
// has others is addressed by its ID.
const OP_PART = /^[A-Za-z0-9 ._-]+$/;
// Keeper UIDs are URL-safe base64. Nothing else may sit where Commander
// expects a UID, and one that starts with "-" would be read as an option, so
// such a record cannot be linked.
const KEEPER_UID = /^[A-Za-z0-9_][A-Za-z0-9_-]{15,31}$/;
const KEEPER_FIELD = /^[A-Za-z0-9_.](?:[A-Za-z0-9 _.]{0,62}[A-Za-z0-9_.])?$/;
const ESCAPE = /%[0-9A-Fa-f]{2}/;

function invalid(scheme: LinkScheme | undefined, why: string): LocatorResult {
  return {
    ok: false,
    code: 'link_invalid_locator',
    error: `Not a usable vault locator: ${why}`,
    fix: scheme
      ? `Write it as ${LOCATOR_FORM[scheme]}`
      : `Use one of: ${Object.values(LOCATOR_FORM).join(', ')}`,
  };
}

/**
 * Decode one part exactly once and apply the rules every part obeys. Returns
 * the reason as a string when the part is refused.
 */
function decodePart(raw: string, allowSlash: boolean): { value: string } | string {
  if (raw.length === 0) return 'it has an empty part';
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return 'it has a malformed percent-escape';
  }
  // A part that still holds an escape after one decoding would mean something
  // different to anything that decodes again.
  if (ESCAPE.test(value)) return 'it is percent-encoded twice';
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\]/u.test(value)) return 'it has a control character or a backslash';
  if (value !== value.trim()) return 'a part starts or ends with a space';
  for (const segment of value.split('/')) {
    if (segment === '.' || segment === '..') return 'it has a "." or ".." part';
    if (segment.startsWith('-')) return 'a part starts with "-"';
  }
  if (!allowSlash && value.includes('/')) return 'an encoded "/" is not accepted in this part';
  return { value };
}

function decodeParts(raws: string[], allowSlash: boolean): string[] | string {
  const out: string[] = [];
  for (const raw of raws) {
    const part = decodePart(raw, allowSlash);
    if (typeof part === 'string') return part;
    out.push(part.value);
  }
  return out;
}

/** Parse a locator by its scheme. Says nothing about which backend is configured. */
export function parseLocator(text: unknown): LocatorResult {
  if (typeof text !== 'string' || text.length === 0) return invalid(undefined, 'it is empty');
  if (text.length > LOCATOR_MAX_LENGTH) return invalid(undefined, `it is longer than ${LOCATOR_MAX_LENGTH} characters`);
  // Checked on the raw text as well as on each decoded part: the raw text is
  // what a person is shown.
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\]/u.test(text)) return invalid(undefined, 'it has a control character or a backslash');
  if (text !== text.trim() || /\s{2,}/u.test(text) || /[^\S ]/u.test(text)) {
    return invalid(undefined, 'it has leading, trailing, repeated or unusual spaces');
  }
  const m = /^([a-z]+):\/\/(.*)$/su.exec(text);
  if (!m || !Object.hasOwn(BACKEND_BY_SCHEME, m[1])) return invalid(undefined, 'it does not start with a known scheme');
  const scheme = m[1] as LinkScheme;
  const backend = BACKEND_BY_SCHEME[scheme];
  const rest = m[2];
  const done = (pathParts: string[], field: string, extra: Partial<ParsedLocator> = {}): LocatorResult =>
    ({ ok: true, locator: { scheme, backend, text, path: pathParts, field, ...extra } });

  // Only vault and keepassxc give `#` a meaning; `?` has none anywhere.
  const hashAt = rest.indexOf('#');
  const usesHash = scheme === 'vault' || scheme === 'keepassxc';
  if (rest.includes('?')) return invalid(scheme, 'it has a "?"');
  if (hashAt !== -1 && !usesHash) return invalid(scheme, 'it has a "#"');
  const body = hashAt === -1 ? rest : rest.slice(0, hashAt);
  const fragment = hashAt === -1 ? undefined : rest.slice(hashAt + 1);
  if (fragment !== undefined && fragment.includes('#')) return invalid(scheme, 'it has more than one "#"');
  const raws = body.split('/');

  switch (scheme) {
    case 'op': {
      if (raws.length !== 3 && raws.length !== 4) return invalid(scheme, 'it needs a vault, an item and a field');
      const parts = decodeParts(raws, false);
      if (typeof parts === 'string') return invalid(scheme, parts);
      // `op` parses the reference itself, so only what its syntax defines gets through.
      if (text.includes('%') || parts.some((p) => !OP_PART.test(p))) {
        return invalid(scheme, 'vault, item, section and field may hold letters, digits, spaces, ".", "_" and "-" only (use the item ID for other names)');
      }
      return done(parts.slice(0, -1), parts[parts.length - 1]);
    }
    case 'bw': {
      if (raws.length !== 2) return invalid(scheme, 'it needs an item and a field');
      const parts = decodeParts(raws, true);
      if (typeof parts === 'string') return invalid(scheme, parts);
      return done([parts[0]], parts[1]);
    }
    case 'vault': {
      if (fragment === undefined) return invalid(scheme, 'it needs "#<field>"');
      if (raws.length < 2) return invalid(scheme, 'it needs a mount and a path');
      // The mount is one part; a mount whose name has a "/" is written with %2F.
      const mount = decodePart(raws[0], true);
      if (typeof mount === 'string') return invalid(scheme, mount);
      const mountPieces = mount.value.split('/');
      if (mountPieces.some((p) => p.length === 0)) return invalid(scheme, 'it has an empty part');
      const segments = decodeParts(raws.slice(1), false);
      if (typeof segments === 'string') return invalid(scheme, segments);
      const field = decodePart(fragment, false);
      if (typeof field === 'string') return invalid(scheme, field);
      return done([...mountPieces, ...segments], field.value, { mountParts: mountPieces.length });
    }
    case 'keychain': {
      if (raws.length !== 2) return invalid(scheme, 'it needs a service and an account');
      const parts = decodeParts(raws, true);
      if (typeof parts === 'string') return invalid(scheme, parts);
      // Items under this prefix are the ones aquaman wrote. They are reached by
      // their own reference, never under a second name.
      if (parts[0] === 'aquaman' || parts[0].startsWith('aquaman/')) {
        return invalid(scheme, 'it names an item aquaman itself wrote; use that credential by its own reference');
      }
      return done([parts[0]], parts[1]);
    }
    case 'keepassxc': {
      const parts = decodeParts(raws, true);
      if (typeof parts === 'string') return invalid(scheme, parts);
      let field = 'Password';
      if (fragment !== undefined) {
        const f = decodePart(fragment, false);
        if (typeof f === 'string') return invalid(scheme, f);
        field = f.value;
      }
      return done(parts, field);
    }
    case 'keeper': {
      if (raws.length !== 1 && raws.length !== 2) return invalid(scheme, 'it needs a record UID and at most one field');
      if (text.includes('%')) return invalid(scheme, 'percent-escapes are not accepted here');
      if (!KEEPER_UID.test(raws[0])) return invalid(scheme, 'the record UID is 16 to 32 letters, digits, "_" or "-", and does not start with "-"');
      const field = raws.length === 2 ? raws[1] : 'password';
      if (!KEEPER_FIELD.test(field)) return invalid(scheme, 'the field name may hold letters, digits, spaces, "." and "_" only');
      return done([raws[0]], field);
    }
  }
}

/**
 * Parse a locator for the backend that is configured. A link is only valid
 * for that backend: another backend's scheme is refused by name, and the two
 * backends that hold only what aquaman wrote take no links at all.
 */
export function parseLocatorFor(backend: CredentialBackend, text: unknown): LocatorResult {
  const scheme = LINK_SCHEME_BY_BACKEND[backend];
  if (!scheme) {
    return {
      ok: false,
      code: 'link_unsupported_backend',
      error: `The ${backend} backend holds only what aquaman wrote, so there is no existing item to link to`,
      fix: 'Store the value instead (aquaman credentials add <service> <key>), or switch to a vault backend with: aquaman setup',
    };
  }
  const parsed = parseLocator(text);
  if (!parsed.ok) return { ...parsed, fix: `For the ${backend} backend write it as ${LOCATOR_FORM[scheme]}` };
  if (parsed.locator.scheme !== scheme) {
    return {
      ok: false,
      code: 'link_backend_mismatch',
      error: `A ${parsed.locator.scheme}:// locator belongs to the ${parsed.locator.backend} backend, and the configured backend is ${backend}`,
      fix: `For the ${backend} backend write it as ${LOCATOR_FORM[scheme]}`,
    };
  }
  return parsed;
}

export interface LinkMapResult {
  /** `<service>/<key>` to locator text. Entries that are not a name and a string are left out. */
  links: Map<string, string>;
  /** Why the file could not be read as a config. The map is then empty. */
  error?: string;
}

/**
 * Read `credentials.links` straight from a config.yaml file, with no
 * defaults and no environment overrides. A missing file or key links nothing.
 */
export function loadCredentialLinks(configPath: string): LinkMapResult {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { links: new Map() };
    return { links: new Map(), error: `cannot read ${configPath}: ${err?.message ?? err}` };
  }
  let parsed: any;
  try {
    parsed = parseYaml(raw);
  } catch (err: any) {
    return { links: new Map(), error: `cannot parse ${configPath}: ${err?.message ?? err}` };
  }
  const links = new Map<string, string>();
  const map = parsed?.credentials?.links;
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    for (const [name, locator] of Object.entries(map)) {
      if (typeof locator === 'string' && parseLinkName(name)?.name === name) links.set(name, locator);
    }
  }
  return { links };
}

/**
 * The link map of one config file, read again only when the file changes, so
 * a link made by `aquaman credentials link` or approved in a dialog reaches a
 * running daemon. A file that cannot be parsed links nothing.
 */
export function createLinkSource(configPath: string): () => ReadonlyMap<string, string> {
  let stamp: string | undefined;
  let cached: Map<string, string> = new Map();
  return () => {
    let now: string;
    try {
      const st = fs.statSync(configPath);
      now = `${st.size}:${st.mtimeMs}:${st.ino}`;
    } catch {
      now = '';
    }
    if (now !== stamp) {
      cached = now === '' ? new Map() : loadCredentialLinks(configPath).links;
      stamp = now;
    }
    return cached;
  };
}

/**
 * Set (`locator` given) or remove (`null`) one link in config.yaml. Edits the
 * file as it is on disk, so a value that exists only in the environment is
 * never written, and replaces it by rename at 0600 so a reader sees the old
 * file or the new one. Returns whether the file changed.
 */
export function writeCredentialLink(configPath: string, name: string, locator: string | null): boolean {
  if (parseLinkName(name)?.name !== name) throw new Error(`Invalid link name: ${name}`);
  let raw: Record<string, any> = {};
  if (fs.existsSync(configPath)) {
    const parsed = parseYaml(fs.readFileSync(configPath, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
  }
  const credentials: Record<string, any> = raw.credentials && typeof raw.credentials === 'object' && !Array.isArray(raw.credentials) ? { ...raw.credentials } : {};
  const links: Record<string, any> = credentials.links && typeof credentials.links === 'object' && !Array.isArray(credentials.links) ? { ...credentials.links } : {};
  if (locator === null) {
    if (!Object.hasOwn(links, name)) return false;
    delete links[name];
  } else {
    if (links[name] === locator) return false;
    links[name] = locator;
  }
  if (Object.keys(links).length === 0) delete credentials.links;
  else credentials.links = Object.fromEntries(Object.entries(links).sort(([a], [b]) => a.localeCompare(b)));
  raw.credentials = credentials;

  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const tmp = `${configPath}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, stringifyYaml(raw), { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, configPath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return true;
}

export interface LinkProblem {
  name: string;
  locator: string;
  error: string;
  fix: string;
}

/** Links in a config file that the configured backend cannot read, for `aquaman doctor`. */
export function findLinkProblems(backend: CredentialBackend, configPath: string): { count: number; problems: LinkProblem[] } {
  const { links } = loadCredentialLinks(configPath);
  const problems: LinkProblem[] = [];
  for (const [name, locator] of links) {
    const parsed = parseLocatorFor(backend, locator);
    if (!parsed.ok) {
      problems.push({ name, locator, error: parsed.error, fix: `Remove it with: aquaman credentials unlink ${name}` });
    }
  }
  return { count: links.size, problems };
}
