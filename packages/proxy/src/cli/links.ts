/**
 * `aquaman credentials link|unlink` and the link-aware parts of `add`,
 * `delete`, `list`, `doctor` and `request --from`.
 *
 * A link makes aquaman read a vault item it did not write, so making one is
 * a person's decision, and the decision is taken in the dialog the daemon
 * shows: `credentials link` asks the daemon exactly as `aquaman request
 * --from` does. A terminal is not taken as proof of a person, because a
 * program can give itself one. Only where the daemon reports that it cannot
 * show a dialog at all (a machine without a desktop session) does the command
 * ask at the terminal, and it then records the approval with its own access
 * to the vault.
 */

import type { Command } from 'commander';
import * as readline from 'node:readline';
import * as path from 'node:path';
import {
  getConfigPath,
  getConfigDir,
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

/** How the command reaches the daemon; the CLI's own helper is passed in. */
export type LinkProxyPost = (
  socketPath: string,
  urlPath: string,
  body: Record<string, unknown>,
  timeoutMs: number,
) => Promise<{ status: number; json: any } | { error: string; code: string }>;

/** Seconds the dialog waits when the person runs the command themselves. */
const LINK_DIALOG_SECONDS = 90;

function askYes(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    let answer = '';
    // Resolved when the input closes, so input that ends without an answer
    // (Ctrl-D) is a no and not a silent exit.
    rl.on('close', () => resolve(answer.trim().toLowerCase() === 'yes'));
    rl.question(question, (text) => {
      answer = text;
      rl.close();
    });
  });
}

export function registerLinkCommands(
  credentials: Command,
  openStore: (config: WrapperConfig) => Promise<CredentialStore>,
  proxyPost: LinkProxyPost,
): void {
  credentials
    .command('link <ref> <locator>')
    .description('Read a reference from an item that already exists in your vault. You approve it in a dialog; aquaman reads the item and never writes to it')
    .addHelpText('after', `
Locators, one form per backend:
  1password   op://<vault>/<item>/[<section>/]<field>
  bitwarden   bw://<item id or exact item name>/<field>
  vault       vault://<mount>/<path>#<field>
  keychain    keychain://<service>/<account>
  keepassxc   keepassxc://<Group/.../Entry title>[#<field>]
  keeper      keeper://<record UID>[/<field>]

The running daemon shows a dialog that names the item, and the link is made
when you allow it. The reference is linked and not declared: the proxy can add
the value to requests it forwards, and commands are given it only after
  aquaman broker allow <ref>
To link and declare in one step: aquaman request <ref> --from <locator>

Example:
  aquaman credentials link github/token 'op://Private/GitHub/token'`)
    .action(async (ref: string, locator: string) => {
      const target = parseLinkName(ref);
      if (!target) fail(`Invalid reference: ${ref}`, 'Write it as <service>/<key> or aquaman://<service>/<key>, e.g. github/token');
      const config = loadConfig();
      const parsed = parseLocatorFor(config.credentials.backend, locator);
      if (!parsed.ok) fail(parsed.error, parsed.fix);

      const done = () => {
        console.log(`Linked ${target.name} to ${locator}`);
        console.log('aquaman reads that item and never writes to it or deletes it.');
        console.log(`To let commands be given the value: aquaman broker allow aquaman://${target.name}`);
        console.log(`To remove the link: aquaman credentials unlink ${target.name}`);
      };

      console.error('Asking in a dialog on this machine. Look for it and allow the item if it is the one you mean.');
      const response = await proxyPost(
        path.join(getConfigDir(), 'proxy.sock'),
        '/broker/request',
        { service: target.service, key: target.key, from: locator, declare: false, project: process.cwd(), timeout_seconds: LINK_DIALOG_SECONDS },
        (LINK_DIALOG_SECONDS + 30) * 1000,
      );
      if ('error' in response) {
        if (response.code === 'proxy_unreachable') {
          fail('The daemon shows the dialog a link is approved in, and it is not running.', 'aquaman daemon &   (then run this command again)');
        }
        fail(`The daemon could not be asked: ${response.error}`, 'aquaman doctor');
      }
      const { status, json } = response;
      if (status !== 200) fail(json.error ?? `The daemon refused the request (${status})`, json.fix);
      if (json.status === 'linked' || json.status === 'ready') {
        done();
        return;
      }
      if (json.status === 'declined') {
        console.error(`Not linked: ${json.reason ?? 'declined'}`);
        process.exit(2);
      }
      if (json.code !== 'prompt_unavailable') {
        console.error(`Not linked: ${json.reason ?? 'nobody answered the dialog'}. Run the command again.`);
        process.exit(3);
      }

      // No dialog can be shown on this machine, so the question is put here.
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        fail(
          `No dialog can be shown on this machine (${json.reason}), and this command is not at a terminal, so nobody can be asked.`,
          `Run it yourself in a terminal: aquaman credentials link ${target.name} ${shellQuote(locator)}`,
        );
      }
      console.error(`No dialog can be shown on this machine (${json.reason}).`);
      console.error(`This makes aquaman read ${locator} from your vault whenever ${target.name} is used. aquaman does not change or delete the item.`);
      if (!(await askYes('Type yes to link it: '))) {
        console.error('Not linked.');
        process.exit(2);
      }
      let store: CredentialStore;
      try {
        store = await openStore(config);
      } catch (err) {
        fail(`Credential store not available: ${err instanceof Error ? err.message : String(err)}`, 'aquaman doctor');
      }
      const linker = createCredentialLinker({ store, backend: config.credentials.backend, configPath: getConfigPath() });
      const made = await linker.establish(target.service, target.key, locator);
      if (!made.ok) fail(made.error, made.fix);
      done();
    });

  credentials
    .command('unlink <ref>')
    .description('Remove a link and its approval. The vault item is not touched')
    .action(async (ref: string) => {
      const target = parseLinkName(ref);
      if (!target) fail(`Invalid reference: ${ref}`, 'Write it as <service>/<key> or aquaman://<service>/<key>, e.g. github/token');
      if (!writeCredentialLink(getConfigPath(), target.name, null)) {
        console.log(`Not linked: ${target.name}`);
        return;
      }
      console.log(`Unlinked ${target.name}. The vault item is unchanged.`);
      // The link is gone either way. The approval record is aquaman's own
      // item in the vault; if the vault cannot be opened from here it stays,
      // and does nothing without the link.
      try {
        const store = await openStore(loadConfig());
        await store.revokeLink?.(target.service, target.key);
      } catch (err) {
        console.error(`The approval record in the vault could not be updated (${err instanceof Error ? err.message : String(err)}). The link itself is removed.`);
      }
    });
}
