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
export function linkRequestPlan(
  linker: CredentialLinker | undefined,
  service: string,
  key: string,
  from: unknown,
  routed: boolean,
): LinkRequestPlan | undefined {
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
  const plan = linker.plan(service, key, from);
  if (!plan.ok) return { ...plan, status: plan.code === 'link_exists' ? 409 : 400 };
  if (plan.linked) return { ok: true, pending: false };
  const link = `aquaman credentials link ${service}/${key} ${shellQuote(plan.locator)}`;
  return {
    ok: true,
    pending: true,
    locator: plan.locator,
    manual: routed ? link : `${link} && aquaman broker allow aquaman://${service}/${key}`,
  };
}

/** The answer for a reference whose link is in place but whose item cannot be read. */
export function linkUnreadableReply(service: string, key: string): { error: string; fix: string; code: string } {
  return {
    error: `${service}/${key} is linked to a vault item, and nothing could be read there`,
    fix: `Check the item in your vault. To stop using it, run: aquaman credentials unlink ${service}/${key}`,
    code: 'link_unreadable',
  };
}
