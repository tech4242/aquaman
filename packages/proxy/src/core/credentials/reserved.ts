/**
 * The service name aquaman keeps for its own records in the credential store
 * (the audit anchor). Nothing a caller names may use it: not a reference, not
 * a stored credential, not a link. Close spellings are reserved with it so a
 * look-alike cannot stand in for it.
 */
/** The reserved service as aquaman writes it. Underscores, because some backends split item names on hyphens. */
export const RESERVED_SERVICE = 'aquaman_internal';

/** Under the reserved service: which links to existing vault items a person approved. */
export const LINK_APPROVALS_KEY = 'link_approvals';

/**
 * Under the reserved service: which references are handed out only after a
 * person allowed it in the daemon's dialog (ask-first.ts).
 */
export const ASK_FIRST_KEY = 'ask_first';

export function isReservedService(service: unknown): boolean {
  return typeof service === 'string' && /^aquaman[._-]?internal$/i.test(service);
}
