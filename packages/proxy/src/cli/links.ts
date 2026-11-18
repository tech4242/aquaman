/**
 * `aquaman credentials link|unlink` and the link-aware parts of `add`,
 * `delete`, `list`, `doctor` and `request --from`.
 *
 * A link makes aquaman read a vault item it did not write, so making one is
 * a person's decision. `credentials link` therefore needs a terminal on stdin
 * and stdout; without one it points at `aquaman request --from`, where the
 * person decides in a dialog the daemon shows. This is a prompt against a
 * mistake, not a boundary: software running as the same user can edit
 * config.yaml directly.
 */

import type { Command } from 'commander';
import {
  getConfigPath,
  loadConfig,
  parseLinkName,
  parseLocatorFor,
  loadCredentialLinks,
  writeCredentialLink,
  findLinkProblems,
  createCredentialLinker,
  type CredentialStore,
  type WrapperConfig,
} from '../core/index.js';

/** One argument for a POSIX shell, for a command printed as a fix. */
function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function fail(error: string, fix?: string): never {
  console.error(error);
  if (fix) console.error(`Fix: ${fix}`);
  process.exit(1);
}

/**
 * Stop `credentials add` and `credentials delete` on a linked reference
 * before anything is typed or removed. The store refuses these too; this is
 * the same refusal with the fix, ahead of the prompt for a value.
 */
export function refuseIfLinked(service: string, key: string): void {
  const locator = loadCredentialLinks(getConfigPath()).links.get(`${service}/${key}`);
  if (locator === undefined) return;
  fail(
    `${service}/${key} is linked to ${locator}, an item aquaman did not create. aquaman does not write to it or delete it.`,
    `aquaman credentials unlink ${service}/${key}`,
  );
}

/** How `credentials list` shows one entry. */
export function listedCredential(cred: { service: string; key: string; linked?: string }): string {
  return cred.linked === undefined
    ? `${cred.service}/${cred.key}`
    : `${cred.service}/${cred.key}  (linked to ${cred.linked})`;
}

/**
 * The link lines of `aquaman doctor`: nothing without links, one line when
 * every link fits the configured backend, and a failed check with its fix
 * for each link that does not. Returns the number of failed checks.
 */
export function reportLinks(backend: WrapperConfig['credentials']['backend'], log: (line: string) => void = console.log): number {
  const { count, problems } = findLinkProblems(backend, getConfigPath());
  if (count === 0) return 0;
  if (problems.length === 0) {
    log(`    ✓ ${count} linked reference${count === 1 ? '' : 's'} (read from existing vault items)`);
    return 0;
  }
  for (const p of problems) {
    log(`    ✗ ${p.name} is linked to ${p.locator}: ${p.error}`);
    log(`      → ${p.fix}`);
  }
  return problems.length;
}

/**
 * Check `--from` for `aquaman request` before the daemon is asked: the same
 * syntax check the daemon makes, so a mistyped locator is a wrong command
 * and no dialog is shown for it. Reads config only.
 */
export function checkRequestLocator(locator: string): { ok: true } | { ok: false; error: string; fix: string; code: string } {
  const parsed = parseLocatorFor(loadConfig().credentials.backend, locator);
  return parsed.ok ? { ok: true } : { ok: false, error: parsed.error, fix: parsed.fix, code: parsed.code };
}

export function registerLinkCommands(
  credentials: Command,
  openStore: (config: WrapperConfig) => Promise<CredentialStore>,
): void {
  credentials
    .command('link <ref> <locator>')
    .description('Read a reference from an item that already exists in your vault. aquaman reads the item and never writes to it')
    .addHelpText('after', `
Locators, one form per backend:
  1password   op://<vault>/<item>/[<section>/]<field>
  bitwarden   bw://<item id or exact item name>/<field>
  vault       vault://<mount>/<path>#<field>
  keychain    keychain://<service>/<account>
  keepassxc   keepassxc://<Group/.../Entry title>[#<field>]
  keeper      keeper://<record UID>[/<field>]

Needs a terminal: a link is a person's decision. An agent asks with
  aquaman request <ref> --from <locator>
and the person decides in a dialog.

Example:
  aquaman credentials link github/token 'op://Private/GitHub/token'`)
    .action(async (ref: string, locator: string) => {
      const target = parseLinkName(ref);
      if (!target) fail(`Invalid reference: ${ref}`, 'Write it as <service>/<key> or aquaman://<service>/<key>, e.g. github/token');
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        fail(
          'A link makes aquaman read a vault item it did not write, so it is made by a person at a terminal.',
          `aquaman request aquaman://${target.name} --from ${shellQuote(locator)}   (the person decides in a dialog)`,
        );
      }
      const config = loadConfig();
      const parsed = parseLocatorFor(config.credentials.backend, locator);
      if (!parsed.ok) fail(parsed.error, parsed.fix);

      let store: CredentialStore;
      try {
        store = await openStore(config);
      } catch (err) {
        fail(`Credential store not available: ${err instanceof Error ? err.message : String(err)}`, 'aquaman doctor');
      }
      const linker = createCredentialLinker({ store, backend: config.credentials.backend, configPath: getConfigPath() });
      const made = await linker.establish(target.service, target.key, locator);
      if (!made.ok) fail(made.error, made.fix);

      console.log(`Linked ${target.name} to ${locator}`);
      console.log('aquaman reads that item and never writes to it or deletes it.');
      console.log(`To let commands be given the value: aquaman broker allow aquaman://${target.name}`);
      console.log(`To remove the link: aquaman credentials unlink ${target.name}`);
    });

  credentials
    .command('unlink <ref>')
    .description('Remove a link. The vault item is not touched')
    .action((ref: string) => {
      const target = parseLinkName(ref);
      if (!target) fail(`Invalid reference: ${ref}`, 'Write it as <service>/<key> or aquaman://<service>/<key>, e.g. github/token');
      if (writeCredentialLink(getConfigPath(), target.name, null)) {
        console.log(`Unlinked ${target.name}. The vault item is unchanged.`);
      } else {
        console.log(`Not linked: ${target.name}`);
      }
    });
}
