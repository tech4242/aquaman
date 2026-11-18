/**
 * The locator grammar of links, and the `credentials.links` map in
 * config.yaml.
 *
 * A locator is text an agent may have chosen. Parts of it reach vendor
 * command lines and a dialog, so the parser is attacked here one row at a
 * time: option injection, traversal, control characters, a scheme that does
 * not belong to the backend, length, double encoding.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  parseLocator,
  parseLocatorFor,
  parseLinkName,
  loadCredentialLinks,
  createLinkSource,
  writeCredentialLink,
  findLinkProblems,
  LOCATOR_MAX_LENGTH,
  LINK_SCHEME_BY_BACKEND,
} from '../../packages/proxy/src/core/credentials/links.js';
import { displayText } from '../../packages/proxy/src/credential-prompt.js';

const UID = 'kR3cOrdU1d_aaaa-bbbb22';
const BW_ID = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f';

describe('parseLocator: accepted forms', () => {
  it.each([
    ['op://Private/GitHub/token', '1password', ['Private', 'GitHub'], 'token'],
    ['op://Private/GitHub Token/API/credential', '1password', ['Private', 'GitHub Token', 'API'], 'credential'],
    ['op://vault.id_1/item-2/field', '1password', ['vault.id_1', 'item-2'], 'field'],
    [`bw://${BW_ID}/password`, 'bitwarden', [BW_ID], 'password'],
    ['bw://GitHub (work)/API key', 'bitwarden', ['GitHub (work)'], 'API key'],
    ['bw://team%2Fgithub/notes', 'bitwarden', ['team/github'], 'notes'],
    ['vault://secret/apps/github#token', 'vault', ['secret', 'apps', 'github'], 'token'],
    ['vault://team%2Fkv/db#password', 'vault', ['team', 'kv', 'db'], 'password'],
    ['keychain://github.com/alice@example.com', 'keychain', ['github.com'], 'alice@example.com'],
    ['keychain://com.example%2Fapi/alice', 'keychain', ['com.example/api'], 'alice'],
    ['keepassxc://Work/APIs/GitHub', 'keepassxc', ['Work', 'APIs', 'GitHub'], 'Password'],
    ['keepassxc://GitHub#UserName', 'keepassxc', ['GitHub'], 'UserName'],
    ['keepassxc://Work/CI%2FCD token#API Key', 'keepassxc', ['Work', 'CI/CD token'], 'API Key'],
    [`keeper://${UID}`, 'keeper', [UID], 'password'],
    [`keeper://${UID}/API Key`, 'keeper', [UID], 'API Key'],
  ])('%s', (text, backend, parts, field) => {
    const r = parseLocator(text);
    expect(r).toMatchObject({ ok: true, locator: { backend, text, path: parts, field } });
    // What is accepted is shown in the dialog exactly as written.
    expect(displayText(text, 220)).toBe(text);
  });

  it('records how many leading parts name a Vault mount', () => {
    const one = parseLocator('vault://secret/apps/github#token');
    const two = parseLocator('vault://team%2Fkv/db#password');
    expect(one.ok && one.locator.mountParts).toBe(1);
    expect(two.ok && two.locator.mountParts).toBe(2);
  });

  it('accepts a locator of exactly the maximum length and refuses one character more', () => {
    const fits = `bw://${'a'.repeat(LOCATOR_MAX_LENGTH - 'bw:///password'.length)}/password`;
    expect(fits).toHaveLength(LOCATOR_MAX_LENGTH);
    expect(parseLocator(fits).ok).toBe(true);
    expect(parseLocator(`${fits}x`)).toMatchObject({ ok: false, code: 'link_invalid_locator', error: expect.stringContaining('longer than 200') });
  });
});

describe('parseLocator: attacks', () => {
  const attacks: Array<[string, unknown, RegExp]> = [
    // Not a locator at all.
    ['not a string', 42, /empty/],
    ['empty', '', /empty/],
    ['no scheme', 'Private/GitHub/token', /known scheme/],
    ['an unknown scheme', 'file:///etc/passwd', /known scheme/],
    ['an upper-case scheme', 'OP://Private/GitHub/token', /known scheme/],
    ['a scheme from the prototype chain', 'constructor://a/b', /known scheme/],
    // Option injection: a part that a command line would read as a flag.
    ['op vault that is an option', 'op://--account=evil/GitHub/token', /starts with "-"/],
    ['op item that is an option', 'op://Private/-rf/token', /starts with "-"/],
    ['op field that is an option', 'op://Private/GitHub/--reveal', /starts with "-"/],
    ['bw item that is an option', 'bw://--session/password', /starts with "-"/],
    ['bw item that decodes to an option', 'bw://%2D%2Dsession/password', /needs no encoding/],
    ['bw field that is an option', 'bw://GitHub/-x', /starts with "-"/],
    ['an option hidden behind an encoded slash', 'bw://a%2F--raw/password', /starts with "-"/],
    ['vault path that is an option', 'vault://secret/-version=1#token', /starts with "-"/],
    ['keychain account that is an option', 'keychain://github.com/-a', /starts with "-"/],
    ['keepassxc entry that is an option', 'keepassxc://Work/--no-password', /starts with "-"/],
    ['keeper UID that is an option', 'keeper://--format=json-secrets', /record UID/],
    ['keeper UID that starts with a dash', `keeper://-${UID.slice(1)}`, /record UID/],
    // Traversal.
    ['op dot-dot part', 'op://Private/../token', /"\." or "\.\."/],
    ['vault dot-dot part', 'vault://secret/../sys/seal#token', /"\." or "\.\."/],
    ['vault encoded dot-dot part', 'vault://secret/%2E%2E/sys#token', /needs no encoding/],
    ['vault dot part', 'vault://secret/./github#token', /"\." or "\.\."/],
    ['vault mount with a dot-dot piece', 'vault://secret%2F..%2Fsys/x#token', /"\." or "\.\."/],
    ['vault path with an encoded slash', 'vault://secret/apps%2Fgithub#token', /encoded "\/"/],
    ['vault field with an encoded slash', 'vault://secret/github#a%2Fb', /encoded "\/"/],
    ['keepassxc dot-dot group', 'keepassxc://../Root/Entry', /"\." or "\.\."/],
    ['keychain dot-dot service', 'keychain://../alice', /"\." or "\.\."/],
    ['bw dot-dot behind an encoded slash', 'bw://a%2F..%2Fb/password', /"\." or "\.\."/],
    // Control and format characters, raw and encoded.
    ['a newline', 'bw://GitHub\nAllow: yes/password', /control character/],
    ['a NUL', 'bw://Git\u0000Hub/password', /control character/],
    ['an encoded newline', 'bw://GitHub%0AAllow/password', /needs no encoding/],
    ['an encoded NUL', 'keychain://github.com/alice%00', /needs no encoding/],
    ['a right-to-left override', 'bw://Git‮Hub/password', /control character/],
    ['a zero-width joiner', 'bw://Git‍Hub/password', /control character/],
    ['a line separator', 'bw://Git Hub/password', /control character/],
    ['a backslash', 'bw://Git\\Hub/password', /backslash/],
    ['an encoded backslash', 'bw://Git%5CHub/password', /needs no encoding/],
    ['a tab', 'bw://Git\tHub/password', /control character/],
    ['a no-break space', 'bw://Git Hub/password', /spaces/],
    ['a run of spaces', 'bw://Git  Hub/password', /spaces/],
    ['a leading space', ' bw://GitHub/password', /spaces/],
    ['a trailing space', 'bw://GitHub/password ', /spaces/],
    ['a part that starts with a space', 'bw:// GitHub/password', /starts or ends with a space/],
    ['a part that ends with an encoded space', 'bw://GitHub%20/password', /needs no encoding/],
    // Double encoding and malformed escapes.
    ['a doubly encoded slash', 'bw://a%252Fb/password', /percent-encoded twice/],
    // What a person approves is what is read: a name cannot be spelled in escapes.
    ['a path spelled in escapes (reads as prod/db)', 'vault://secret/%70%72%6f%64/%64%62#password', /needs no encoding/],
    ['one letter spelled as an escape', 'bw://Git%48ub/password', /needs no encoding/],
    ['an encoded space', 'keychain://my%20service/alice', /needs no encoding/],
    ['a doubly encoded dot-dot', 'vault://secret/%252E%252E/x#token', /percent-encoded twice/],
    ['a malformed escape', 'bw://Git%ZZHub/password', /malformed percent-escape/],
    ['a truncated escape', 'bw://GitHub%/password', /malformed percent-escape/],
    ['an escape that is not UTF-8', 'bw://Git%FFHub/password', /needs no encoding/],
    ['any escape in an op reference', 'op://Private/Git%48ub/token', /needs no encoding/],
    ['any escape in a keeper locator', `keeper://${UID}/pass%77ord`, /percent-escapes/],
    // Structure.
    ['op with too few parts', 'op://Private/GitHub', /a vault, an item and a field/],
    ['op with too many parts', 'op://a/b/c/d/e', /a vault, an item and a field/],
    ['op with a query (an attribute selector)', 'op://Private/GitHub/token?attribute=otp', /"\?"/],
    ['op with a character outside its syntax', 'op://Private/Git$Hub/token', /letters, digits/],
    ['op with a fragment', 'op://Private/GitHub/token#x', /"#"/],
    ['an empty part', 'op://Private//token', /empty part/],
    ['bw with no field', 'bw://GitHub', /an item and a field/],
    ['bw with three parts', 'bw://a/b/c', /an item and a field/],
    ['bw with an empty field', 'bw://GitHub/', /empty part/],
    ['vault with no field', 'vault://secret/github', /needs "#<field>"/],
    ['vault with no path', 'vault://secret#token', /a mount and a path/],
    ['vault with an empty field', 'vault://secret/github#', /empty part/],
    ['vault with two fragments', 'vault://secret/github#a#b', /more than one "#"/],
    ['vault with an empty mount piece', 'vault://team%2F/x#token', /empty part/],
    ['keychain with one part', 'keychain://github.com', /a service and an account/],
    ['keychain that names an item aquaman wrote', 'keychain://aquaman%2Fanthropic/api_key', /aquaman itself wrote/],
    ['keychain that names the aquaman prefix itself', 'keychain://aquaman/_index', /aquaman itself wrote/],
    ['keepassxc with an empty title', 'keepassxc://Work/', /empty part/],
    ['keepassxc with an empty field', 'keepassxc://Work/GitHub#', /empty part/],
    ['keeper UID that is too short', 'keeper://abc', /record UID/],
    ['keeper UID with a space and a second command', `keeper://${UID} rm`, /record UID/],
    ['keeper with three parts', `keeper://${UID}/a/b`, /at most one field/],
    ['keeper field with a quote', `keeper://${UID}/pass'word`, /field name/],
    ['keeper field that is an option', `keeper://${UID}/--format`, /field name/],
  ];

  it.each(attacks)('refuses %s', (_name, text, why) => {
    const r = parseLocator(text);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ code: 'link_invalid_locator', error: expect.stringMatching(why), fix: expect.stringMatching(/:\/\//) });
  });
});

describe('parseLocatorFor: one scheme per backend', () => {
  const sample: Record<string, string> = {
    '1password': 'op://Private/GitHub/token',
    bitwarden: 'bw://GitHub/password',
    vault: 'vault://secret/github#token',
    keychain: 'keychain://github.com/alice',
    keepassxc: 'keepassxc://Work/GitHub',
    keeper: `keeper://${UID}`,
  };

  it('accepts each backend\'s own scheme', () => {
    for (const [backend, text] of Object.entries(sample)) {
      expect(parseLocatorFor(backend as any, text), backend).toMatchObject({ ok: true, locator: { backend } });
    }
    expect(Object.keys(LINK_SCHEME_BY_BACKEND).sort()).toEqual(Object.keys(sample).sort());
  });

  it('refuses every other backend\'s scheme and names both', () => {
    for (const backend of Object.keys(sample)) {
      for (const [other, text] of Object.entries(sample)) {
        if (other === backend) continue;
        const r = parseLocatorFor(backend as any, text);
        expect(r, `${text} for ${backend}`).toMatchObject({ ok: false, code: 'link_backend_mismatch' });
        if (!r.ok) {
          expect(r.error).toContain(`belongs to the ${other} backend`);
          expect(r.error).toContain(`configured backend is ${backend}`);
          expect(r.fix).toContain(`${LINK_SCHEME_BY_BACKEND[backend as keyof typeof LINK_SCHEME_BY_BACKEND]}://`);
        }
      }
    }
  });

  it.each(['encrypted-file', 'systemd-creds'] as const)('%s takes no links and says why', (backend) => {
    for (const text of [...Object.values(sample), 'nonsense']) {
      const r = parseLocatorFor(backend, text);
      expect(r).toMatchObject({ ok: false, code: 'link_unsupported_backend' });
      if (!r.ok) {
        expect(r.error).toContain(`The ${backend} backend holds only what aquaman wrote`);
        expect(r.fix).toContain('aquaman credentials add');
      }
    }
  });

  it('an invalid locator is answered with the form the configured backend takes', () => {
    const r = parseLocatorFor('1password', 'op://Private/../token');
    expect(r).toMatchObject({ ok: false, code: 'link_invalid_locator', fix: 'For the 1password backend write it as op://<vault>/<item>/[<section>/]<field>' });
  });
});

describe('parseLinkName', () => {
  it('accepts service/key and aquaman://service/key', () => {
    expect(parseLinkName('github/token')).toEqual({ service: 'github', key: 'token', name: 'github/token' });
    expect(parseLinkName('aquaman://github/api_Key.v2')).toEqual({ service: 'github', key: 'api_Key.v2', name: 'github/api_Key.v2' });
  });

  it.each(['github', 'GitHub/token', 'github/', '/token', 'github/a/b', '../x/y', 'aquaman://aquaman://a/b', 'a b/c', '-a/b'])('refuses %s', (text) => {
    expect(parseLinkName(text)).toBeNull();
  });
});

describe('credentials.links in config.yaml', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-links-'));
    file = path.join(dir, 'config.yaml');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('a missing file, a missing key and a list link nothing', () => {
    expect(loadCredentialLinks(file)).toEqual({ links: new Map() });
    fs.writeFileSync(file, 'credentials:\n  backend: vault\n');
    expect(loadCredentialLinks(file).links.size).toBe(0);
    fs.writeFileSync(file, 'credentials:\n  links:\n    - github/token\n');
    expect(loadCredentialLinks(file).links.size).toBe(0);
  });

  it('keeps entries that are a reference name and a string, and drops the rest', () => {
    fs.writeFileSync(file, [
      'credentials:',
      '  links:',
      '    github/token: op://Private/GitHub/token',
      '    Bad/Name: op://a/b/c',
      '    aquaman://github/other: op://a/b/c',
      '    openai/api_key: 42',
      '    stripe/secret_key:',
      '      nested: true',
      '',
    ].join('\n'));
    expect([...loadCredentialLinks(file).links]).toEqual([['github/token', 'op://Private/GitHub/token']]);
  });

  it('a file that cannot be read or parsed links nothing and says why', () => {
    fs.writeFileSync(file, 'credentials: [unterminated\n');
    const broken = loadCredentialLinks(file);
    expect(broken.links.size).toBe(0);
    expect(broken.error).toContain('cannot parse');

    const unreadable = loadCredentialLinks(dir);
    expect(unreadable.links.size).toBe(0);
    expect(unreadable.error).toContain('cannot read');
  });

  it('writes a link by rename at 0600, keeps everything else in the file, and leaves no temp file', () => {
    fs.writeFileSync(file, 'credentials:\n  backend: 1password\n  proxiedServices:\n    - github\nbroker:\n  allowedRefs:\n    - aquaman://x/y\ncustom: kept\n', { mode: 0o644 });
    expect(writeCredentialLink(file, 'github/token', 'op://Private/GitHub/token')).toBe(true);
    expect(writeCredentialLink(file, 'anthropic/api_key', 'op://Private/Anthropic/credential')).toBe(true);

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(['config.yaml']);
    expect(parseYaml(fs.readFileSync(file, 'utf-8'))).toEqual({
      credentials: {
        backend: '1password',
        proxiedServices: ['github'],
        links: { 'anthropic/api_key': 'op://Private/Anthropic/credential', 'github/token': 'op://Private/GitHub/token' },
      },
      broker: { allowedRefs: ['aquaman://x/y'] },
      custom: 'kept',
    });
  });

  it('writing the same link again, or removing one that is not there, changes nothing', () => {
    expect(writeCredentialLink(file, 'github/token', 'bw://GitHub/password')).toBe(true);
    const before = fs.statSync(file).ino;
    expect(writeCredentialLink(file, 'github/token', 'bw://GitHub/password')).toBe(false);
    expect(writeCredentialLink(file, 'openai/api_key', null)).toBe(false);
    expect(fs.statSync(file).ino).toBe(before);
  });

  it('removing the last link removes the key, and a missing file is created with its directory', () => {
    const nested = path.join(dir, 'new', 'config.yaml');
    expect(writeCredentialLink(nested, 'github/token', 'bw://GitHub/password')).toBe(true);
    expect(parseYaml(fs.readFileSync(nested, 'utf-8'))).toEqual({ credentials: { links: { 'github/token': 'bw://GitHub/password' } } });
    expect(writeCredentialLink(nested, 'github/token', null)).toBe(true);
    expect(parseYaml(fs.readFileSync(nested, 'utf-8'))).toEqual({ credentials: {} });
  });

  it('starts from an empty config when the file holds something that is not a map, or links is not a map', () => {
    fs.writeFileSync(file, '- a\n- b\n');
    writeCredentialLink(file, 'github/token', 'bw://GitHub/password');
    expect(parseYaml(fs.readFileSync(file, 'utf-8'))).toEqual({ credentials: { links: { 'github/token': 'bw://GitHub/password' } } });

    fs.writeFileSync(file, 'credentials:\n  links: nope\n');
    writeCredentialLink(file, 'github/token', 'bw://GitHub/password');
    expect(parseYaml(fs.readFileSync(file, 'utf-8')).credentials.links).toEqual({ 'github/token': 'bw://GitHub/password' });
  });

  it('refuses a name that is not a reference, and leaves no temp file when the write fails', () => {
    expect(() => writeCredentialLink(file, '../../etc/passwd', 'bw://a/b')).toThrow(/Invalid link name/);
    expect(() => writeCredentialLink(file, 'aquaman://github/token', 'bw://a/b')).toThrow(/Invalid link name/);
    expect(fs.existsSync(file)).toBe(false);

    // A directory that cannot be written to: the temp file cannot be created.
    const readOnly = path.join(dir, 'ro');
    fs.mkdirSync(readOnly, { mode: 0o500 });
    try {
      expect(() => writeCredentialLink(path.join(readOnly, 'config.yaml'), 'github/token', 'bw://a/b')).toThrow(/EACCES|EPERM/);
      expect(fs.readdirSync(readOnly)).toEqual([]);
    } finally {
      fs.chmodSync(readOnly, 0o700);
    }
  });

  it('a link source reads the file again when it changes, and links nothing once it is gone', () => {
    const source = createLinkSource(file);
    expect(source().size).toBe(0);
    writeCredentialLink(file, 'github/token', 'bw://GitHub/password');
    expect(source().get('github/token')).toBe('bw://GitHub/password');
    const first = source();
    expect(source()).toBe(first); // unchanged file: the same map, not read again
    writeCredentialLink(file, 'github/token', null);
    writeCredentialLink(file, 'github/token', 'bw://Other/password');
    expect(source().get('github/token')).toBe('bw://Other/password');
    fs.rmSync(file);
    expect(source().size).toBe(0);
  });

  it('findLinkProblems reports links the configured backend cannot read', () => {
    fs.writeFileSync(file, [
      'credentials:',
      '  links:',
      '    github/token: op://Private/GitHub/token',
      '    openai/api_key: bw://OpenAI/password',
      '    stripe/secret_key: op://Private/../x',
      '',
    ].join('\n'));
    const forOp = findLinkProblems('1password', file);
    expect(forOp.count).toBe(3);
    expect(forOp.problems.map((p) => p.name)).toEqual(['openai/api_key', 'stripe/secret_key']);
    expect(forOp.problems[0]).toMatchObject({
      locator: 'bw://OpenAI/password',
      error: expect.stringContaining('belongs to the bitwarden backend'),
      fix: 'Remove it with: aquaman credentials unlink openai/api_key',
    });
    expect(findLinkProblems('encrypted-file', file).problems).toHaveLength(3);
    expect(findLinkProblems('keychain', path.join(dir, 'absent.yaml'))).toEqual({ count: 0, problems: [] });
  });
});
