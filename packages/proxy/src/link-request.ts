/**
 * The part of `POST /broker/request` that is about links: a request that
 * carries `from`, the locator of an item that already exists in the vault.
 *
 * What happens before the dialog is decided here, and it reads config only.
 * The vault is not touched until a person has agreed, because an answer that
 * depended on the item would tell the caller which items exist.
 */

import type { CredentialLinker } from './core/credentials/linked-store.js';

export type LinkRequestPlan =
  | { ok: false; status: number; code: string; error: string; fix: string }
  /** The reference already points at this locator, so the request is an ordinary one. */
  | { ok: true; pending: false }
  /** A dialog is needed. `manual` is what a person runs when nobody could be asked. */
  | { ok: true; pending: true; locator: string; manual: string };

/** One argument for a POSIX shell, for the command a person is told to run. */
function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** `undefined` when the request has no `from`: it is not about a link. */
export async function linkRequestPlan(
  linker: CredentialLinker | undefined,
  service: string,
  key: string,
  from: unknown,
  routed: boolean,
  declares: boolean = true,
): Promise<LinkRequestPlan | undefined> {
  if (from === undefined) return undefined;
  if (!linker) {
    return {
      ok: false,
      status: 404,
      code: 'links_unavailable',
      error: 'This proxy does not make links to vault items',
      fix: 'Run: aquaman daemon',
    };
  }
  // The locator is shown to a person who decides by reading it. Letters from
  // other scripts can look like the ones they expect, so a request made
  // through the dialog names its item in printable ASCII. Every link is
  // approved in the dialog, so an item with another name is linked by its ID.
  if (typeof from === 'string' && !/^[\x20-\x7e]*$/.test(from)) {
    return {
      ok: false,
      status: 400,
      code: 'link_invalid_locator',
      error: 'Not a usable vault locator: it has characters outside printable ASCII, which a dialog cannot show unambiguously',
      fix: "Use the item's ID where the vault has one, or give the item a name in plain ASCII",
    };
  }
  const plan = linker.plan(service, key, from);
  if (!plan.ok) return { ...plan, status: plan.code === 'link_exists' ? 409 : 400 };
  // In place means in config.yaml and approved. A link that is only in the
  // file was put there without a person agreeing, and is asked about.
  if (plan.linked && await linker.approved(service, key, plan.locator)) return { ok: true, pending: false };
  const link = `aquaman credentials link ${service}/${key} ${shellQuote(plan.locator)}`;
  return {
    ok: true,
    pending: true,
    locator: plan.locator,
    manual: routed || !declares ? link : `${link} && aquaman broker allow aquaman://${service}/${key}`,
  };
}

/** The answer for a reference whose link is in config.yaml and reads nothing: the item is missing, or no person approved the link. */
export function linkUnreadableReply(service: string, key: string): { error: string; fix: string; code: string } {
  return {
    error: `${service}/${key} is linked to a vault item, and nothing could be read there`,
    fix: `Check the item in your vault. A link that no person approved is not read either; a person approves it with: aquaman credentials link ${service}/${key} <locator>. To stop using it, run: aquaman credentials unlink ${service}/${key}`,
    code: 'link_unreadable',
  };
}
