/**
 * The service name aquaman keeps for its own records in the credential store
 * (the audit anchor). Nothing a caller names may use it: not a reference, not
 * a stored credential, not a link. Close spellings are reserved with it so a
 * look-alike cannot stand in for it.
 */
export function isReservedService(service: unknown): boolean {
  return typeof service === 'string' && /^aquaman[._-]?internal$/i.test(service);
}
